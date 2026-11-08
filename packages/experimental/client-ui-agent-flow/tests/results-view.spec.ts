import { describe, expect, it } from 'vitest'
import type { AgentTemplateId, FlowDocument, FlowNodeRun, FlowRun } from '@deepseek-ai/dsh-experimental-agent-flow/types'
import {
  PRIMARY_ARTIFACT_LIMIT, artifactGroups, baseName, extensionOf, isDocumentPath, isEnvironmentPath,
  isProjectEntryPath, nodeResults, relativePath, runOverview, structuralEntries,
} from '../src/client/results-view.ts'

const TEMPLATE = 'template-1' as AgentTemplateId

function flow(): FlowDocument {
  return {
    id: 'flow-1' as FlowDocument['id'],
    name: 'demo',
    maxIterations: 16,
    nodes: [
      { kind: 'start', id: 'start' },
      { kind: 'agent', id: 'design', templateId: TEMPLATE, instruction: 'design' },
      { kind: 'condition', id: 'verdict' },
      { kind: 'agent', id: 'review', templateId: TEMPLATE, instruction: 'review' },
      { kind: 'end', id: 'end' },
    ],
    edges: [
      { kind: 'execution', from: 'start', to: 'design' },
      { kind: 'execution', from: 'design', to: 'verdict' },
      { kind: 'execution', from: 'verdict', to: 'review' },
      { kind: 'execution', from: 'review', to: 'end' },
    ],
    createdAt: 'a',
    updatedAt: 'a',
  }
}

function run(nodeRuns: FlowNodeRun[] = []): FlowRun {
  return {
    id: 'run-1' as FlowRun['id'],
    flowId: flow().id,
    snapshot: flow(),
    parentSessionId: 'session-1' as FlowRun['parentSessionId'],
    status: 'running',
    input: 'go',
    nodeRuns,
    startedAt: '2026-11-04T00:00:00.000Z',
  }
}

const entry = (nodeId: string, iteration: number, status: FlowNodeRun['status'], extra: Partial<FlowNodeRun> = {}): FlowNodeRun =>
  ({ nodeId, iteration, status, ...extra })

describe('file addresses', () => {
  it('reads the final segment and its extension', () => {
    expect(baseName('/a/b/review.md')).toBe('review.md')
    expect(baseName('review.md')).toBe('review.md')
    expect(extensionOf('/a/b/review.MD')).toBe('md')
    expect(extensionOf('/a/b/.gitignore')).toBe('')
    expect(extensionOf('/a/b/README')).toBe('')
  })

  it('splits Windows drive and UNC addresses by their own separators', () => {
    expect(baseName('C:\\work\\.venv\\lib\\dependency.md')).toBe('dependency.md')
    expect(baseName('\\\\server\\share\\report.md')).toBe('report.md')
    expect(baseName('C:\\work\\mixed/review.md')).toBe('review.md')
    expect(extensionOf('C:\\work\\review.MD')).toBe('md')
  })

  it('keeps a backslash inside a POSIX name out of the split', () => {
    expect(baseName('/work/my\\file.md')).toBe('my\\file.md')
    expect(baseName('/work/dir\\name/last.txt')).toBe('last.txt')
  })

  it('recognizes documents, project entries, and tooling directories', () => {
    expect(isDocumentPath('/work/00-review/review.md')).toBe(true)
    expect(isDocumentPath('/work/notes.txt')).toBe(true)
    expect(isDocumentPath('/work/main.py')).toBe(false)
    expect(isProjectEntryPath('/work/package.json')).toBe(true)
    expect(isProjectEntryPath('/work/pyproject.toml')).toBe(true)
    expect(isProjectEntryPath('/work/review.md')).toBe(false)
    expect(isEnvironmentPath('/work/.venv/lib/site.py')).toBe(true)
    expect(isEnvironmentPath('/work/node_modules/x/index.js')).toBe(true)
    expect(isEnvironmentPath('/work/__pycache__/m.pyc')).toBe(true)
    expect(isEnvironmentPath('/work/src/main.py')).toBe(false)
    /* A POSIX address never treats a backslash as a separator, so a name
       containing one is not read as an environment directory. */
    expect(isEnvironmentPath('/work/a\\.venv/b.md')).toBe(false)
  })

  it('makes a path relative to the workspace root only when it lies inside it', () => {
    expect(relativePath('/work/review.md', '/work')).toBe('review.md')
    expect(relativePath('/work/a/b.md', '/work/')).toBe('a/b.md')
    expect(relativePath('/other/b.md', '/work')).toBe('/other/b.md')
    expect(relativePath('/work/b.md', undefined)).toBe('/work/b.md')
    expect(relativePath('/work/b.md', '')).toBe('/work/b.md')
    /* A root that is all separators names no project prefix, exactly like
       the file address helper treats it. */
    expect(relativePath('/a/b.md', '/')).toBe('/a/b.md')
  })

  it('reads Windows addresses against their own workspace root and keeps their spelling', () => {
    expect(relativePath('C:\\work\\.venv\\x.md', 'C:\\work')).toBe('.venv\\x.md')
    expect(relativePath('C:/work/b.md', 'C:\\work')).toBe('b.md')
    expect(relativePath('C:\\work\\b.md', 'C:\\other')).toBe('C:\\work\\b.md')
    expect(relativePath('C:\\workshop\\b.md', 'C:\\work')).toBe('C:\\workshop\\b.md')
    expect(relativePath('\\\\server\\share\\a.md', '\\\\server\\share')).toBe('a.md')
  })

  it('keeps a POSIX backslash a name character, not a collapsed separator', () => {
    /* The root `/work/a\b` and the directory `/work/a/b` are different
       directories; neither is the other's workspace. */
    expect(relativePath('/work/a/b/review.md', '/work/a\\b')).toBe('/work/a/b/review.md')
    expect(relativePath('/work/a\\b/review.md', '/work/a/b')).toBe('/work/a\\b/review.md')
    /* A file genuinely inside the backslash-named directory still reads
       relative to it. */
    expect(relativePath('/work/a\\b/review.md', '/work/a\\b')).toBe('review.md')
  })
})

describe('artifact groups', () => {
  it('leads with documents and project entries and caps the first page', () => {
    const files = [
      '/w/src/main.py', '/w/src/parse.py', '/w/src/median.py', '/w/src/format.py',
      '/w/src/extra.py', '/w/src/more.py', '/w/package.json', '/w/00-review/review.md',
      '/w/design.md',
    ]
    const groups = artifactGroups(files)
    expect(groups.primary.slice(0, 3)).toEqual(['/w/00-review/review.md', '/w/design.md', '/w/package.json'])
    expect(groups.primary).toHaveLength(PRIMARY_ARTIFACT_LIMIT)
    expect(groups.others).toHaveLength(files.length - PRIMARY_ARTIFACT_LIMIT)
    expect(groups.environment).toEqual([])
    expect(groups.total).toBe(files.length)
  })

  it('keeps environment and cache files out of the default view', () => {
    const groups = artifactGroups([
      '/w/review.md',
      '/w/.venv/lib/python3.11/site-packages/x.py',
      '/w/node_modules/z/index.js',
      '/w/__pycache__/m.pyc',
    ])
    expect(groups.primary).toEqual(['/w/review.md'])
    expect(groups.environment).toEqual([
      '/w/.venv/lib/python3.11/site-packages/x.py',
      '/w/node_modules/z/index.js',
      '/w/__pycache__/m.pyc',
    ])
    expect(groups.others).toEqual([])
  })

  it('filters environment files on Windows addresses the same way', () => {
    const groups = artifactGroups([
      'C:\\work\\review.md',
      'C:\\work\\.venv\\lib\\site-packages\\x.py',
      'C:\\work\\src\\main.py',
    ])
    expect(groups.primary).toEqual(['C:\\work\\review.md', 'C:\\work\\src\\main.py'])
    expect(groups.environment).toEqual(['C:\\work\\.venv\\lib\\site-packages\\x.py'])
  })

  it('collapses duplicate addresses without losing the record count', () => {
    const groups = artifactGroups(['/w/a.md', '/w/a.md', '/w/b.py'])
    expect(groups.primary).toEqual(['/w/a.md', '/w/b.py'])
    expect(groups.total).toBe(2)
  })

  it('does not depend on fixed document names', () => {
    const groups = artifactGroups(['/w/notes/final-report.markdown', '/w/lib/impl.ts'])
    expect(groups.primary[0]).toBe('/w/notes/final-report.markdown')
  })
})

describe('node results', () => {
  it('groups a node at its latest round and keeps earlier rounds in order', () => {
    const grouped = nodeResults(run([
      entry('design', 0, 'succeeded', { handoff: 'first' }),
      entry('design', 1, 'running'),
      entry('review', 0, 'succeeded'),
    ]))
    expect(grouped.map(result => result.nodeId)).toEqual(['design', 'review'])
    expect(grouped[0]?.latest.iteration).toBe(1)
    expect(grouped[0]?.earlier.map(round => round.iteration)).toEqual([0])
  })

  it('orders nodes by first execution and skips structural nodes', () => {
    const grouped = nodeResults(run([
      entry('review', 0, 'succeeded'),
      entry('start', 0, 'succeeded'),
      entry('design', 0, 'succeeded'),
      entry('end', 0, 'succeeded'),
    ]))
    expect(grouped.map(result => result.nodeId)).toEqual(['review', 'design'])
  })

  it('never turns a condition into a result card, in any round', () => {
    const grouped = nodeResults(run([
      entry('design', 0, 'succeeded', { result: 'approve' }),
      entry('verdict', 0, 'succeeded', { result: 'approve' }),
      entry('verdict', 1, 'skipped'),
      entry('review', 0, 'running'),
    ]))
    expect(grouped.map(result => result.nodeId)).toEqual(['design', 'review'])
  })

  it('keeps the latest structural entry for one compact status line', () => {
    const structural = structuralEntries(run([
      entry('start', 0, 'succeeded'),
      entry('start', 1, 'skipped'),
      entry('design', 0, 'succeeded'),
      entry('end', 0, 'pending'),
    ]))
    expect(structural.map(item => [item.nodeId, item.status])).toEqual([['start', 'skipped'], ['end', 'pending']])
  })

  it('keeps conditions out of the structural status line', () => {
    const structural = structuralEntries(run([
      entry('start', 0, 'succeeded'),
      entry('verdict', 0, 'succeeded', { result: 'rework' }),
      entry('end', 0, 'pending'),
    ]))
    expect(structural.map(item => item.nodeId)).toEqual(['start', 'end'])
  })
})

describe('run overview', () => {
  it('reports the newest live execution and the newest failure', () => {
    const overview = runOverview(run([
      entry('design', 0, 'failed', { error: 'boom' }),
      entry('review', 0, 'running'),
    ]))
    expect(overview.current?.nodeId).toBe('review')
    expect(overview.failed?.nodeId).toBe('design')
  })

  it('summarizes no routing from result words, even in a graph that routes', () => {
    /* A condition that has not executed makes any routed-on claim a guess,
       and one that has belongs to the record, not the overview. */
    const routed = runOverview(run([
      entry('design', 0, 'succeeded', { result: 'approve' }),
      entry('verdict', 0, 'succeeded', { result: 'approve' }),
      entry('review', 0, 'succeeded', { result: 'rework' }),
    ]))
    expect(routed).toEqual({})

    const beforeVerdict = runOverview(run([
      entry('design', 0, 'succeeded', { result: 'approve' }),
      entry('review', 0, 'running'),
    ]))
    expect(beforeVerdict.current?.nodeId).toBe('review')
    expect(Object.keys(beforeVerdict)).toEqual(['current'])
  })

  it('names no current node while only a condition executes', () => {
    const overview = runOverview(run([
      entry('design', 0, 'succeeded'),
      entry('verdict', 0, 'running'),
    ]))
    expect(overview.current).toBeUndefined()
  })

  it('still reports a failed condition as the run\'s failure', () => {
    const overview = runOverview(run([
      entry('design', 0, 'succeeded'),
      entry('verdict', 0, 'failed', { error: 'no matching edge' }),
    ]))
    expect(overview.failed?.nodeId).toBe('verdict')
    expect(overview.current).toBeUndefined()
  })

  it('states nothing for a run with no executions', () => {
    expect(runOverview(run())).toEqual({})
  })
})
