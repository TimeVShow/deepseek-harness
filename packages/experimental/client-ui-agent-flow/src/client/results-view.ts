/**
 * Pure projections for the run results page: which node executions become
 * result cards and in what order, what the overview can state from the record,
 * and which produced files are deliverables rather than tooling state.
 * Everything here reads the durable run record; a file list is only filtered
 * for display, never rewritten or treated as a declared deliverable set.
 * Condition nodes never become results: they route execution and forward a
 * handoff, so their record stays diagnostic and their failures surface through
 * the overview rather than a card.
 * @module
 */

import type { FlowNodeRun, FlowRun } from '@deepseek-ai/dsh-experimental-agent-flow/types'
import { isWorkNode } from './run-view.ts'

/** Artifact rows shown before the complete list appears. */
export const PRIMARY_ARTIFACT_LIMIT = 6

/** Directories that hold tooling state rather than run deliverables. */
const ENVIRONMENT_DIRECTORIES: ReadonlySet<string> = new Set([
  '.venv', 'venv', 'node_modules', '__pycache__', '.pytest_cache', '.ruff_cache',
  '.uvcache', '.mypy_cache', '.tox', '.cache', '.git',
])

/** Extensions a document preview can render as prose. */
const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set(['md', 'markdown', 'mdx', 'txt', 'rst'])

/** Manifests that mark a project entry rather than a produced document. */
const PROJECT_ENTRY_NAMES: ReadonlySet<string> = new Set([
  'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Makefile', 'CMakeLists.txt',
  'Dockerfile', 'requirements.txt',
])

/**
 * Whether one address uses Windows spelling: a drive prefix or a UNC root.
 * Anything else reads POSIX, where a backslash can be part of a name.
 * @param path - file address as recorded on the node execution.
 * @returns true when both `/` and `\` separate this address.
 */
function isWindowsAddress(path: string): boolean {
  return /^[/\\]{2}/.test(path) || /^[A-Za-z]:[\\/]/.test(path)
}

/**
 * The final segment of one file address, split by the separators its own
 * platform uses, so a Windows drive or UNC address names its file while a
 * POSIX name containing `\` stays one name.
 * @param path - file address as recorded on the node execution.
 * @returns the final segment, or the whole address when no separator cuts it.
 */
export function baseName(path: string): string {
  const windows = isWindowsAddress(path)
  const trimmed = windows ? path.replace(/[\\/]+$/, '') : path.replace(/\/+$/, '')
  const cut = windows
    ? Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1
    : trimmed.lastIndexOf('/') + 1
  return trimmed.slice(cut)
}

/**
 * The lower-cased extension of one file address, without its dot.
 * @param path - file address whose trailing name carries the extension.
 * @returns the extension without its leading dot, or an empty string when the
 *   name has none or starts with its only dot.
 */
export function extensionOf(path: string): string {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * Whether one path lies inside a dependency, environment, or cache directory.
 * Segments split by the address's own platform, so the same `.venv` directory
 * hides on Windows paths and a POSIX name containing `\` is never mistaken
 * for one.
 * @param path - file address as recorded on the node execution.
 * @returns true when any segment names tooling state.
 */
export function isEnvironmentPath(path: string): boolean {
  const windows = isWindowsAddress(path)
  const segments = windows ? path.split(/[\\/]/) : path.split('/')
  return segments.some(segment => ENVIRONMENT_DIRECTORIES.has(segment))
}

/**
 * Whether one path names a document the preview can render.
 * @param path - file address.
 * @returns true for a readable document extension.
 */
export function isDocumentPath(path: string): boolean {
  return DOCUMENT_EXTENSIONS.has(extensionOf(path))
}

/**
 * Whether one path names a project entry rather than a produced document.
 * @param path - file address.
 * @returns true for a known manifest name.
 */
export function isProjectEntryPath(path: string): boolean {
  return PROJECT_ENTRY_NAMES.has(baseName(path))
}

/**
 * Read one file address relative to the run's workspace root, so rows show a
 * stable project-relative path while the copy action keeps the absolute one.
 * Each side normalizes by its own platform for the prefix comparison only —
 * backslashes fold to separators on a Windows address alone — so the displayed
 * remainder keeps the address's own separators, a POSIX name containing a
 * backslash stays one name, and an address outside the root keeps its full
 * spelling.
 * @param path - file address.
 * @param cwd - workspace root the run executed in, when known.
 * @returns the relative path, or the original address outside that root.
 */
export function relativePath(path: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return path
  const normalized = isWindowsAddress(path) ? path.replace(/\\/g, '/') : path
  const root = (isWindowsAddress(cwd) ? cwd.replace(/\\/g, '/') : cwd).replace(/\/+$/, '')
  if (root === '') return path
  return normalized.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
}

/** How one node execution's produced files read on the results page. */
export interface ArtifactGroups {
  /** Documents and project entries shown before expanding, capped. */
  readonly primary: readonly string[]
  /** Remaining visible files, available from the full list. */
  readonly others: readonly string[]
  /** Tooling, dependency, and cache files, hidden unless asked for. */
  readonly environment: readonly string[]
  /** Every distinct file the execution recorded. */
  readonly total: number
}

/**
 * Split one execution's file list for display: documents and project entries
 * lead, tooling state stays out of the way, and duplicates collapse. The record
 * itself is untouched, because the runtime hands these files to later nodes.
 * @param files - file addresses recorded on the execution, in scan order.
 * @returns the display groups and the distinct total.
 */
export function artifactGroups(files: readonly string[]): ArtifactGroups {
  const seen = new Set<string>()
  const visible: string[] = []
  const environment: string[] = []
  for (const file of files) {
    if (seen.has(file)) continue
    seen.add(file)
    if (isEnvironmentPath(file)) environment.push(file)
    else visible.push(file)
  }
  const documents = visible.filter(isDocumentPath)
  const entries = visible.filter(path => !isDocumentPath(path) && isProjectEntryPath(path))
  const rest = visible.filter(path => !isDocumentPath(path) && !isProjectEntryPath(path))
  const primary = [...documents, ...entries, ...rest].slice(0, PRIMARY_ARTIFACT_LIMIT)
  const shown = new Set(primary)
  return {
    primary,
    others: visible.filter(path => !shown.has(path)),
    environment,
    total: seen.size,
  }
}

/** One node's executions on the results page: the latest round and its history. */
export interface NodeResult {
  readonly nodeId: string
  /** The node's newest recorded execution. */
  readonly latest: FlowNodeRun
  /** Earlier rounds of the same node, in execution order. */
  readonly earlier: readonly FlowNodeRun[]
}

/**
 * Whether one node becomes a result card: every work node except conditions.
 * {@link isWorkNode} itself stays untouched because the progress surface and
 * the structural line read it; conditions drop out of both result paths here.
 * @param run - run whose snapshot defines the node.
 * @param nodeId - node to classify.
 * @returns true for agent and join nodes and ids the snapshot does not define.
 */
function isResultNode(run: FlowRun, nodeId: string): boolean {
  const kind = run.snapshot.nodes.find(node => node.id === nodeId)?.kind
  return kind !== 'condition' && isWorkNode(run, nodeId)
}

/**
 * Group one run's result-node executions by node, in the order each node first
 * executed. Structural start/end nodes and routing conditions never become
 * result cards.
 * @param run - run record to project.
 * @returns one result per executed result node.
 */
export function nodeResults(run: FlowRun): NodeResult[] {
  const byNode = new Map<string, FlowNodeRun[]>()
  for (const entry of run.nodeRuns) {
    if (!isResultNode(run, entry.nodeId)) continue
    const rounds = byNode.get(entry.nodeId)
    if (rounds === undefined) byNode.set(entry.nodeId, [entry])
    else rounds.push(entry)
  }
  const results: NodeResult[] = []
  for (const [nodeId, rounds] of byNode) {
    const latest = rounds[rounds.length - 1]
    /* v8 ignore next -- a group only exists after one push. */
    if (latest === undefined) continue
    results.push({ nodeId, latest, earlier: rounds.slice(0, -1) })
  }
  return results
}

/**
 * The latest execution of every structural start/end node, for one compact
 * status line. Routing conditions are work nodes, so they stay out of both
 * this line and the result cards.
 * @param run - run record to project.
 * @returns the newest start/end entries, in record order.
 */
export function structuralEntries(run: FlowRun): FlowNodeRun[] {
  const latest = new Map<string, FlowNodeRun>()
  for (const entry of run.nodeRuns) {
    if (isWorkNode(run, entry.nodeId)) continue
    latest.set(entry.nodeId, entry)
  }
  return [...latest.values()]
}

/** What the overview can state without inventing a conclusion. */
export interface RunOverview {
  /**
   * The execution reading running or conversing, when a node the results page
   * names does. A condition executing is real progress the run status already
   * states; naming it as the current node would flash a card-less hop, so it
   * is skipped and no successor is invented.
   */
  readonly current?: FlowNodeRun
  /**
   * The most recent failed execution, when the run carries one — including a
   * failed condition: hiding its card must not hide why the run failed.
   */
  readonly failed?: FlowNodeRun
}

/**
 * Read the run's live result-node execution and its failure. No routing word
 * is summarized here: a condition that has not executed makes any "routed on"
 * claim a guess, and one that has belongs to the diagnostics record, not the
 * overview. A completed run is never reported as reviewed: this projection
 * has no opinion on what a review concluded.
 * @param run - run record to read.
 * @returns the overview facts the record supports.
 */
export function runOverview(run: FlowRun): RunOverview {
  let current: FlowNodeRun | undefined
  let failed: FlowNodeRun | undefined
  for (const entry of run.nodeRuns) {
    if ((entry.status === 'running' || entry.status === 'conversing') && isResultNode(run, entry.nodeId)) {
      current = entry
    }
    if (entry.status === 'failed') failed = entry
  }
  return {
    ...current === undefined ? {} : { current },
    ...failed === undefined ? {} : { failed },
  }
}
