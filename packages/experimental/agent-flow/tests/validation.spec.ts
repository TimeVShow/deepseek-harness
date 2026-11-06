import { describe, expect, it } from 'vitest'
import { agentFlowDomain, flowDocumentRecord } from '../src/spec.ts'
import { AgentTemplateId, FlowId } from '../src/types.ts'
import type { FlowDocument, FlowEdge, FlowNode } from '../src/spec.ts'
import { validateFlow } from '../src/validation.ts'
import { analyzeExecutionGraph } from '../src/graph.ts'

const TEMPLATE = AgentTemplateId('template')
const KNOWN = new Set([TEMPLATE])
const agent = (id: string): FlowNode => ({ kind: 'agent', id, templateId: TEMPLATE, instruction: `perform ${id}` })
const execution = (from: string, to: string, result?: string): FlowEdge => ({ kind: 'execution', from, to, ...result === undefined ? {} : { result } })
const input = (from: string, to: string): FlowEdge => ({ kind: 'input', from, to })

function document(nodes: FlowNode[], edges: FlowEdge[]): FlowDocument {
  return {
    id: FlowId('flow'), name: 'example', maxIterations: 16,
    nodes: [{ kind: 'start', id: 'start' }, ...nodes, { kind: 'end', id: 'end' }], edges,
    createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z',
  }
}

function linear(): FlowDocument {
  return document([agent('a'), agent('b'), agent('c')], [execution('start', 'a'), execution('a', 'b'), execution('b', 'c'), execution('c', 'end')])
}

function review(): FlowDocument {
  return document([agent('design'), agent('implement'), agent('review'), { kind: 'condition', id: 'verdict' }], [
    execution('start', 'design'), execution('design', 'implement'), execution('implement', 'review'), execution('review', 'verdict'),
    execution('verdict', 'implement', 'retry'), execution('verdict', 'end', 'pass'), input('start', 'design'), input('design', 'review'),
  ])
}

function parallel(join = false): FlowDocument {
  return document([agent('a'), agent('b'), ...join ? [{ kind: 'join' as const, id: 'all', mode: 'all' as const }] : [], agent('c'), agent('d')], [
    execution('start', 'a'), execution('start', 'b'), execution('a', join ? 'all' : 'c'), execution('b', join ? 'all' : 'c'),
    ...join ? [execution('all', 'c')] : [], execution('c', 'd'), execution('d', 'end'),
  ])
}

function branch(): FlowDocument {
  return document([agent('classify'), { kind: 'condition', id: 'choice' }, agent('left'), agent('right'), agent('merge'), agent('after')], [
    execution('start', 'classify'), execution('classify', 'choice'), execution('choice', 'left', 'left'), execution('choice', 'right', 'right'),
    execution('left', 'merge'), execution('right', 'merge'), execution('merge', 'after'), execution('after', 'end'),
  ])
}

function codes(value: FlowDocument): string[] {
  return validateFlow(value, KNOWN).map(problem => problem.code)
}

function mutate(change: (value: FlowDocument) => void): string[] {
  const value = linear()
  change(value)
  return codes(value)
}

function task(value: FlowDocument, id: string): Extract<FlowNode, { kind: 'agent' }> {
  const node = value.nodes.find(node => node.id === id)
  if (node?.kind !== 'agent') throw new Error(`missing fixture agent ${id}`)
  return node
}

describe('execution and input relations', () => {
  it('accepts linear execution, ordinary all fan-in, explicit all, and serial review', () => {
    for (const value of [linear(), parallel(), parallel(true), branch(), review()]) expect(validateFlow(value, KNOWN)).toEqual([])
  })

  it('requires explicit user input independently of the start execution signal', () => {
    const value = linear()
    value.edges.push(input('start', 'a'), input('start', 'c'))
    expect(codes(value)).toEqual([])
    expect(analyzeExecutionGraph(value).entries).toEqual(['a'])
  })

  it('does not let input edges establish execution reachability or graph exits', () => {
    const value = linear()
    value.edges = [input('start', 'a'), ...value.edges.slice(1)]
    expect(codes(value)).toEqual(expect.arrayContaining(['start-outgoing', 'no-entry', 'unreachable']))
    expect(mutate((value) => { value.edges[value.edges.length - 1] = input('c', 'end') })).toEqual(expect.arrayContaining(['input-target', 'end-incoming', 'no-path-to-end']))
  })

  it('limits input targets to agents and rejects end as a result source', () => {
    expect(mutate((value) => { value.edges.push(input('a', 'start')) })).toContain('input-target')
    expect(mutate((value) => { value.edges.push(input('end', 'a')) })).toContain('unknown-source')
    const value = branch()
    value.edges.push(input('classify', 'choice'))
    expect(codes(value)).toContain('input-target')
  })

  it('rejects duplicate relationships and redundant execution handoffs', () => {
    expect(mutate((value) => { value.edges.push(execution('a', 'b')) })).toContain('duplicate-edge')
    expect(mutate((value) => { value.edges.push(input('start', 'a'), input('start', 'a')) })).toContain('duplicate-edge')
    expect(mutate((value) => { value.edges.push(input('a', 'b')) })).toContain('redundant-input')
    const value = parallel(true)
    value.edges.push(input('a', 'c'))
    expect(codes(value)).toContain('redundant-input')
  })

  it('keeps an input that one exclusive condition path cannot hand off', () => {
    const value = document(
      [agent('a'), { kind: 'condition', id: 'choice' }, agent('b'), agent('target')],
      [
        execution('start', 'a'), execution('a', 'choice'),
        execution('choice', 'target', 'direct'), execution('choice', 'b', 'indirect'),
        execution('b', 'target'), execution('target', 'end'),
        input('a', 'target'),
      ],
    )
    expect(codes(value)).toEqual([])
  })

  it('keeps an input that an all join cannot always carry', () => {
    const value = document(
      [agent('a'), { kind: 'condition', id: 'choice' }, agent('b'), { kind: 'join', id: 'j', mode: 'all' }, agent('target')],
      [
        execution('start', 'a'), execution('a', 'choice'),
        execution('choice', 'j', 'direct'), execution('choice', 'b', 'indirect'),
        execution('b', 'j'), execution('j', 'target'), execution('target', 'end'),
        input('a', 'target'),
      ],
    )
    expect(codes(value)).toEqual([])
  })

  it('still marks a result every parallel predecessor hands off as redundant', () => {
    const value = document(
      [agent('a'), agent('b'), agent('target')],
      [
        execution('start', 'a'), execution('start', 'b'),
        execution('a', 'target'), execution('b', 'target'), execution('target', 'end'),
        input('a', 'target'),
      ],
    )
    expect(codes(value)).toContain('redundant-input')
  })

  it('permits explicit nontransitive references after ordinary and explicit all merges', () => {
    for (const value of [parallel(), parallel(true)]) {
      value.edges.push(input('a', 'd'), input('b', 'd'))
      expect(codes(value)).toEqual([])
      expect([...analyzeExecutionGraph(value).guaranteedBefore.get('d')!]).toEqual(expect.arrayContaining(['a', 'b', 'c']))
    }
  })

  it('rejects parallel siblings that have not joined before the target', () => {
    const value = parallel()
    value.edges.push(input('a', 'b'))
    expect(codes(value)).toContain('invalid-source')
  })

  it('respects exclusive condition paths rather than accepting arbitrary ancestors', () => {
    const value = branch()
    value.edges.push(input('left', 'after'))
    expect(codes(value)).toContain('invalid-source')
    value.edges.pop()
    value.edges.push(input('classify', 'after'))
    expect(codes(value)).toEqual([])
  })

  it('accepts a condition result as an available reference after a later task', () => {
    const value = branch()
    value.edges.push(input('choice', 'after'))
    expect(codes(value)).toEqual([])
  })

  it('rejects future and self inputs even when a review cycle makes them ancestors', () => {
    const value = review()
    value.edges.push(input('review', 'implement'))
    expect(codes(value)).toContain('invalid-source')
    expect(mutate((value) => { value.edges.push(input('a', 'a')) })).toEqual(expect.arrayContaining(['self-edge', 'invalid-source']))
  })

  it('ignores input-only backreferences when detecting execution loops', () => {
    const value = linear()
    value.edges.push(input('c', 'a'))
    expect(codes(value)).toEqual(['invalid-source'])
    expect(analyzeExecutionGraph(value).loops).toEqual([])
  })
})

describe('serial review regions', () => {
  it('exposes the one entry and conditional return as distinct edge indices', () => {
    expect(analyzeExecutionGraph(review()).loops).toEqual([{
      header: 'implement', nodes: ['implement', 'review', 'verdict'], backEdges: [4], entryEdges: [1],
    }])
  })

  it('detects an unconditional cycle after a condition node', () => {
    const value = branch()
    value.edges.push(execution('merge', 'left'))
    expect(codes(value)).toContain('cycle')
  })

  it('rejects unconditional cycles in disconnected execution components too', () => {
    const value = linear()
    value.nodes.push(agent('x'), agent('y'))
    value.edges.push(execution('x', 'y'), execution('y', 'x'))
    expect(codes(value)).toEqual(expect.arrayContaining(['unreachable', 'cycle']))
  })

  it('rejects parallel fanout or fanin inside a review region without requiring a join node', () => {
    const value = review()
    value.nodes.push(agent('other'))
    value.edges.push(execution('implement', 'other'), execution('other', 'review'))
    expect(codes(value)).toContain('parallel-loop')
  })

  it('rejects explicit all inside a review region and multiple external entries', () => {
    const value = review()
    value.nodes.push({ kind: 'join', id: 'all', mode: 'all' })
    value.edges[2] = execution('implement', 'all')
    value.edges.push(execution('all', 'review'), execution('design', 'all'))
    expect(codes(value)).toEqual(expect.arrayContaining(['parallel-loop', 'loop-entry']))
  })

  it('rejects parallel work escaping a looping task before its condition selects an exit', () => {
    const value = review()
    value.edges.push(execution('implement', 'end'))
    expect(codes(value)).toContain('parallel-loop')
  })

  it('remains bounded when analyzing malformed draft endpoints and self-cycles', () => {
    const value = linear()
    value.edges.push(execution('missing', 'a'), execution('b', 'b'))
    expect(codes(value)).toEqual(expect.arrayContaining(['unknown-node', 'self-edge', 'cycle']))
    expect(analyzeExecutionGraph(value).loops).toHaveLength(1)
  })
})

describe('whole-document validation', () => {
  it('accepts a document with no end without checking end edges', () => {
    const value = linear()
    value.nodes = value.nodes.filter(node => node.kind !== 'end')
    value.edges = value.edges.filter(edge => edge.to !== 'end')
    /* End-edge rules are skipped entirely when the document has no end. */
    expect(codes(value)).toEqual(['end-count'])
  })

  it('collects empty, identity, reference, and terminal problems', () => {
    expect(mutate((value) => { value.name = '' })).toContain('empty-name')
    expect(mutate((value) => { value.nodes = [] })).toContain('empty-document')
    for (const count of [0, 1.5]) expect(mutate((value) => { value.maxIterations = count })).toContain('invalid-max-iterations')
    expect(mutate((value) => { value.nodes.push(agent('bad.id')) })).toContain('invalid-node-id')
    expect(mutate((value) => { value.nodes.push(agent('a')) })).toContain('duplicate-node')
    expect(mutate((value) => { value.nodes = value.nodes.filter(node => node.kind !== 'start') })).toContain('start-count')
    expect(mutate((value) => { value.nodes.push({ kind: 'end', id: 'second' }) })).toContain('end-count')
    expect(mutate((value) => { value.edges.push(execution('a', 'start'), execution('end', 'a')) })).toEqual(expect.arrayContaining(['start-incoming', 'end-outgoing']))
    expect(mutate((value) => { task(value, 'a').instruction = '' })).toContain('empty-instruction')
    expect(mutate((value) => { task(value, 'a').templateId = AgentTemplateId('missing') })).toContain('unknown-template')
  })

  it('requires exactly one agent execution input for condition nodes', () => {
    const value = branch()
    value.edges.push(execution('right', 'choice'))
    expect(codes(value)).toContain('condition-incoming')
    value.edges = value.edges.filter(edge => edge.to !== 'choice')
    expect(codes(value)).toContain('condition-incoming')
    value.edges.push(execution('start', 'choice'))
    expect(codes(value)).toContain('condition-source')
  })

  it('requires a complete unique routing vocabulary only on condition execution outputs', () => {
    const value = branch()
    value.edges = value.edges.filter(edge => edge.from !== 'choice')
    expect(codes(value)).toContain('condition-outgoing')
    value.edges.push(execution('choice', 'left'), execution('choice', 'right', ' '))
    expect(codes(value)).toEqual(expect.arrayContaining(['routing-edges', 'empty-result']))
    value.edges = value.edges.filter(edge => edge.from !== 'choice')
    value.edges.push(execution('choice', 'left', 'same'), execution('choice', 'right', 'same'))
    expect(codes(value)).toContain('duplicate-result')
    value.edges.push({ ...input('classify', 'after'), result: 'wrong' })
    expect(codes(value)).toContain('result-allowed')
    expect(mutate((value) => { value.edges[0]!.result = 'wrong' })).toContain('result-allowed')
  })

  it('allows one condition per deciding agent and at least two execution inputs per join', () => {
    const value = branch()
    value.nodes.push({ kind: 'condition', id: 'other' })
    value.edges.push(execution('classify', 'other'), execution('other', 'end', 'done'))
    expect(codes(value)).toContain('condition-per-agent')
    const joined = parallel(true)
    joined.edges = joined.edges.filter(edge => edge.from !== 'b')
    joined.edges.push(input('b', 'c'))
    expect(codes(joined)).toContain('join-incoming')
  })

  it('keeps interactive clarification as the single execution entry', () => {
    expect(mutate((value) => { task(value, 'a').interactive = true })).toEqual([])
    expect(mutate((value) => { task(value, 'b').interactive = true })).toContain('interactive-entry')
    expect(mutate((value) => { task(value, 'a').interactive = true; task(value, 'b').interactive = true })).toContain('interactive-count')
    const value = parallel()
    task(value, 'a').interactive = true
    expect(codes(value)).toContain('interactive-only-entry')
  })
})

describe('stored graph admission', () => {
  it('keeps the domain version and refuses untyped old edges without changing their values', () => {
    expect(agentFlowDomain.version).toBe(3)
    const value = linear()
    const legacy = { ...value, edges: value.edges.map(({ kind: _kind, ...edge }) => edge) }
    const original = JSON.stringify(legacy)
    const parsed = flowDocumentRecord.safeParse(legacy)
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues.some(issue => issue.message.includes('edge.kind'))).toBe(true)
    expect(JSON.stringify(legacy)).toBe(original)
  })

  it('refuses legacy sources overrides and any joins with actionable errors', () => {
    const value = linear()
    const legacySources = { ...value, nodes: value.nodes.map(node => node.id === 'a' ? { ...node, context: { sources: [] } } : node) }
    const sourceResult = flowDocumentRecord.safeParse(legacySources)
    expect(sourceResult.success).toBe(false)
    if (!sourceResult.success) expect(sourceResult.error.issues.some(issue => issue.message.includes('context.sources'))).toBe(true)
    const joined = parallel(true)
    const legacyAny = { ...joined, nodes: joined.nodes.map(node => node.kind === 'join' ? { ...node, mode: 'any' } : node) }
    const joinResult = flowDocumentRecord.safeParse(legacyAny)
    expect(joinResult.success).toBe(false)
    if (!joinResult.success) expect(joinResult.error.issues.some(issue => issue.message.includes('legacy any'))).toBe(true)
  })

  it('applies graph admission to persisted run snapshots and records exact input executions', () => {
    const value = linear()
    const run = {
      id: 'run', flowId: value.id, snapshot: value, parentSessionId: 'parent', status: 'running', input: 'request', startedAt: value.createdAt,
      nodeRuns: [{ nodeId: 'b', iteration: 0, status: 'running', inputs: [{ nodeId: 'a', iteration: 2 }], userInput: true }],
    }
    expect(agentFlowDomain.tables.runs.valueSchema.parse(run).nodeRuns[0]).toMatchObject({ inputs: [{ nodeId: 'a', iteration: 2 }], userInput: true })
    expect(agentFlowDomain.tables.runs.valueSchema.safeParse({ ...run, snapshot: { ...value, edges: [{ from: 'start', to: 'a' }] } }).success).toBe(false)
  })
})
