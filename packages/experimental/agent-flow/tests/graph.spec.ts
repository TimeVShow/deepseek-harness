/**
 * Execution-only analysis: adjacency, strongly connected regions, and the
 * first-pass guarantees that decide whether an input is redundant.
 * @module
 */

import { describe, expect, it } from 'vitest'
import { AgentTemplateId } from '../src/types.ts'
import { analyzeExecutionGraph } from '../src/graph.ts'
import type { FlowEdge, FlowNode } from '../src/spec.ts'

/** Build a document from its nodes and edges. */
function graph(nodes: FlowNode[], edges: FlowEdge[]): { nodes: FlowNode[]; edges: FlowEdge[] } {
  return { nodes, edges }
}

const start = (): FlowNode => ({ kind: 'start', id: 'start' })
const end = (): FlowNode => ({ kind: 'end', id: 'end' })
const agent = (id: string): FlowNode => ({ kind: 'agent', id, templateId: AgentTemplateId('template-a'), instruction: id })
const condition = (id: string): FlowNode => ({ kind: 'condition', id })
const join = (id: string): FlowNode => ({ kind: 'join', id, mode: 'all' })
const run = (from: string, to: string): FlowEdge => ({ kind: 'execution', from, to })
const input = (from: string, to: string): FlowEdge => ({ kind: 'input', from, to })

describe('analyzeExecutionGraph', () => {
  it('reads execution adjacency, entries, and first-pass ancestry on a linear graph', () => {
    const analysis = analyzeExecutionGraph(graph(
      [start(), agent('a1'), end()],
      [run('start', 'a1'), run('a1', 'end')],
    ))

    expect(analysis.entries).toEqual(['a1'])
    expect(analysis.loops).toEqual([])
    expect(analysis.outgoing.get('a1')).toEqual([1])
    expect(analysis.guaranteedBefore.get('end')).toEqual(new Set(['a1', 'start']))
    expect([...analysis.guaranteedHandoffs.get('end') ?? []]).toEqual(['a1'])
  })

  it('ignores input relations and dangling endpoints when scheduling', () => {
    const analysis = analyzeExecutionGraph(graph(
      [start(), agent('a1'), end()],
      [run('start', 'a1'), input('start', 'a1'), run('a1', 'end'), run('ghost', 'end'), run('a1', 'ghost')],
    ))

    /* Neither the input line nor a dangling endpoint schedules anything. */
    expect(analysis.entries).toEqual(['a1'])
    expect(analysis.outgoing.get('a1')).toEqual([2])
    expect(analysis.incoming.get('end')).toEqual([2])
  })

  it('merges every activated branch at an all join', () => {
    const analysis = analyzeExecutionGraph(graph(
      [start(), agent('a1'), agent('a2'), join('j'), end()],
      [run('start', 'a1'), run('start', 'a2'), run('a1', 'j'), run('a2', 'j'), run('j', 'end')],
    ))

    expect(analysis.entries).toEqual(['a1', 'a2'])
    expect([...analysis.guaranteedHandoffs.get('j') ?? []].sort()).toEqual(['a1', 'a2'])
    expect(analysis.guaranteedBefore.get('j')).toEqual(new Set(['a1', 'a2', 'start']))
  })

  it('keeps a result carried on only one exclusive route out of the join guarantee', () => {
    const analysis = analyzeExecutionGraph(graph(
      [start(), condition('c'), agent('a1'), agent('a2'), join('j'), end()],
      [run('start', 'c'), run('c', 'a1'), run('c', 'a2'), run('a1', 'j'), run('a2', 'j'), run('j', 'end')],
    ))

    /* Each branch result reaches the join on its own route only, never both. */
    expect([...analysis.guaranteedHandoffs.get('j') ?? []]).toEqual([])
    expect(analysis.guaranteedBefore.get('a1')).toEqual(new Set(['c', 'start']))
    expect(analysis.guaranteedBefore.get('a2')).toEqual(new Set(['c', 'start']))
  })

  it('merges both routes of one condition back into the same join', () => {
    const analysis = analyzeExecutionGraph(graph(
      [start(), condition('c'), agent('a1'), agent('a2'), join('j'), end()],
      [run('start', 'c'), run('c', 'a1'), run('c', 'a2'), run('a1', 'j'), run('a2', 'j'), run('j', 'end')],
    ))

    /* Every route of the one condition reaches the join, so the join always
       runs, but no branch's own result is guaranteed there. */
    expect([...analysis.guaranteedHandoffs.get('j') ?? []]).toEqual([])
    expect(analysis.guaranteedBefore.get('j')).toEqual(new Set(['c', 'start']))
  })

  it('combines routes from two different conditions meeting at one join', () => {
    const analysis = analyzeExecutionGraph(graph(
      [start(), condition('c1'), condition('c2'), agent('a1'), agent('a2'), join('j'), end()],
      [
        run('start', 'c1'), run('c1', 'c2'), run('c1', 'a1'), run('c2', 'a2'),
        run('a1', 'j'), run('a2', 'j'), run('j', 'end'),
      ],
    ))

    /* One branch is chosen by c1 and the other by c2, so neither result is
       guaranteed at the join even though it always runs. */
    expect([...analysis.guaranteedHandoffs.get('j') ?? []]).toEqual([])
    expect(analysis.guaranteedBefore.get('j')).toEqual(new Set(['c1', 'start']))
  })

  it('tolerates a condition node with no execution inbound in an editing draft', () => {
    const analysis = analyzeExecutionGraph(graph(
      [start(), condition('c'), agent('a1'), end()],
      [run('start', 'a1'), run('c', 'a1'), run('a1', 'end')],
    ))

    expect(analysis.incoming.get('c')).toEqual([])
    /* The condition forwards nothing it never received, so a1 gets no result. */
    expect([...analysis.guaranteedHandoffs.get('a1') ?? []]).toEqual([])
  })

  it('carries a predecessor result through a condition node to the review target', () => {
    const analysis = analyzeExecutionGraph(graph(
      [start(), agent('eng'), agent('rev'), condition('verdict'), end()],
      [
        run('start', 'eng'), run('eng', 'rev'), run('rev', 'verdict'),
        run('verdict', 'eng'), run('verdict', 'end'),
      ],
    ))

    /* One region, entered through the engineer, with the verdict's route back. */
    expect(analysis.loops).toHaveLength(1)
    const loop = analysis.loops[0]
    expect(loop?.nodes).toEqual(['eng', 'rev', 'verdict'])
    expect(loop?.header).toBe('eng')
    expect(loop?.backEdges.length).toBeGreaterThan(0)
    expect(loop?.entryEdges.length).toBeGreaterThan(0)
    /* First-pass guarantees cut the return edge, so the reviewer never claims a
       future-round result it has not received. */
    expect(analysis.guaranteedHandoffs.get('rev')).toEqual(new Set(['eng']))
  })

  it('treats an execution self edge as a loop', () => {
    const analysis = analyzeExecutionGraph(graph(
      [start(), agent('retry'), end()],
      [run('start', 'retry'), run('retry', 'retry'), run('retry', 'end')],
    ))

    expect(analysis.loops).toHaveLength(1)
    expect(analysis.loops[0]?.header).toBe('retry')
    expect(analysis.loops[0]?.nodes).toEqual(['retry'])
  })

  it('yields a bounded partial analysis for a cycle no node can enter', () => {
    const analysis = analyzeExecutionGraph(graph(
      [start(), agent('a1'), agent('a2'), end()],
      [run('start', 'end'), run('a1', 'a2'), run('a2', 'a1')],
    ))

    expect(analysis.loops).toHaveLength(1)
    /* Nothing outside the cycle was queued, so no node claims a guarantee. */
    expect([...analysis.guaranteedBefore.get('a1') ?? []]).toEqual([])
    expect(analysis.guaranteedBefore.get('end')).toEqual(new Set(['start']))
  })

  it('reports a start with no execution edge as having no entries', () => {
    const analysis = analyzeExecutionGraph(graph([start(), end()], [input('start', 'end')]))

    expect(analysis.entries).toEqual([])
    expect(analysis.loops).toEqual([])
  })
})
