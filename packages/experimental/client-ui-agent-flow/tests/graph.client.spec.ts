import { describe, expect, it } from 'vitest'
import type { AgentTemplateId, FlowDocument } from '@deepseek-ai/dsh-experimental-agent-flow/types'
import {
  addAgentNode,
  addConditionNode,
  addJoinNode,
  autoLayout,
  canSetEdgeKind,
  connectNodes,
  edgeKey,
  isRoutableEdge,
  nextNodeId,
  removeEdge,
  removeNode,
  setEdgeResult,
  setEdgeKind,
} from '../src/client/graph.ts'

const TEMPLATE = 'template-1' as AgentTemplateId

/** One minimal valid document: start → step → end. */
function document(): FlowDocument {
  return {
    id: 'flow-1' as FlowDocument['id'],
    name: 'demo',
    maxIterations: 16,
    nodes: [
      { kind: 'start', id: 'start' },
      { kind: 'agent', id: 'step', templateId: TEMPLATE, instruction: 'work' },
      { kind: 'end', id: 'end' },
    ],
    edges: [
      { kind: 'execution', from: 'start', to: 'step' },
      { kind: 'execution', from: 'step', to: 'end' },
    ],
    createdAt: '2026-09-24T00:00:00.000Z',
    updatedAt: '2026-09-24T00:00:00.000Z',
  }
}

describe('flow canvas mapping', () => {
  it('lays nodes out by distance from start and prefers stored positions', () => {
    const flow = document()
    const placed = autoLayout(flow)
    expect(placed.get('start')).toEqual({ x: 80, y: 80 })
    expect(placed.get('step')).toEqual({ x: 80 + 260, y: 80 })
    expect(placed.get('end')).toEqual({ x: 80 + 520, y: 80 })

    const stored = document()
    const step = stored.nodes[1]
    if (step === undefined || step.kind !== 'agent') throw new Error('fixture expects an agent node')
    stored.nodes[1] = { ...step, position: { x: 5, y: 6 } }
    expect(autoLayout(stored).get('step')).toEqual({ x: 5, y: 6 })
  })

  it('places unconnected nodes in the first column without looping forever', () => {
    const flow = document()
    flow.edges = []
    const placed = autoLayout(flow)
    expect(placed.get('start')).toEqual({ x: 80, y: 80 })
    expect(placed.get('step')).toEqual({ x: 80, y: 230 })
    expect(placed.get('end')).toEqual({ x: 80, y: 380 })
  })

  it('lays out a draft without a start node', () => {
    const flow = document()
    flow.nodes = [{ kind: 'agent', id: 'agent1', templateId: TEMPLATE, instruction: 'work' }, { kind: 'end', id: 'end' }]
    flow.edges = []
    expect(autoLayout(flow).get('agent1')).toEqual({ x: 80, y: 80 })
    expect(autoLayout(flow).get('end')).toEqual({ x: 80, y: 230 })
  })

  it('places a diamond join once at its shared depth', () => {
    const flow = document()
    flow.nodes = [
      { kind: 'start', id: 'start' },
      { kind: 'agent', id: 'a', templateId: TEMPLATE, instruction: 'a' },
      { kind: 'agent', id: 'b', templateId: TEMPLATE, instruction: 'b' },
      { kind: 'join', id: 'j', mode: 'all' },
      { kind: 'end', id: 'end' },
    ]
    flow.edges = [
      { kind: 'execution', from: 'start', to: 'a' },
      { kind: 'execution', from: 'start', to: 'b' },
      { kind: 'execution', from: 'a', to: 'j' },
      { kind: 'execution', from: 'b', to: 'j' },
      { kind: 'execution', from: 'j', to: 'end' },
    ]
    const placed = autoLayout(flow)
    expect(placed.get('j')).toEqual({ x: 80 + 520, y: 80 })
    expect(placed.get('end')).toEqual({ x: 80 + 780, y: 80 })
  })

  it('keeps node ids unique and stable', () => {
    const flow = document()
    expect(nextNodeId(flow, 'agent')).toBe('agent1')
    const added = addAgentNode(flow, TEMPLATE)
    expect(added).toBe('agent1')
    expect(flow.nodes.at(-1)).toMatchObject({ kind: 'agent', id: 'agent1', templateId: TEMPLATE })
    expect(nextNodeId(flow, 'agent')).toBe('agent2')
    expect(addJoinNode(flow)).toBe('join1')
    expect(flow.nodes.at(-1)?.kind).toBe('join')
    expect(addConditionNode(flow)).toBe('condition1')
    expect(flow.nodes.at(-1)?.kind).toBe('condition')
    expect(flow.nodes.at(-1)?.position).toBeDefined()
  })

  it('drops a node together with its edges', () => {
    const flow = document()
    removeNode(flow, 'step')
    expect(flow.nodes.map(node => node.id)).toEqual(['start', 'end'])
    expect(flow.edges).toEqual([])
  })

  it('refuses duplicate, self, and start-targeted edges', () => {
    const flow = document()
    expect(connectNodes(flow, 'start', 'end')).toBe(true)
    expect(flow.edges.at(-1)).toEqual({ kind: 'execution', from: 'start', to: 'end' })
    expect(connectNodes(flow, 'start', 'end')).toBe(false)
    expect(connectNodes(flow, 'end', 'end')).toBe(false)
    expect(connectNodes(flow, 'end', 'start')).toBe(false)
    expect(flow.edges).toHaveLength(3)
  })

  it('sets, clears, and removes edges by document position', () => {
    const flow = document()
    flow.nodes = [
      { kind: 'start', id: 'start' },
      { kind: 'agent', id: 'step', templateId: TEMPLATE, instruction: 'work' },
      { kind: 'condition', id: 'c' },
      { kind: 'end', id: 'end' },
    ]
    flow.edges = [
      { kind: 'execution', from: 'start', to: 'step' },
      { kind: 'execution', from: 'step', to: 'c' },
      { kind: 'execution', from: 'c', to: 'end', result: 'done' },
    ]
    expect(isRoutableEdge(flow, 2)).toBe(true)
    expect(isRoutableEdge(flow, 1)).toBe(false)
    expect(isRoutableEdge(flow, 9)).toBe(false)

    setEdgeResult(flow, 2, 'approved')
    expect(flow.edges[2]?.result).toBe('approved')
    setEdgeResult(flow, 2, undefined)
    expect(flow.edges[2]?.result).toBeUndefined()
    setEdgeResult(flow, 7, 'ignored')

    removeEdge(flow, 0)
    expect(flow.edges).toEqual([{ kind: 'execution', from: 'step', to: 'c' }, { kind: 'execution', from: 'c', to: 'end' }])
    expect(edgeKey(3)).toBe('e3')
  })

  it.each([false, true])('lays out routing cycles with stored positions=%s', (stored) => {
    const flow = document()
    flow.nodes = [
      { kind: 'start', id: 'start' },
      { kind: 'agent', id: 'step', templateId: TEMPLATE, instruction: 'work' },
      { kind: 'condition', id: 'c' },
      { kind: 'end', id: 'end' },
    ]
    flow.edges = [
      { kind: 'execution', from: 'start', to: 'step' },
      { kind: 'execution', from: 'step', to: 'c' },
      { kind: 'execution', from: 'c', to: 'step', result: 'again' },
      { kind: 'execution', from: 'c', to: 'end', result: 'done' },
    ]
    if (stored) flow.nodes = flow.nodes.map(node => ({ ...node, position: { x: 17, y: 23 } }))
    const layout = autoLayout(flow)
    expect(layout.size).toBe(4)
    expect(layout.get('end')).toEqual(stored ? { x: 17, y: 23 } : { x: 860, y: 80 })
    expect(addAgentNode(flow, TEMPLATE)).toBe('agent1')
  })

  it('bounds invalid self-loops, cycles through start, and dangling references', () => {
    const flow = document()
    flow.edges.push(
      { kind: 'execution', from: 'step', to: 'step' },
      { kind: 'execution', from: 'end', to: 'start' },
      { kind: 'execution', from: 'step', to: 'missing' },
    )
    expect([...autoLayout(flow).keys()]).toEqual(['start', 'step', 'end'])
  })

  it('ignores input shortcuts and input cycles when placing execution layers', () => {
    const flow = document()
    const before = autoLayout(flow)
    flow.edges.push(
      { kind: 'input', from: 'start', to: 'end' },
      { kind: 'input', from: 'end', to: 'step' },
    )
    expect(autoLayout(flow)).toEqual(before)
  })

  it('adds both start connections independently without duplicating either', () => {
    const flow = document()
    expect(connectNodes(flow, 'start', 'step')).toBe(true)
    expect(flow.edges.at(-1)).toEqual({ kind: 'input', from: 'start', to: 'step' })
    expect(connectNodes(flow, 'start', 'step')).toBe(false)
    expect(setEdgeKind(flow, 0, 'input')).toBe(false)
    expect(setEdgeKind(flow, 2, 'execution')).toBe(false)

    flow.edges = [{ kind: 'input', from: 'start', to: 'step' }]
    expect(connectNodes(flow, 'start', 'step')).toBe(true)
    expect(flow.edges.at(-1)).toEqual({ kind: 'execution', from: 'start', to: 'step' })
  })

  it('changes a connection kind without duplicating direct execution inputs', () => {
    const flow = document()
    flow.nodes.push({ kind: 'agent', id: 'review', templateId: TEMPLATE, instruction: 'review' })
    expect(connectNodes(flow, 'step', 'review')).toBe(true)
    expect(setEdgeKind(flow, 2, 'input')).toBe(true)
    expect(flow.edges[2]).toEqual({ kind: 'input', from: 'step', to: 'review' })
    expect(connectNodes(flow, 'step', 'review')).toBe(false)
    expect(setEdgeKind(flow, 2, 'execution')).toBe(true)
    expect(setEdgeKind(flow, 99, 'input')).toBe(false)
    expect(canSetEdgeKind(flow, 1, 'input')).toBe(false)
    flow.edges.push({ kind: 'input', from: 'step', to: 'review' })
    expect(canSetEdgeKind(flow, 3, 'execution')).toBe(false)
    expect(canSetEdgeKind(flow, 2, 'input')).toBe(false)
  })

  it('permits transparent input sources but reserves routing words for execution', () => {
    const flow = document()
    flow.nodes.push({ kind: 'condition', id: 'c' }, { kind: 'join', id: 'j', mode: 'all' })
    flow.edges.push({ kind: 'execution', from: 'c', to: 'step', result: 'again' })
    expect(setEdgeKind(flow, 2, 'input')).toBe(true)
    expect(flow.edges[2]).toEqual({ kind: 'input', from: 'c', to: 'step' })
    expect(isRoutableEdge(flow, 2)).toBe(false)
    expect(setEdgeKind(flow, 2, 'execution')).toBe(true)
    expect(isRoutableEdge(flow, 2)).toBe(true)
    flow.edges.push({ kind: 'execution', from: 'j', to: 'step' })
    expect(setEdgeKind(flow, 3, 'input')).toBe(true)
    expect(setEdgeKind(flow, 1, 'input')).toBe(false)
    expect(connectNodes(flow, 'missing', 'step')).toBe(false)
    expect(connectNodes(flow, 'end', 'step')).toBe(false)
    flow.edges.push({ kind: 'execution', from: 'missing', to: 'step' })
    expect(canSetEdgeKind(flow, 4, 'input')).toBe(false)
  })
})

describe('edge kind editing', () => {
  it('refuses an edge index the document does not carry', () => {
    expect(canSetEdgeKind(document(), 99, 'input')).toBe(false)
  })
})
