/**
 * Live activity tracking for the node Sessions one run drives. The tracker
 * retains exactly the Sessions of active node executions, folds their ordered
 * event feeds into {@link NodeActivity}, and publishes stage-only snapshots to
 * the panel store. It holds no reasoning text: the Session view that owns the
 * transcript remains the only place reasoning is rendered, and releasing a
 * settled node stops its traffic.
 * @module
 */

import type {
  SessionEventSource, SessionEventWindow, SessionRetainOptions, SessionSnapshot, SessionTarget,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FlowRun } from '@deepseek-ai/dsh-experimental-agent-flow/types'
import { NodeActivityFold, type NodeActivity, type LiveSessionState } from './activity.ts'

/** One node Session's activity plus the live state the waiting decision needs. */
export interface NodeObservation extends NodeActivity, LiveSessionState {}

/** The retained Session the tracker reads: its ordered feed, its snapshot, and release. */
export interface ObservedSessionReference {
  readonly binding: {
    readonly session: ObservableSnapshot<SessionSnapshot>
    readonly eventSource: SessionEventSource
  }
  release(): void
}

/**
 * Session acquisition the tracker needs. The client's `ISessions` satisfies it;
 * naming only `retain` keeps the tracker's dependency and its test doubles the
 * shape it actually reads.
 */
export interface SessionObservationSource {
  retain(target: SessionTarget, options: SessionRetainOptions): ObservedSessionReference
}

/** The UI status facts this tracker reads; independent of the Session event feed. */
export interface SessionStatusSource {
  getSnapshot(): SessionStatusSnapshot
  subscribe(listener: () => void): () => void
}

/** How far the business clock must advance before another render is worth it. */
const PUBLISH_STEP_MS = 1_000

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** Retained observation of one node Session's live activity. */
    agentFlowActivity: unknown
  }
}

/** One retained node Session's live observation. */
interface Observed {
  readonly reference: ObservedSessionReference
  readonly stop: () => void
}

/** The open tool calls in call order, as one comparable key. */
function toolKey(observation: NodeObservation): string {
  return observation.tools.map(tool => tool.callId).join('\u0000')
}

/**
 * Whether one observation changes what a surface would render: the phase, the
 * open tools, the user-facing live state, or a full publishing step of age.
 * @param previous - observation already published.
 * @param next - observation just folded.
 * @returns true when publishing again is worth a render.
 */
function worthPublishing(previous: NodeObservation, next: NodeObservation): boolean {
  if (previous.stage !== next.stage) return true
  if (previous.running !== next.running) return true
  if (previous.pendingSubmissions !== next.pendingSubmissions) return true
  if (previous.pendingInteraction !== next.pendingInteraction) return true
  if (previous.streamFailed !== next.streamFailed) return true
  if (toolKey(previous) !== toolKey(next)) return true
  /* An absent business time publishes on its first arrival; afterwards a full
     step of new signal is worth a render. */
  return (next.lastAt ?? 0) - (previous.lastAt ?? 0) >= PUBLISH_STEP_MS
}

/** Node statuses whose Session still has work worth observing. */
const ACTIVE: ReadonlySet<string> = new Set(['running', 'conversing'])

/**
 * Keep one activity snapshot per active node Session. The tracker reconciles
 * on every run roster change: a newly active node is retained and folded, a
 * node that settled or whose run settled is released, so background observation
 * never outlives the work it describes.
 */
export class NodeActivityTracker {
  private readonly observed = new Map<SessionId, Observed>()
  private readonly published = new Map<SessionId, NodeObservation>()

  /**
   * @param sessions - client Session service that owns retain/release.
   * @param status - unified Session UI status: running, pending interaction,
   *   and the answer owed to the user. Absent facts fall back to the Session
   *   snapshot, so a client without that service still reads a phase.
   * @param publish - receives every new snapshot for one Session.
   */
  constructor(
    private readonly sessions: SessionObservationSource,
    private readonly status: SessionStatusSource,
    private readonly publish: (sessionId: SessionId, observation: NodeObservation) => void,
  ) {}

  /**
   * Reconcile retained Sessions with one run roster.
   * @param runs - the roster just read from the Host.
   */
  sync(runs: readonly FlowRun[]): void {
    const active = new Set<SessionId>()
    for (const run of runs) {
      if (run.status !== 'running') continue
      for (const entry of run.nodeRuns) {
        if (entry.agentSessionId !== undefined && ACTIVE.has(entry.status)) active.add(entry.agentSessionId)
      }
    }
    for (const [sessionId, observed] of [...this.observed]) {
      if (active.has(sessionId)) continue
      this.release(sessionId, observed)
    }
    for (const sessionId of active) {
      if (this.observed.has(sessionId)) continue
      this.observe(sessionId)
    }
  }

  /** Release every retained Session; the panel is going away or reloaded. */
  dispose(): void {
    for (const [sessionId, observed] of [...this.observed]) this.release(sessionId, observed)
  }

  /** Retain one Session and fold its feed as it arrives. */
  private observe(sessionId: SessionId): void {
    let reference: ObservedSessionReference
    try {
      reference = this.sessions.retain(sessionId, { source: 'agentFlowActivity' })
    } catch {
      /* The client catalog has not listed this node Session yet, or its open
         failed synchronously; the next roster read retries the retain, so the
         node reads its recorded status until then. */
      return
    }
    const source = reference.binding.eventSource
    /* The fold follows the window's own deltas rather than a raw index: a
       settled attempt removes its transient rows, a reconnect replaces the
       window, and history paging prepends to it, so an index would either skip
       new events or replay old ones. */
    let fold = new NodeActivityFold()
    let revision = -1
    const rebuild = (snapshot: SessionEventWindow): void => {
      fold = new NodeActivityFold()
      for (const entry of snapshot.entries) fold.push(entry.event)
      revision = snapshot.revision
    }
    const consume = (): void => {
      const snapshot = source.getSnapshot()
      if (revision < 0) {
        rebuild(snapshot)
        return
      }
      /* A status or Session change does not advance the feed. */
      if (snapshot.revision === revision) return
      /* A gap cannot occur while this tracker stays subscribed: the source
         publishes every change synchronously. Rebuilding the whole window is
         the only safe answer if that ever changes. */
      /* v8 ignore next 3 */
      if (snapshot.revision !== revision + 1) {
        rebuild(snapshot)
        return
      }
      revision = snapshot.revision
      switch (snapshot.change.kind) {
        case 'append':
          for (const entry of snapshot.change.entries) fold.push(entry.event)
          return
        case 'settle-assistant':
          /* The transient rows left; the durable settlement is the new fact. */
          if (snapshot.change.entry !== undefined) fold.push(snapshot.change.entry.event)
          return
        case 'prepend':
          /* Older history is not new business activity. */
          return
        case 'replace':
          rebuild(snapshot)
          return
      }
    }
    const publishIfChanged = (): void => {
      consume()
      const snapshot = reference.binding.session.getSnapshot()
      const status = this.status.getSnapshot().get(sessionId)
      const activity = fold.activity()
      const observation: NodeObservation = {
        ...activity,
        running: status?.running ?? snapshot.running,
        pendingSubmissions: snapshot.pendingSubmissions.length,
        pendingInteraction: status?.pendingInteraction !== undefined,
        /* A failed history/follow stream leaves the last known activity in
           place; the surface must say the stream is gone, not read that
           silence as business quiet. */
        streamFailed: snapshot.openState === 'error',
      }
      const previous = this.published.get(sessionId)
      /* A reasoning stream publishes a chunk dozens of times a second; the card
         only needs the phase and a fresh-enough age, so throttle on change. */
      if (previous !== undefined && !worthPublishing(previous, observation)) return
      this.published.set(sessionId, observation)
      this.publish(sessionId, observation)
    }
    /* Pending interaction, running, pending submissions, and the stream's own
       open state are facts outside the event feed, so a prompt appearing, a
       submission leaving, or a stream failing must re-read them. */
    const stopStatus = this.status.subscribe(() => { publishIfChanged() })
    const stopSession = reference.binding.session.subscribe(() => { publishIfChanged() })
    const stopFeed = source.subscribe(() => { publishIfChanged() })
    this.observed.set(sessionId, { reference, stop: () => { stopFeed(); stopSession(); stopStatus() } })
    publishIfChanged()
  }

  /** Stop folding one Session and release its reference. */
  private release(sessionId: SessionId, observed: Observed): void {
    this.observed.delete(sessionId)
    this.published.delete(sessionId)
    observed.stop()
    observed.reference.release()
  }
}
