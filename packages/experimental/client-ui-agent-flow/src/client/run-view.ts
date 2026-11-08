/**
 * Pure projection from persisted run records to the progress surfaces: which
 * runs involve one session, how each node execution reads right now, and how
 * long a run has been quiet. Everything here derives from the durable run
 * roster — no scheduler, stream, or provider facts are invented, so a state
 * the record cannot prove renders as its recorded state, never a guess.
 * @module
 */

import type { FlowNodeRun, FlowRun } from '@deepseek-ai/dsh-experimental-agent-flow/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Node statuses whose execution has finished and will not resume. */
const SETTLED: ReadonlySet<FlowNodeRun['status']> = new Set(['succeeded', 'failed', 'skipped'])

/**
 * Whether one run involves one session: the session started the run, or the
 * run materialized one of its node executions inside that session. This is
 * the run↔session association for every progress surface, so a conversational
 * node's session keeps seeing its run after the node concluded.
 * @param run - run record to test.
 * @param sessionId - session to match against the run's parent and node sessions.
 * @returns true when the session can address this run.
 */
export function runInvolvesSession(run: FlowRun, sessionId: SessionId): boolean {
  return run.parentSessionId === sessionId
    || run.nodeRuns.some(entry => entry.agentSessionId === sessionId)
}

/**
 * List the runs one session can address, runs in flight first and otherwise
 * newest first, so a surface that must pick one run deterministically picks
 * the live one and never a random roster order.
 * @param runs - run roster to filter.
 * @param sessionId - session the runs must involve.
 * @returns the matching runs, in-flight first.
 */
export function relatedRuns(runs: readonly FlowRun[], sessionId: SessionId): FlowRun[] {
  return runs
    .filter(run => runInvolvesSession(run, sessionId))
    .sort((left, right) => {
      const liveLeft = left.status === 'running' ? 0 : 1
      const liveRight = right.status === 'running' ? 0 : 1
      return liveLeft - liveRight || right.startedAt.localeCompare(left.startedAt)
    })
}

/**
 * Read each node's current execution: node entries append per iteration, so
 * the last entry per node is the live one.
 * @param run - run to index.
 * @returns one latest entry per node id that has executed at least once.
 */
export function latestEntryByNode(run: FlowRun): Map<string, FlowNodeRun> {
  const latest = new Map<string, FlowNodeRun>()
  for (const entry of run.nodeRuns) latest.set(entry.nodeId, entry)
  return latest
}

/**
 * List the execution successors of one node — the work the flow hands off to
 * when it concludes.
 * @param run - run whose graph the edges come from.
 * @param nodeId - node whose outgoing execution edges are read.
 * @returns distinct successor ids in edge order.
 */
export function executionSuccessors(run: FlowRun, nodeId: string): string[] {
  const successors: string[] = []
  for (const edge of run.snapshot.edges) {
    if (edge.kind !== 'execution' || edge.from !== nodeId) continue
    if (!successors.includes(edge.to)) successors.push(edge.to)
  }
  return successors
}

/**
 * List the execution predecessors of one node. Input edges never wait and
 * never start, so they are not scheduling dependencies here.
 * @param run - run whose graph the edges come from.
 * @param nodeId - node whose execution edges are read.
 * @returns distinct predecessor ids in edge order.
 */
export function executionPredecessors(run: FlowRun, nodeId: string): string[] {
  const predecessors: string[] = []
  for (const edge of run.snapshot.edges) {
    if (edge.kind !== 'execution' || edge.to !== nodeId) continue
    if (!predecessors.includes(edge.from)) predecessors.push(edge.from)
  }
  return predecessors
}

/**
 * Whether one node can reach another through execution edges — the loop
 * detector behind rework-trigger exclusion.
 * @param run - run whose graph is walked.
 * @param from - node the walk starts at.
 * @param to - node the walk looks for.
 * @returns true when `to` is reachable from `from` (including trivially).
 */
function reaches(run: FlowRun, from: string, to: string): boolean {
  if (from === to) return true
  const visited = new Set<string>([from])
  const queue = [from]
  while (queue.length > 0) {
    const current = queue.pop()
    /* v8 ignore next 2 -- queue.length > 0 guarantees pop() returns a node. */
    if (current === undefined) break
    for (const edge of run.snapshot.edges) {
      if (edge.kind !== 'execution' || edge.from !== current) continue
      if (edge.to === to) return true
      if (!visited.has(edge.to)) {
        visited.add(edge.to)
        queue.push(edge.to)
      }
    }
  }
  return false
}

/**
 * List the execution predecessors of one node that have not settled their
 * latest execution. A skipped branch left its wait set, so it does not hold
 * the target; a failed one settled and the run's own failure surfaces it. A
 * node that has never executed does not wait on its rework trigger — the
 * condition edge that routes a later round back into it — because the first
 * entry passes that edge only when the review routes back.
 * @param run - run to read.
 * @param nodeId - node whose wait set is resolved.
 * @returns predecessor ids whose latest entry is still pending, running, or conversing.
 */
export function unmetPredecessors(run: FlowRun, nodeId: string): string[] {
  const latest = latestEntryByNode(run)
  const started = run.nodeRuns.some(entry => entry.nodeId === nodeId && entry.status !== 'pending')
  return executionPredecessors(run, nodeId).filter((predecessor) => {
    const entry = latest.get(predecessor)
    if (entry !== undefined && SETTLED.has(entry.status)) return false
    if (started) return true
    const kind = run.snapshot.nodes.find(node => node.id === predecessor)?.kind
    return !(kind === 'condition' && reaches(run, nodeId, predecessor))
  })
}

/** How one node execution reads on the progress surface. */
export type RunNodeDisplay =
  | 'running'
  | 'conversing'
  | 'waiting'
  | 'ready'
  | 'settled'

/** One node execution as the progress surface shows it. */
export interface RunNodeView {
  /** The entry the display reads; the node's latest execution. */
  readonly entry: FlowNodeRun
  readonly display: RunNodeDisplay
  /**
   * Unsettled execution predecessors, present only for `waiting` so the
   * surface can name what the node is blocked on.
   */
  readonly unmet: readonly string[]
}

/**
 * Whether one node is work a progress surface tracks: agent, join, and
 * condition nodes execute; start and end are structural bookkeeping.
 * @param run - run whose snapshot defines the node.
 * @param nodeId - node to classify.
 * @returns true for work nodes and for ids the snapshot does not define.
 */
export function isWorkNode(run: FlowRun, nodeId: string): boolean {
  const kind = run.snapshot.nodes.find(node => node.id === nodeId)?.kind
  return kind === undefined || kind === 'agent' || kind === 'join' || kind === 'condition'
}

/**
 * Project the run's visible node executions. A node shows when it is the live
 * execution (running/conversing), when it has not started and is either
 * blocked on a live predecessor or ready to start, or when it is the run's
 * most recent settled execution. A node that settled earlier and waits for a
 * later loop round shows nothing: the record carries no fact that it is
 * scheduled again. Structural start/end nodes stay out — the full run view
 * lists them.
 * @param run - run to project.
 * @returns visible node views in record order.
 */
export function nodeViewsOf(run: FlowRun): RunNodeView[] {
  const views: RunNodeView[] = []
  const shown = (nodeId: string): boolean => isWorkNode(run, nodeId)
  const active = new Set<string>()
  for (const entry of run.nodeRuns) {
    if (entry.status === 'running' || entry.status === 'conversing') active.add(entry.nodeId)
  }
  const seen = new Set<string>()
  const push = (entry: FlowNodeRun, display: RunNodeDisplay, unmet: readonly string[] = []): void => {
    views.push({ entry, display, unmet })
    seen.add(entry.nodeId)
  }
  for (const entry of run.nodeRuns) {
    if (seen.has(entry.nodeId) || !shown(entry.nodeId)) continue
    if (entry.status === 'running') push(entry, 'running')
    else if (entry.status === 'conversing') push(entry, 'conversing')
  }
  const latest = latestEntryByNode(run)
  /* Every work node reads, including one the record has not started yet: the
     snapshot lists it, so its view is a synthesized pending entry. */
  for (const node of run.snapshot.nodes) {
    if (!shown(node.id)) continue
    if (seen.has(node.id)) continue
    const entry = latest.get(node.id)
    if (entry !== undefined && entry.status !== 'pending') continue
    const pending = entry ?? { nodeId: node.id, iteration: 0, status: 'pending' as const }
    const unmet = unmetPredecessors(run, node.id)
    if (unmet.length > 0) {
      /* Blocked on predecessors that are themselves live; otherwise the node
         waits on work no surface shows yet, so it stays out of the way. */
      if (unmet.some(predecessor => active.has(predecessor))) push(pending, 'waiting', unmet)
      continue
    }
    push(pending, 'ready')
    active.add(node.id)
  }
  /* One settled line — the run's most recent completion — keeps the surface
     compact; every execution stays listed in the full run view. */
  let settled: FlowNodeRun | undefined
  for (const entry of run.nodeRuns) {
    if (!SETTLED.has(entry.status) || !shown(entry.nodeId)) continue
    if (latest.get(entry.nodeId) !== entry) continue
    const at = entry.endedAt === undefined ? NaN : Date.parse(entry.endedAt)
    const currentAt = settled?.endedAt === undefined ? NaN : Date.parse(settled.endedAt)
    if (settled === undefined || (!Number.isNaN(at) && (Number.isNaN(currentAt) || at >= currentAt))) settled = entry
  }
  if (settled !== undefined && !seen.has(settled.nodeId)) push(settled, 'settled')
  return views
}

/**
 * Whether the run is paused on its conversational node waiting for the user.
 * Reads the formal `conversing` state, never model text.
 * @param run - run to test.
 * @returns true when the run's live state waits for a user reply.
 */
export function runWaitsForUser(run: FlowRun): boolean {
  return run.status === 'running' && run.nodeRuns.some(entry => entry.status === 'conversing')
}

/** What a run reads as, which is its stored status plus the clarification phase. */
export type RunPhase = 'running' | 'clarifying' | 'completed' | 'failed' | 'cancelled'

/**
 * Phase of one run for status labels; a running run that waits on the user
 * reads as clarifying so the surface can offer the conversation entry.
 * @param run - run to phase.
 * @returns the run's display phase.
 */
export function runPhaseOf(run: FlowRun): RunPhase {
  return runWaitsForUser(run) ? 'clarifying' : run.status
}

/** One recorded transition's body, before its timestamp. */
type RunActivityBody =
  | { readonly kind: 'run-started' | 'run-ended' }
  | { readonly kind: 'node-started'; readonly nodeId: string }
  /** A settled node transition; its status is the recorded outcome. */
  | { readonly kind: 'node-ended'; readonly nodeId: string; readonly status: FlowNodeRun['status'] }

/** The run's most recent recorded transition. */
export type RunActivity = RunActivityBody & { readonly at: number }

/**
 * Read the run's most recent activity from persisted transitions only. Chunk
 * traffic never touches the run record, so this is the last fact the surface
 * can prove — surfaces must phrase quiet periods around recorded activity,
 * never claim the model is silent. Unparseable timestamps drop out; equal
 * timestamps keep the earlier-listed (more specific) transition.
 * @param run - run to read.
 * @returns the latest transition, falling back to the run's own start.
 */
export function lastActivityOf(run: FlowRun): RunActivity {
  const candidates: RunActivity[] = []
  for (const entry of run.nodeRuns) {
    if (entry.startedAt !== undefined) pushActivity(candidates, entry.startedAt, { kind: 'node-started', nodeId: entry.nodeId })
    if (entry.endedAt !== undefined) {
      pushActivity(candidates, entry.endedAt, { kind: 'node-ended', nodeId: entry.nodeId, status: entry.status })
    }
  }
  if (run.endedAt !== undefined) pushActivity(candidates, run.endedAt, { kind: 'run-ended' })
  pushActivity(candidates, run.startedAt, { kind: 'run-started' })
  let latest: RunActivity | undefined
  for (const candidate of candidates) {
    if (latest === undefined || candidate.at > latest.at) latest = candidate
  }
  /* v8 ignore next -- the run start above is schema-required, so a valid record always contributes one */
  return latest ?? { at: 0, kind: 'run-started' }
}

/** Append one parseable transition; unparseable timestamps drop out. */
function pushActivity(candidates: RunActivity[], iso: string, activity: RunActivityBody): void {
  const at = Date.parse(iso)
  if (!Number.isNaN(at)) candidates.push({ ...activity, at })
}

/**
 * Whether a run's recorded activity has been quiet longer than the stall
 * threshold. Only in-flight runs stall; a settled run has a final transition.
 * A quiet record is not proof the model stopped — the surface says so.
 * @param run - run to test.
 * @param now - current epoch ms, injected for pure rendering.
 * @param stallNoticeMs - quiet period that raises the notice.
 * @returns true when the run is in flight and quiet past the threshold.
 */
export function runStalled(run: FlowRun, now: number, stallNoticeMs: number): boolean {
  if (run.status !== 'running') return false
  return now - lastActivityOf(run).at >= stallNoticeMs
}

/**
 * Resolve one node's display name without localized fallbacks: the node's own
 * title, else its agent template's name, else undefined so the caller falls
 * back to the node kind's localized label.
 * @param run - run whose snapshot names the node.
 * @param nodeId - node to name.
 * @param templates - template roster the run's snapshot may reference.
 * @returns the resolved name, or undefined when only the kind label remains.
 */
export function nodeDisplayName(
  run: FlowRun,
  nodeId: string,
  templates: readonly { readonly id: string; readonly name: string }[],
): string | undefined {
  const node = run.snapshot.nodes.find(candidate => candidate.id === nodeId)
  if (node === undefined) return nodeId
  if (node.kind === 'agent') {
    if (node.title !== undefined) return node.title
    return templates.find(candidate => candidate.id === node.templateId)?.name ?? nodeId
  }
  return node.title
}
