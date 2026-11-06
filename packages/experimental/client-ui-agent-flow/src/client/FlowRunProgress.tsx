/**
 * FlowRunProgress: the flow-progress card docked above the composer. Every
 * session a run touches — the one that started it and the sessions its node
 * executions opened — shows the run's live state here. The roster supplies the
 * recorded facts (node executions, transitions, terminal states); the live
 * activity fold supplies what each running node's Session is doing right now,
 * so a reasoning stream reads as active work instead of a quiet record. Neither
 * source claims more than it proves: a run the client cannot observe renders
 * its recorded state, an unobserved node reads as running, and a quiet node
 * shows its own age rather than blaming the model.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, Menu, StateDot, relativeTime } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { FlowNodeRun, FlowRun, FlowRunId } from '@deepseek-ai/dsh-experimental-agent-flow/types'
import type { NodeStage } from './activity.ts'
import { waitsForUser } from './activity.ts'
import type { NodeObservation } from './activity-tracker.ts'
import {
  lastActivityOf, latestEntryByNode, nodeDisplayName, nodeViewsOf, relatedRuns, runStalled,
  type RunActivity, type RunNodeView, type RunPhase,
} from './run-view.ts'
import { NS, RUN_PHASE_LABEL_KEYS } from './locales.ts'
import { formatClock, formatDuration, relativeWord } from './time.ts'
import type { FlowProgressInjected } from './mount.ts'
import css from './FlowRunProgress.module.css'

/** Props the dock entry receives: the session-scoped runtime share, its face, and copy. */
export type FlowRunProgressProps =
  PropsRuntime<'conversation.input.dock'>
  & InjectFace<FlowProgressInjected>
  & PropsLocale<typeof NS>

/** How often the relative wording and the stall threshold re-read the clock. */
const TICK_MS = 1000

/** Phase → state dot: live runs pulse, a failed run errors, a cancelled one idles. */
const PHASE_DOTS = {
  running: 'ongoing',
  clarifying: 'ongoing',
  completed: 'done',
  failed: 'error',
  cancelled: 'idle',
} as const

/** One run's request as a menu-row summary: whitespace collapsed, bounded. */
function requestSummary(input: string): string {
  const flat = input.replace(/\s+/g, ' ').trim()
  return flat.length > 40 ? `${flat.slice(0, 39)}…` : flat
}

/** One plain-text row this card builds; a menu row's label accepts any ReactNode. */
interface RunMenuRow {
  id: string
  label: string
}

/**
 * Append a run-derived suffix to every entry whose label another entry shares.
 * @param entries - menu rows built one per run, in `runs` order.
 * @param runs - the runs those entries describe.
 * @param suffix - distinguishing text derived from one run.
 * @returns the rows, with shared labels separated.
 */
function separateSharedLabels(
  entries: readonly RunMenuRow[],
  runs: readonly FlowRun[],
  suffix: (run: FlowRun) => string,
): RunMenuRow[] {
  const counts = new Map<string, number>()
  for (const entry of entries) counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1)
  return entries.map((entry, index) => {
    const run = runs[index]
    /* v8 ignore next -- entries and runs are built from the same list, so this index always resolves */
    if (run === undefined || (counts.get(entry.label) ?? 0) < 2) return entry
    return { ...entry, label: `${entry.label} · ${suffix(run)}` }
  })
}

/**
 * Localize one recorded transition.
 * @param activity - transition to phrase.
 * @param nameOf - node display names.
 * @param runStatus - the run's status, for run-level endings.
 * @param t - dictionary accessor.
 * @returns the localized activity text.
 */
function activityWord(
  activity: RunActivity,
  nameOf: (nodeId: string) => string,
  runStatus: FlowRun['status'],
  t: FlowRunProgressProps['t'],
): string {
  switch (activity.kind) {
    case 'run-started': return t('progress.activity.flowStarted')
    case 'run-ended':
      return runStatus === 'completed' ? t('progress.activity.flowCompleted')
        : runStatus === 'failed' ? t('progress.activity.flowFailed')
          : t('progress.activity.flowCancelled')
    case 'node-started': return t('progress.activity.nodeStarted', { name: nameOf(activity.nodeId) })
    case 'node-ended':
      return activity.status === 'succeeded' ? t('progress.activity.nodeSucceeded', { name: nameOf(activity.nodeId) })
        : activity.status === 'failed' ? t('progress.activity.nodeFailed', { name: nameOf(activity.nodeId) })
          : t('progress.activity.nodeSkipped', { name: nameOf(activity.nodeId) })
  }
}

/**
 * One node line's status word when no live stage supersedes it.
 * @param view - node view the line renders.
 * @param nameOf - resolves a predecessor id to a display name.
 * @param t - translate function over this plugin's dictionaries.
 * @returns localized status text for the line.
 */
function nodeStatusWord(
  view: RunNodeView,
  nameOf: (nodeId: string) => string,
  t: FlowRunProgressProps['t'],
): string {
  switch (view.display) {
    case 'waiting': {
      return t('progress.node.waiting', { names: view.unmet.map(nameOf).join(t('common.separator')) })
    }
    case 'ready': return t('progress.node.ready')
    default: return t(`runs.node.${view.entry.status}`)
  }
}

/**
 * The live stage one node line should show, or undefined when the record's own
 * word is the best fact: only a running or conversing node has an activity
 * phase, and an observed stage of `unknown` carries no information.
 * @param view - node view the line renders.
 * @param live - that node Session's observation, when this client retains it.
 * @param waiting - whether the run is blocked on this node's user reply.
 * @returns the stage to render, or undefined to fall back to the record.
 */
function stageOf(view: RunNodeView, live: NodeObservation | undefined, waiting: boolean): NodeStage | undefined {
  if (view.display !== 'running' && view.display !== 'conversing') return undefined
  if (waiting) return 'waiting-user'
  if (live?.observed !== true || live.stage === 'unknown') return undefined
  return live.stage
}

/** The flow-progress card for the sessions this run involves. */
export function FlowRunProgress({
  sessionId, useAgentFlow, openRun, openSession, cancelRun, stallNoticeMs, t,
}: FlowRunProgressProps): ReactNode {
  const runs = useAgentFlow(state => state.runs)
  const templates = useAgentFlow(state => state.templates)
  const sessions = useAgentFlow(state => state.sessions)
  const nodeActivity = useAgentFlow(state => state.nodeActivity)
  const syncError = useAgentFlow(state => state.syncError)
  const related = useMemo(() => relatedRuns(runs, sessionId), [runs, sessionId])
  /* The run this card shows: the user's pick while it exists, else the roster's
     deterministic default — a live run first, else the newest — never a random
     roster order. */
  const [pickedRunId, setPickedRunId] = useState<FlowRunId | undefined>(undefined)
  const [menuOpen, setMenuOpen] = useState(false)
  const [cancelling, setCancelling] = useState<FlowRunId | undefined>(undefined)
  const [cancelError, setCancelError] = useState<string | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())

  /* Relative wording and the stall threshold read wall-clock time, so the card
     re-renders on a light interval while it shows. */
  useEffect(() => {
    if (related.length === 0) return
    const timer = setInterval(() => { setNow(Date.now()) }, TICK_MS)
    return () => { clearInterval(timer) }
  }, [related.length])

  /* The cancelling posture ends only when the roster confirms the run settled
     or dropped it, so the button never reports a cancellation the record has
     not confirmed. */
  useEffect(() => {
    if (cancelling === undefined) return
    const target = runs.find(run => run.id === cancelling)
    if (target === undefined || target.status !== 'running') setCancelling(undefined)
  }, [cancelling, runs])

  /* Observations arrive per node Session; a run with no observed node simply
     reads its recorded state. */
  const observationOf = (entry: FlowNodeRun | undefined): NodeObservation | undefined => {
    if (entry?.agentSessionId === undefined) return undefined
    return nodeActivity[String(entry.agentSessionId)]
  }
  /* The run's conversational node, when its graph has one: the run waits on the
     user only through that node. */
  const waitingNodeOf = (run: FlowRun): FlowNodeRun | undefined => {
    const conversational = run.snapshot.nodes.find(node => node.kind === 'agent' && node.interactive === true)
    return conversational === undefined ? undefined : latestEntryByNode(run).get(conversational.id)
  }
  /* The record's `conversing` state flips at turn close, so a live working
     Session means the run is not waiting even while the node stays conversing. */
  const phaseOf = (run: FlowRun): RunPhase => {
    if (run.status !== 'running') return run.status
    const entry = waitingNodeOf(run)
    return waitsForUser(run, entry, observationOf(entry)) ? 'clarifying' : 'running'
  }

  if (related.length === 0) return null
  const selected = related.find(run => run.id === pickedRunId) ?? related[0]
  /* v8 ignore next 2 -- a non-empty related list always yields a first run. */
  if (selected === undefined) return null
  const phase = phaseOf(selected)
  const waitingEntry = waitingNodeOf(selected)
  const waiting = waitsForUser(selected, waitingEntry, observationOf(waitingEntry))
  const nameOf = (nodeId: string): string => {
    const named = nodeDisplayName(selected, nodeId, templates)
    if (named !== undefined) return named
    /* A node without a display name is one the snapshot defines structurally
       or as a join/condition; the helper falls back to the id otherwise. */
    const kind = selected.snapshot.nodes.find(node => node.id === nodeId)?.kind
    /* v8 ignore next 1 -- `named` is undefined only for a defined non-agent node. */
    return t(`node.${kind ?? 'agent'}`)
  }
  const views = nodeViewsOf(selected)
  const activity = lastActivityOf(selected)
  const startedAt = Date.parse(selected.startedAt)
  const elapsedAt = selected.endedAt === undefined ? now : Date.parse(selected.endedAt)
  /* Cancellation goes through the run's parent session, so the entry only
     offers it while that session still owns a live Agent. */
  const drivable = selected.status === 'running'
    && sessions.some(session => session.id === selected.parentSessionId && session.live)
  /* One row per visible node. A live row reads the Session's stage when its
     stream proves one, a failed stream replaces that stage with the loss, and
     a row without a stage keeps the recorded status word. */
  const rows = views.map((view) => {
    const live = observationOf(view.entry)
    const active = view.display === 'running' || view.display === 'conversing'
    const stage = active && live?.streamFailed === true
      ? 'disconnected' as const
      : stageOf(view, live, waiting && view.entry.nodeId === waitingEntry?.nodeId)
    return { view, live, stage }
  })
  /* Quiet is an executing node's own fact: a settled execution keeps its last
     observation for reading, but it has no activity left to be late with. A
     failed stream is not silence (the client stopped hearing), and a node the
     run waits on is idle by design. Each row is judged alone, so one branch's
     condition never hides another's. */
  const executingRows = rows.filter(({ view }) => view.display === 'running' || view.display === 'conversing')
  const observedRows = executingRows.flatMap(({ view, live }) => live?.observed === true && live.lastAt !== undefined
    ? [{
      nodeId: view.entry.nodeId,
      at: live.lastAt,
      failed: live.streamFailed,
      idle: waiting && view.entry.nodeId === waitingEntry?.nodeId,
    }]
    : [])
  const quiet = observedRows.filter(entry => !entry.failed && !entry.idle && now - entry.at >= stallNoticeMs)
  /* Only an executing run can stall. When this client observes no executing
     node at all, the record's own transitions are the fallback. */
  const stalled = selected.status === 'running'
    && (quiet.length > 0 || (observedRows.length === 0 && !waiting && runStalled(selected, now, stallNoticeMs)))
  /* The node to jump to: a reply the flow waits on first, else the live one. */
  const focusRow = rows.find(row => row.view.display === 'conversing')
    ?? rows.find(row => row.view.display === 'running')
  const focusSession = focusRow?.view.entry.agentSessionId
  const focusStage = focusRow?.stage
  const cancel = (): void => {
    /* The entry is disabled while a cancellation is pending, so one press
       reaches the run and a confirmed settle or a failure re-enables it. */
    setCancelling(selected.id)
    setCancelError(undefined)
    cancelRun(selected.parentSessionId, selected.id).catch((error: unknown) => {
      setCancelling(undefined)
      setCancelError(error instanceof Error ? error.message : String(error))
    })
  }

  /* A row names its run by the request the user submitted: concurrent runs of
     one flow share a name and phase. Identical requests fall back to the start
     clock, then to the run identity, so every row names exactly one run. */
  const items = separateSharedLabels(
    separateSharedLabels(
      related.map(run => ({
        id: String(run.id),
        label: [run.snapshot.name, t(RUN_PHASE_LABEL_KEYS[phaseOf(run)]), requestSummary(run.input)]
          .filter(part => part !== '')
          .join(' · '),
      })),
      related,
      run => formatClock(run.startedAt),
    ),
    related,
    run => `#${String(run.id).slice(0, 8)}`,
  )

  return (
    <div className={css.dock} data-flow-progress="">
      <section className={css.bar} aria-label={t('progress.region')}>
        <div className={css.head}>
          <span className={css.glyph} aria-hidden><StateDot state={PHASE_DOTS[phase]} size={10} /></span>
          <span className={css.phase}>{t(`progress.phase.${phase}`)}</span>
          {related.length === 1
            ? <span className={css.flowName}>{selected.snapshot.name}</span>
            : (
              <Menu
                open={menuOpen}
                items={items}
                selectedId={String(selected.id)}
                onSelect={(id) => { setPickedRunId(id as FlowRunId); setMenuOpen(false) }}
                onClose={() => { setMenuOpen(false) }}
                side="bottom"
                portal
                anchor={(
                  <button
                    type="button"
                    className={css.runPicker}
                    aria-label={t('progress.selectRun')}
                    onClick={() => { setMenuOpen(open => !open) }}
                  >
                    {selected.snapshot.name}
                  </button>
                )}
              />
            )}
          <span className={css.elapsed}>{t('progress.elapsed', { duration: formatDuration(Math.max(0, elapsedAt - startedAt), t) })}</span>
          <span className={css.actions}>
            {focusSession === undefined ? null : (
              <Button variant="ghost" size="sm" onClick={() => { openSession(focusSession) }}>
                {focusStage === 'reasoning' ? t('progress.viewReasoning') : t('progress.viewCurrentNode')}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => { openRun(selected.id) }}>
              {t('progress.viewFlow')}
            </Button>
            {drivable ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={cancelling !== undefined}
                onClick={cancel}
              >
                {cancelling === undefined ? t('runs.cancel') : t('progress.cancelPending')}
              </Button>
            ) : null}
          </span>
        </div>
        {rows.map(({ view, live, stage }) => {
          const nodeSession = view.entry.agentSessionId
          return (
            <p key={`${view.entry.nodeId}-${view.entry.iteration}`} className={css.nodeLine}>
              <span className={css.nodeName}>{nameOf(view.entry.nodeId)}</span>
              {view.entry.iteration === 0 ? null : (
                <span className={css.nodeMeta}>{t('progress.round', { count: view.entry.iteration + 1 })}</span>
              )}
              <span className={css.nodeMeta}>
                {stage === undefined ? nodeStatusWord(view, nameOf, t) : t(`progress.stage.${stage}`)}
              </span>
              {stage === undefined || live?.lastAt === undefined ? null : (
                <span className={css.nodeMeta}>{relativeWord(relativeTime(live.lastAt, now), t)}</span>
              )}
              {nodeSession === undefined ? null : (
                <Button
                  variant="ghost"
                  size="sm"
                  className={css.nodeOpen}
                  aria-label={t('progress.openNode', { name: nameOf(view.entry.nodeId) })}
                  onClick={() => { openSession(nodeSession) }}
                >
                  {t('progress.nodeDetails')}
                </Button>
              )}
            </p>
          )
        })}
        {rows.some(row => row.stage !== undefined) ? null : (
          <p className={css.activity}>
            {t('progress.lastActivity', {
              activity: activityWord(activity, nameOf, selected.status, t),
              when: relativeWord(relativeTime(activity.at, now), t),
            })}
          </p>
        )}
        {stalled ? (
          <p className={css.notice}>
            <span aria-hidden><StateDot state="warning" size={10} /></span>
            <span className={css.noticeLead}>
              {quiet.length === 0
                ? t('progress.stalled')
                : t('progress.stalledNodes', {
                  names: quiet.map(entry => nameOf(entry.nodeId)).join(t('common.separator')),
                })}
            </span>
            <span className={css.noticeHint}>{t('progress.stalledHint')}</span>
          </p>
        ) : null}
        {syncError === undefined ? null : (
          <p className={css.notice}>
            <span aria-hidden><StateDot state="idle" size={10} /></span>
            <span className={css.noticeLead}>{t('progress.syncInterrupted')}</span>
          </p>
        )}
        {cancelError === undefined ? null : <p className={css.error} role="alert">{t('error.cancel', { message: cancelError })}</p>}
      </section>
    </div>
  )
}
