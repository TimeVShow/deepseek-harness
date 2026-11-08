/**
 * The run results page: what a run produced, node by node, without burying the
 * outcome under every file it touched. The overview states only what the record
 * proves — no routing summary is derived from a result word, because the
 * condition that would consume it may not have executed; each agent node's
 * latest round becomes a result card whose handoff is rendered as Markdown and
 * whose documents are compact rows. Routing conditions are execution control,
 * not deliverables, so they never become cards; their failures still surface
 * in the overview. Relative Markdown destinations resolve against the node
 * round's own working directory and open through the panel's resource action,
 * so the sidebar owns loading and failure states. Earlier rounds and the
 * complete file list stay one disclosure away.
 * @module
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Button, FileTypeIcon, MarkdownDelegateProvider, MarkdownText, Tag, relativeTime, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentTemplate, FlowNodeRun, FlowRun } from '@deepseek-ai/dsh-experimental-agent-flow/types'
import { resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionChoice } from './controller.ts'
import { NS, RUN_PHASE_LABEL_KEYS } from './locales.ts'
import {
  artifactGroups, baseName, isEnvironmentPath, nodeResults, relativePath, runOverview, structuralEntries,
} from './results-view.ts'
import { nodeDisplayName, runPhaseOf } from './run-view.ts'
import { NODE_STATUS_KEYS, NODE_STATUS_TONES, RUN_STATUS_TONES } from './status.ts'
import { formatDuration, relativeWord } from './time.ts'
import css from './RunResults.module.css'

/** Copy accessor for this plugin's dictionaries. */
type Translate = PropsLocale<typeof NS>['t']

/** Options a Markdown file activation carries, such as a reveal line. */
export interface OpenFileOptions {
  readonly line?: number | undefined
}

/** Handoff length past which the summary starts collapsed. */
const HANDOFF_CLAMP_CHARS = 600

/** How long the copy action reports success, in ms. */
const COPIED_FEEDBACK_MS = 1_000

/** Everything the results page needs from the panel shell. */
export interface RunResultsProps {
  readonly run: FlowRun
  readonly templates: readonly AgentTemplate[]
  /** Known sessions, for the run's workspace root. */
  readonly sessions: readonly SessionChoice[]
  /** Whether the parent session can still cancel this run. */
  readonly canCancel: boolean
  /** Whether the parent session can end a clarification in this run. */
  readonly canConclude: boolean
  /** Close the run and return to the list. */
  readonly onBack: () => void
  readonly onCancel: () => void
  readonly onConclude: () => void
  /** Open the conversation, or the node's child session. */
  readonly onOpenSession: (sessionId: SessionId) => void
  /**
   * Open one produced file through the panel's resource action; `options`
   * carries a reveal line a Markdown destination asked for.
   */
  readonly onOpenFile: (sessionId: SessionId, path: string, options?: OpenFileOptions) => void
  readonly t: Translate
}

/** Build the Markdown chrome copy for one locale revision. */
function markdownLabels(t: Translate): MarkdownLabels {
  return {
    code: {
      copyLabel: t('runs.markdown.copy'),
      copiedLabel: t('runs.markdown.copied'),
      toolbarLabels: {
        codeLabel: t('runs.markdown.code'),
        wrapLabel: t('runs.markdown.wrap'),
        unwrapLabel: t('runs.markdown.unwrap'),
      },
    },
    footnotes: t('runs.markdown.footnotes'),
  }
}

/** Copy one absolute path with transient success feedback. */
function CopyPathButton({ path, t }: { path: string; t: Translate }): ReactNode {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => {
    if (timer.current !== undefined) clearTimeout(timer.current)
  }, [])
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        void writeClipboard(path).then((ok) => {
          if (!ok) return
          setCopied(true)
          if (timer.current !== undefined) clearTimeout(timer.current)
          timer.current = setTimeout(() => { setCopied(false) }, COPIED_FEEDBACK_MS)
        })
      }}
    >
      {copied ? t('runs.copied') : t('runs.copyPath')}
    </Button>
  )
}

/** One compact file row: name, project-relative path, preview, and copy. */
function FileRow({ file, cwd, sessionId, onOpenFile, t }: {
  file: string
  cwd: string | undefined
  sessionId: SessionId
  onOpenFile: (sessionId: SessionId, path: string, options?: OpenFileOptions) => void
  t: Translate
}): ReactNode {
  return (
    <li className={css.file}>
      <FileTypeIcon path={file} size={14} />
      <span className={css.fileName}>{baseName(file)}</span>
      <span className={css.filePath} title={file}>{relativePath(file, cwd)}</span>
      <span className={css.fileActions}>
        <Button variant="ghost" size="sm" onClick={() => { onOpenFile(sessionId, file) }}>
          {t('runs.filePreview')}
        </Button>
        <CopyPathButton path={file} t={t} />
      </span>
    </li>
  )
}

/** The files one node execution recorded, led by documents and capped. */
function ArtifactList({ files, cwd, sessionId, keyBase, open, toggle, onOpenFile, t }: {
  files: readonly string[]
  cwd: string | undefined
  sessionId: SessionId
  keyBase: string
  open: (key: string) => boolean
  toggle: (key: string) => void
  onOpenFile: (sessionId: SessionId, path: string, options?: OpenFileOptions) => void
  t: Translate
}): ReactNode {
  const groups = artifactGroups(files)
  const allKey = `${keyBase}:all`
  const environmentKey = `${keyBase}:environment`
  const showAll = open(allKey)
  const showEnvironment = open(environmentKey)
  const shown = showAll ? [...groups.primary, ...groups.others] : groups.primary
  return (
    <div className={css.artifacts}>
      <ul className={css.files}>
        {shown.map(file => (
          <FileRow
            key={file}
            file={file}
            cwd={cwd}
            sessionId={sessionId}
            onOpenFile={onOpenFile}
            t={t}
          />
        ))}
      </ul>
      {groups.others.length === 0 ? null : (
        <button type="button" className={css.inlineButton} aria-expanded={showAll} onClick={() => { toggle(allKey) }}>
          {showAll ? t('runs.collapseFiles') : t('runs.allFiles', { count: groups.others.length })}
        </button>
      )}
      {groups.environment.length === 0 ? null : (
        <>
          <button
            type="button"
            className={css.inlineButton}
            aria-expanded={showEnvironment}
            onClick={() => { toggle(environmentKey) }}
          >
            {showEnvironment
              ? t('runs.hideEnvironment')
              : t('runs.showEnvironment', { count: groups.environment.length })}
          </button>
          {showEnvironment ? (
            <ul className={css.files}>
              {groups.environment.map(file => (
                <FileRow
                  key={file}
                  file={file}
                  cwd={cwd}
                  sessionId={sessionId}
                  onOpenFile={onOpenFile}
                  t={t}
                />
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  )
}

/** One executed round's outcome: result mark, handoff, files, and errors. */
function ResultBody({ run, entry, agentNode, cwd, labels, open, toggle, onOpenFile, t }: {
  run: FlowRun
  entry: FlowNodeRun
  /** Whether this node runs an agent, so a missing summary is worth stating. */
  agentNode: boolean
  cwd: string | undefined
  labels: MarkdownLabels
  open: (key: string) => boolean
  toggle: (key: string) => void
  onOpenFile: (sessionId: SessionId, path: string, options?: OpenFileOptions) => void
  t: Translate
}): ReactNode {
  const keyBase = `${run.id}:${entry.nodeId}:${entry.iteration}`
  const handoff = entry.handoff
  const clampable = handoff !== undefined && handoff.length > HANDOFF_CLAMP_CHARS
  const expanded = open(`${keyBase}:handoff`)
  return (
    <>
      {entry.result === undefined ? null : (
        <p className={css.route}>{t('runs.result', { word: entry.result })}</p>
      )}
      {handoff === undefined ? (
        agentNode ? (
          <p className={css.muted}>
            {entry.status === 'conversing' ? t('runs.conversingHint') : t('runs.noHandoff')}
          </p>
        ) : null
      ) : (
        <>
          <MarkdownDelegateProvider
            openFile={(path, options) => {
              /* A Markdown destination is written from the node's own working
                 directory, so a relative link resolves there — the run's
                 workspace root only stands in for records the executor predates
                 and never mints an undefined path. */
              onOpenFile(run.parentSessionId, resolveWorkspacePath(entry.dir ?? cwd, path), options)
            }}
          >
            <div className={css.handoff} data-clamped={clampable && !expanded}>
              <MarkdownText text={handoff} labels={labels} />
            </div>
          </MarkdownDelegateProvider>
          {clampable ? (
            <button
              type="button"
              className={css.inlineButton}
              aria-expanded={expanded}
              onClick={() => { toggle(`${keyBase}:handoff`) }}
            >
              {expanded ? t('runs.handoffCollapse') : t('runs.handoffExpand')}
            </button>
          ) : null}
        </>
      )}
      {entry.files === undefined || entry.files.length === 0 ? null : (
        <ArtifactList
          files={entry.files}
          cwd={cwd}
          sessionId={run.parentSessionId}
          keyBase={keyBase}
          open={open}
          toggle={toggle}
          onOpenFile={onOpenFile}
          t={t}
        />
      )}
      {entry.error === undefined ? null : <p className={css.error}>{entry.error}</p>}
    </>
  )
}

/**
 * Render one run's results page.
 * @param props - run record, rosters, shell callbacks, and localized copy.
 * @returns the results page.
 */
export function RunResults({
  run, templates, sessions, canCancel, canConclude, onBack, onCancel, onConclude, onOpenSession, onOpenFile, t,
}: RunResultsProps): ReactNode {
  const [expanded, setExpanded] = useState<Readonly<Record<string, boolean>>>({})
  const open = (key: string): boolean => expanded[key] === true
  const toggle = (key: string): void => {
    setExpanded(current => ({ ...current, [key]: current[key] !== true }))
  }

  const labels = useMemo(() => markdownLabels(t), [t])
  const phase = runPhaseOf(run)
  const overview = runOverview(run)
  const groups = nodeResults(run)
  const structure = structuralEntries(run)
  const now = Date.now()
  const startedAt = Date.parse(run.startedAt)
  const endedAt = run.endedAt === undefined ? undefined : Date.parse(run.endedAt)
  const cwd = sessions.find(session => session.id === run.parentSessionId)?.cwd
  const conversational = new Set(
    run.snapshot.nodes.filter(node => node.kind === 'agent' && node.interactive === true).map(node => node.id),
  )
  const nameOf = (nodeId: string): string => {
    const named = nodeDisplayName(run, nodeId, templates)
    if (named !== undefined) return named
    /* A node without a display name is one the snapshot defines structurally
       or as a join/condition; the helper falls back to the id otherwise. */
    const kind = run.snapshot.nodes.find(node => node.id === nodeId)?.kind
    /* v8 ignore next 1 -- `named` is undefined only for a defined non-agent node. */
    return t(`node.${kind ?? 'agent'}`)
  }
  const deliverables = new Set<string>()
  for (const entry of run.nodeRuns) {
    for (const file of entry.files ?? []) if (!isEnvironmentPath(file)) deliverables.add(file)
  }
  const requestKey = `${run.id}:request`

  return (
    <section className={css.results} aria-label={t('runs.results')} data-run-results={run.id}>
      <div className={css.bar}>
        <Button variant="ghost" size="sm" onClick={onBack}>
          {t('runs.backToRuns')}
        </Button>
        <span className={css.title}>{run.snapshot.name}</span>
        <Tag tone={RUN_STATUS_TONES[phase]}>{t(RUN_PHASE_LABEL_KEYS[phase])}</Tag>
        {canCancel ? (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t('runs.cancel')}
          </Button>
        ) : null}
      </div>

      <div className={css.overview}>
        <div className={css.meta}>
          <span>{t('runs.started', { when: relativeWord(relativeTime(startedAt, now), t) })}</span>
          <span>{t('runs.duration', { duration: formatDuration(Math.max(0, (endedAt ?? now) - startedAt), t) })}</span>
          {overview.current === undefined ? null : (
            <span>{t('runs.currentNode', { name: nameOf(overview.current.nodeId) })}</span>
          )}
          <span className={css.deliverables}>
            {deliverables.size === 0 ? t('runs.noDeliverables') : t('runs.deliverables', { count: deliverables.size })}
          </span>
        </div>
        <button
          type="button"
          className={css.inlineButton}
          aria-expanded={open(requestKey)}
          onClick={() => { toggle(requestKey) }}
        >
          {t('runs.request')}
        </button>
        {open(requestKey) ? <p className={css.request}>{run.input}</p> : null}
        {run.error === undefined ? null : <p className={css.error}>{t('runs.error', { message: run.error })}</p>}
        {overview.failed?.error === undefined || overview.failed.error === run.error ? null : (
          <p className={css.error}>
            {t('runs.nodeError', { name: nameOf(overview.failed.nodeId), message: overview.failed.error })}
          </p>
        )}
      </div>

      {structure.length === 0 ? null : (
        <p className={css.structural}>
          {structure.map(entry => `${nameOf(entry.nodeId)} · ${t(NODE_STATUS_KEYS[entry.status])}`).join(t('common.separator'))}
        </p>
      )}

      {groups.length === 0 ? <p className={css.muted}>{t('runs.noResults')}</p> : null}
      <ol className={css.cards}>
        {groups.map(({ nodeId, latest, earlier }) => {
          const roundsKey = `${run.id}:${nodeId}:rounds`
          const agentNode = run.snapshot.nodes.find(node => node.id === nodeId)?.kind === 'agent'
            || run.snapshot.nodes.find(node => node.id === nodeId) === undefined
          return (
            <li key={nodeId} className={css.card} data-node={nodeId}>
              <div className={css.cardHead}>
                <span className={css.nodeName}>{nameOf(nodeId)}</span>
                {/* Rounds read 1-based; the stored iteration stays untouched. */}
                {latest.iteration === 0 ? null : (
                  <span className={css.muted}>{t('runs.iteration', { count: latest.iteration + 1 })}</span>
                )}
                <Tag tone={NODE_STATUS_TONES[latest.status]}>{t(NODE_STATUS_KEYS[latest.status])}</Tag>
                <span className={css.spacer} />
                {latest.agentSessionId === undefined ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => { onOpenSession(latest.agentSessionId as SessionId) }}
                  >
                    {t(conversational.has(nodeId) ? 'runs.openConversation' : 'runs.viewExecution')}
                  </Button>
                )}
              </div>
              {latest.status === 'conversing' && canConclude ? (
                <Button variant="outline" size="sm" onClick={onConclude}>
                  {t('runs.conclude')}
                </Button>
              ) : null}
              <ResultBody
                run={run}
                entry={latest}
                agentNode={agentNode}
                cwd={cwd}
                labels={labels}
                open={open}
                toggle={toggle}
                onOpenFile={onOpenFile}
                t={t}
              />
              {earlier.length === 0 ? null : (
                <div className={css.rounds}>
                  <button
                    type="button"
                    className={css.inlineButton}
                    aria-expanded={open(roundsKey)}
                    onClick={() => { toggle(roundsKey) }}
                  >
                    {t('runs.earlierRounds', { count: earlier.length })}
                  </button>
                  {open(roundsKey) ? (
                    <ol className={css.roundList}>
                      {earlier.map((entry) => {
                        const roundKey = `${run.id}:${nodeId}:${entry.iteration}:round`
                        return (
                          <li key={entry.iteration} className={css.round}>
                            <button
                              type="button"
                              className={css.roundHead}
                              aria-expanded={open(roundKey)}
                              onClick={() => { toggle(roundKey) }}
                            >
                              <span>{t('runs.iteration', { count: entry.iteration + 1 })}</span>
                              <Tag tone={NODE_STATUS_TONES[entry.status]}>{t(NODE_STATUS_KEYS[entry.status])}</Tag>
                            </button>
                            {open(roundKey) ? (
                              <ResultBody
                                run={run}
                                entry={entry}
                                agentNode={agentNode}
                                cwd={cwd}
                                labels={labels}
                                open={open}
                                toggle={toggle}
                                onOpenFile={onOpenFile}
                                t={t}
                              />
                            ) : null}
                          </li>
                        )
                      })}
                    </ol>
                  ) : null}
                </div>
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}
