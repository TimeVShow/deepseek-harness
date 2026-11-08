/**
 * Browser data layer for the Agent Flow panel: one snapshot store over the
 * `agentFlows` Remote namespace plus the panel's own selection state and the
 * run-progress poll.
 * @module
 */

import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-experimental-agent-flow/remote'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { NodeObservation } from './activity-tracker.ts'
import type {
  AgentTemplate,
  AgentTemplateDraft,
  FlowDraft,
  FlowDocument,
  FlowId,
  FlowNodeRun,
  FlowRun,
  FlowRunId,
} from '@deepseek-ai/dsh-experimental-agent-flow/types'
import { executionSuccessors, latestEntryByNode, nodeDisplayName, relatedRuns } from './run-view.ts'

/** Panel tabs. */
export type AgentFlowView = 'agents' | 'flows' | 'runs'

/** One session the run view can target. */
export interface SessionChoice {
  readonly id: SessionId
  /** Whether this session currently owns a live Agent. */
  readonly live: boolean
  /** Workspace root produced files are relative to, when known. */
  readonly cwd?: string | undefined
}

/** One selectable model in the system's configured catalog. */
export interface ModelChoice {
  /** Provider route serving this model. */
  readonly provider: string
  readonly model: string
  readonly label: string
}

/** One provider and the models it currently serves, in catalog order. */
export interface ModelGroupChoice {
  readonly provider: string
  readonly providerLabel: string
  readonly models: readonly ModelChoice[]
}

/** Everything the panel renders, in one observable snapshot. */
export interface AgentFlowSnapshot {
  /** `loading` until the first read settles; `error` keeps the last good lists. */
  status: 'loading' | 'ready' | 'error'
  /** Failure detail for `error`. */
  error?: string | undefined
  flows: FlowDocument[]
  templates: AgentTemplate[]
  runs: FlowRun[]
  /** Sessions this client knows, newest first. */
  sessions: SessionChoice[]
  /** Provider groups the system's model catalog reports. */
  modelGroups: ModelGroupChoice[]
  view: AgentFlowView
  /** Flow opened in the canvas, when one is selected. */
  selectedFlowId?: FlowId | undefined
  /** Run opened as a chat record, when one is selected. */
  selectedRunId?: FlowRunId | undefined
  /** Draft the canvas edits; saved back through `saveFlow`. */
  draft?: FlowDocument | undefined
  /** Epoch ms of the last successful full read; absent before one lands. */
  lastSyncedAt?: number | undefined
  /**
   * Failure detail of the most recent read while older lists stay published.
   * Progress surfaces show their data as last-known while this is set, and a
   * later successful read clears it.
   */
  syncError?: string | undefined
  /**
   * Live activity of the node Sessions this client observes, by session id.
   * Progress surfaces read a node's phase and business time from here; the
   * entry carries no message text, so a long stream never grows this record.
   */
  nodeActivity: Record<string, NodeObservation>
}

/** Why one concluded conversational session's composer stays inert. */
export interface FlowLockReason {
  /**
   * Execution successors the flow moved on to, with whether one is live right
   * now; empty when the graph has no execution successor.
   */
  readonly successors: readonly { readonly name: string; readonly live: boolean }[]
  /** Run status at lock time, for the settled wording. */
  readonly runStatus: FlowRun['status']
}

const POLL_MS = 1500

/** Remote namespaces the controller reads; narrower than the full Client assembly. */
export type AgentFlowRemote = Pick<ClientRemote, 'agentFlows'> & {
  readonly session: Pick<ClientRemote['session'], 'list' | 'modelCatalog'>
}

/** Node statuses that mean an execution will not resume. */
const TERMINAL: ReadonlySet<FlowNodeRun['status']> = new Set(['succeeded', 'failed', 'skipped'])

/** Run statuses a later refresh must not regress to `running`. */
const RUN_TERMINAL: ReadonlySet<FlowRun['status']> = new Set(['completed', 'failed', 'cancelled'])

/** Panel controller: Remote calls, polling, and the observable it publishes. */
export class AgentFlowController {
  /** Observable snapshot the panel binds through the inject `hooks` compartment. */
  readonly state = createSnapshotStore<AgentFlowSnapshot>({
    status: 'loading',
    flows: [],
    templates: [],
    runs: [],
    sessions: [],
    modelGroups: [],
    view: 'agents',
    nodeActivity: {},
  })

  private poll: ReturnType<typeof setInterval> | undefined
  private disposed = false
  /** Latest refresh generation; only the newest may commit its snapshot. */
  private loadSeq = 0
  /** Every refresh in flight, including manual ones that overlap polling. */
  private inFlight = 0
  /** A poll tick arrived while a refresh was in flight. */
  private pollQueued = false
  /**
   * Runs this client started that no refresh response has reported yet. A
   * refresh racing the start call must merge these rather than erase them.
   */
  private readonly pendingStarts = new Map<FlowRunId, FlowRun>()
  /** Runs this client started and has not yet followed into their conversation. */
  private readonly pendingNavigation = new Set<FlowRunId>()

  /**
   * @param remote - generated `agentFlows` Remote plus the session reads this panel needs.
   * @param navigate - opens one session in the workspace, for the run this client started.
   * @param lock - makes one session's composer inert with this plugin's reason.
   */
  constructor(
    private readonly remote: AgentFlowRemote,
    private readonly navigate: (sessionId: SessionId) => void,
    private readonly lock: (sessionId: SessionId, reason: FlowLockReason) => void,
  ) {}

  /**
   * Read every list; a failure keeps the previous lists and records the message.
   * Only the newest refresh may commit, and its run list merges starts this
   * client confirmed while the response was in flight.
   */
  async load(): Promise<void> {
    this.inFlight += 1
    const seq = ++this.loadSeq
    try {
      const flows = unwrap(await this.remote.agentFlows.listFlows())
      const templates = unwrap(await this.remote.agentFlows.listTemplates())
      const runs = unwrap(await this.remote.agentFlows.listRuns())
      const sessions = unwrap(await this.remote.session.list({}))
      const catalog = unwrap(await this.remote.session.modelCatalog())
      if (this.disposed || seq !== this.loadSeq) return
      const merged = this.mergeRuns(runs)
      this.state.update((current) => {
        current.status = 'ready'
        current.error = undefined
        current.flows = flows
        current.templates = templates
        current.runs = merged
        current.sessions = sessions.items.map(item => ({ id: item.sessionId, live: item.agentAvailable, cwd: item.cwd }))
        current.modelGroups = catalog.groups.map(group => ({
          provider: group.id,
          providerLabel: group.name,
          models: group.models.map(model => ({ provider: group.id, model: model.id, label: model.name })),
        }))
        current.lastSyncedAt = Date.now()
        current.syncError = undefined
      })
      for (const run of runs) this.pendingStarts.delete(run.id)
      this.autoNavigate(merged)
      this.lockConcluded(merged, templates)
      this.pruneActivity(merged)
      this.syncPolling()
    } catch (error) {
      if (this.disposed || seq !== this.loadSeq) return
      this.state.update((current) => {
        current.status = 'error'
        current.error = messageOf(error)
        /* The lists stay published; progress surfaces mark them last-known. */
        current.syncError = messageOf(error)
      })
    } finally {
      this.inFlight -= 1
      /* Only the last in-flight refresh may release the poll gate; an older
         call finishing must not make an overlapping refresh look idle. */
      if (this.inFlight > 0) return
      const queued = this.pollQueued
      this.pollQueued = false
      if (queued && !this.disposed && this.poll !== undefined) void this.load()
    }
  }

  /**
   * Combine one refresh's runs with local starts it may not have observed and
   * with terminal facts already published, so a stale response cannot erase a
   * newer start or move a settled run back to running.
   * @param incoming - run list the newest refresh read.
   * @returns the runs to publish, newest first.
   */
  private mergeRuns(incoming: readonly FlowRun[]): FlowRun[] {
    const merged = new Map(incoming.map(run => [run.id, run]))
    for (const [id, run] of this.pendingStarts) if (!merged.has(id)) merged.set(id, run)
    for (const previous of this.state.getSnapshot().runs) {
      const next = merged.get(previous.id)
      if (next !== undefined && RUN_TERMINAL.has(previous.status) && next.status === 'running') merged.set(previous.id, previous)
    }
    return [...merged.values()].sort((left, right) =>
      right.startedAt.localeCompare(left.startedAt) || String(left.id).localeCompare(String(right.id)))
  }

  /**
   * Publish one node Session's live activity. The observer throttles, so a
   * streamed answer publishes its phase changes rather than every chunk.
   * @param sessionId - Session the observation belongs to.
   * @param observation - stage, business time, open tools, and live state.
   */
  noteActivity(sessionId: SessionId, observation: NodeObservation): void {
    this.state.update((current) => {
      current.nodeActivity = { ...current.nodeActivity, [String(sessionId)]: observation }
    })
  }

  /**
   * Drop observations no retained run can address any more, so a long-lived
   * client does not accumulate one entry per node Session it ever observed.
   * @param runs - the roster just read.
   */
  private pruneActivity(runs: readonly FlowRun[]): void {
    const referenced = new Set<string>()
    for (const run of runs) {
      for (const entry of run.nodeRuns) {
        if (entry.agentSessionId !== undefined) referenced.add(String(entry.agentSessionId))
      }
    }
    const current = this.state.getSnapshot().nodeActivity
    const kept = Object.entries(current).filter(([id]) => referenced.has(id))
    if (kept.length === Object.keys(current).length) return
    this.state.update((snapshot) => { snapshot.nodeActivity = Object.fromEntries(kept) })
  }

  /**
   * Make every concluded conversation's composer inert. The block is derived
   * from the durable run roster rather than held in memory, so it survives a
   * reload; the registry ignores a reason it already raised, and a changed
   * successor state rewrites it.
   * @param runs - run roster just published.
   * @param templates - template roster the successor names resolve against.
   */
  private lockConcluded(runs: readonly FlowRun[], templates: readonly AgentTemplate[]): void {
    for (const run of runs) {
      const conversational = run.snapshot.nodes.find(node => node.kind === 'agent' && node.interactive === true)
      if (conversational === undefined) continue
      const latest = latestEntryByNode(run)
      /* Structural successors (the end node) are not work the flow hands to,
         so the message names none of them and reads as settled. */
      const namesWork = (nodeId: string): boolean => {
        const kind = run.snapshot.nodes.find(node => node.id === nodeId)?.kind
        return kind === 'agent' || kind === 'join' || kind === 'condition'
      }
      for (const entry of run.nodeRuns) {
        if (entry.nodeId !== conversational.id) continue
        if (entry.agentSessionId === undefined || !TERMINAL.has(entry.status)) continue
        this.lock(entry.agentSessionId, {
          runStatus: run.status,
          successors: executionSuccessors(run, conversational.id)
            .filter(namesWork)
            .map((nodeId) => {
              const successor = latest.get(nodeId)
              return {
                name: nodeDisplayName(run, nodeId, templates) ?? nodeId,
                live: successor?.status === 'running' || successor?.status === 'conversing',
              }
            }),
        })
      }
    }
  }

  /**
   * Follow one started run into its conversational node as soon as that node's
   * session exists. Only runs this client started are followed, so loading the
   * panel never moves the user into a conversation they did not begin.
   */
  private autoNavigate(runs: readonly FlowRun[]): void {
    for (const run of runs) {
      if (!this.pendingNavigation.has(run.id)) continue
      const conversational = run.snapshot.nodes.find(node => node.kind === 'agent' && node.interactive === true)
      if (run.status === 'running' && conversational !== undefined) {
        const session = run.nodeRuns
          .filter(entry => entry.nodeId === conversational.id)
          .map(entry => entry.agentSessionId)
          .findLast((id): id is SessionId => id !== undefined)
        /* Its node has not materialized a session yet, so the next poll decides. */
        if (session === undefined) continue
        this.pendingNavigation.delete(run.id)
        this.navigate(session)
        continue
      }
      /* Settled, or no conversational node: there is no conversation to join. */
      this.pendingNavigation.delete(run.id)
    }
  }

  /**
   * Select one tab.
   * @param view - tab to show.
   */
  setView(view: AgentFlowView): void {
    this.state.update((current) => { current.view = view })
  }

  /**
   * Open one flow in the canvas, copying it into the editable draft.
   * @param id - flow to open, or undefined to return to the list.
   */
  selectFlow(id: FlowId | undefined): void {
    const flow = this.state.getSnapshot().flows.find(candidate => candidate.id === id)
    this.state.update((current) => {
      current.selectedFlowId = id
      current.draft = flow === undefined ? undefined : structuredClone(flow)
    })
  }

  /**
   * Apply one edit to the draft under the canvas.
   * @param mutate - in-place edit of the stored draft.
   */
  updateDraft(mutate: (draft: FlowDocument) => void): void {
    this.state.update((current) => {
      if (current.draft === undefined) return
      mutate(current.draft)
    })
  }

  /**
   * Create one starter flow with a neutral entry agent wired between start and
   * end. The entry role and graph are chosen in the canvas afterward; a shared
   * Starter template is created only when none exists.
   */
  async createFlow(): Promise<void> {
    const templates = this.state.getSnapshot().templates
    let template = templates.find(candidate => candidate.name === 'Starter agent')
    if (template === undefined) {
      template = await this.saveTemplate({ name: 'Starter agent', persona: 'You complete one step of a fixed workflow.' })
    }
    const saved = await this.saveFlow({
      name: 'Untitled flow',
      nodes: [
        { kind: 'start', id: 'start' },
        { kind: 'agent', id: 'step', templateId: template.id, instruction: 'Complete this step.' },
        { kind: 'end', id: 'end' },
      ],
      edges: [
        { kind: 'execution', from: 'start', to: 'step' },
        { kind: 'execution', from: 'step', to: 'end' },
      ],
    })
    this.selectFlow(saved.id)
  }

  /**
   * Persist one flow draft and refresh the lists.
   * @param draft - document to save; an absent id creates one.
   * @returns the stored document.
   */
  async saveFlow(draft: FlowDraft): Promise<FlowDocument> {
    const nameAtStart = this.state.getSnapshot().draft?.name
    const saved = unwrap(await this.remote.agentFlows.saveFlow(draft))
    this.state.update((current) => {
      const currentDraft = current.draft
      /* Only the document this save targeted; a switch or delete during the
         call must not adopt another flow's identity. */
      if (draft.id === undefined || currentDraft === undefined || currentDraft.id !== draft.id) return
      current.draft = {
        ...currentDraft,
        id: saved.id,
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt,
        /* A rename typed while saving wins over the submitted response. */
        ...currentDraft.name === nameAtStart ? { name: saved.name } : {},
      }
    })
    await this.load()
    return saved
  }

  /**
   * Delete one flow and clear a selection that pointed at it.
   * @param id - flow identity.
   */
  async deleteFlow(id: FlowId): Promise<void> {
    unwrap(await this.remote.agentFlows.deleteFlow(id))
    if (this.state.getSnapshot().selectedFlowId === id) this.selectFlow(undefined)
    await this.load()
  }

  /**
   * Persist one template and refresh the lists.
   * @param draft - template to save; an absent id creates one.
   * @returns the stored template.
   */
  async saveTemplate(draft: AgentTemplateDraft): Promise<AgentTemplate> {
    const saved = unwrap(await this.remote.agentFlows.saveTemplate(draft))
    await this.load()
    return saved
  }

  /**
   * Delete one template and refresh the lists.
   * @param id - template identity.
   */
  async deleteTemplate(id: AgentTemplate['id']): Promise<void> {
    unwrap(await this.remote.agentFlows.deleteTemplate(id))
    await this.load()
  }

  /**
   * Open one run as a chat record, or return to the run list.
   * @param id - run to open, or undefined for the list.
   */
  selectRun(id: FlowRunId | undefined): void {
    this.state.update((current) => { current.selectedRunId = id })
  }

  /**
   * Resolve the workspace root of one known session.
   * @param id - session the run is parented to.
   * @returns its workspace root, or undefined when the session is unknown.
   */
  cwdOf(id: SessionId): string | undefined {
    return this.state.getSnapshot().sessions.find(session => session.id === id)?.cwd
  }

  /**
   * List the runs one session can address: the run it started and runs whose
   * node executions materialized inside it, in-flight first and otherwise
   * newest first. Progress surfaces bind sessions to runs through this, so a
   * conversational node's session keeps its run after the node concluded.
   * @param sessionId - session to match.
   * @returns the matching runs.
   */
  runsForSession(sessionId: SessionId): FlowRun[] {
    return relatedRuns(this.state.getSnapshot().runs, sessionId)
  }

  /**
   * Cancel one in-flight run and refresh.
   * @param sessionId - session that started the run.
   * @param runId - run identity.
   */
  async cancelRun(sessionId: SessionId, runId: FlowRunId): Promise<void> {
    unwrap(await this.remote.agentFlows.cancel(sessionId, runId))
    await this.load()
  }

  /**
   * End one in-flight run's clarification, so its conversational node stops
   * asking and states its Result word; the run keeps executing.
   * @param sessionId - session that started the run.
   * @param runId - run identity.
   */
  async concludeConversation(sessionId: SessionId, runId: FlowRunId): Promise<void> {
    unwrap(await this.remote.agentFlows.concludeConversation(sessionId, runId))
    await this.load()
  }

  /**
   * Fold one freshly started run into the store, arm the poll right away, and
   * mark it for navigation into its conversational node: the composer
   * selector's in-flight indicator must not wait a poll tick.
   * @param run - the run the start call returned.
   */
  noteStarted(run: FlowRun): void {
    this.pendingStarts.set(run.id, run)
    this.state.update((current) => {
      current.runs = [run, ...current.runs.filter(candidate => candidate.id !== run.id)]
    })
    this.pendingNavigation.add(run.id)
    this.syncPolling()
  }

  /** Poll while any run is in flight, and stop when none is. */
  private syncPolling(): void {
    const running = this.state.getSnapshot().runs.some(run => run.status === 'running')
    if (running && this.poll === undefined) {
      this.poll = setInterval(() => {
        if (this.inFlight > 0) {
          this.pollQueued = true
          return
        }
        void this.load()
      }, POLL_MS)
      return
    }
    if (!running && this.poll !== undefined) {
      clearInterval(this.poll)
      this.poll = undefined
    }
  }

  /** Stop polling and reject later updates. */
  dispose(): void {
    this.disposed = true
    this.pollQueued = false
    if (this.poll !== undefined) clearInterval(this.poll)
    this.poll = undefined
  }
}

/**
 * Read one Remote call's value, turning a failed result into a thrown error.
 * @param result - the call's result branch.
 * @returns the value of a successful call.
 */
function unwrap<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw result.error
  return result.value
}

/** Surface one thrown value's message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
