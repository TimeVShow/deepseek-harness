/**
 * Pure mapping between flow documents and canvas elements: node placement,
 * edge keys, and the draft mutations the canvas performs.
 * @module
 */

import type { AgentTemplateId, FlowDocument, FlowEdge, FlowNode } from '@deepseek-ai/dsh-experimental-agent-flow/types'

/** Canvas geometry: column width and row height for the automatic layout. */
const COLUMN = 260
const ROW = 150

/** One node's placement on the canvas. */
export interface Point {
  readonly x: number
  readonly y: number
}

/**
 * Build the stable canvas key of one edge.
 * @param index - the edge's document position.
 * @returns the canvas key.
 */
export function edgeKey(index: number): string {
  return `e${index}`
}

/**
 * Place nodes by their shortest execution distance from start. Each reachable
 * id is visited once, including in unfinished or cyclic drafts; input edges do
 * not change placement. Stored positions take precedence.
 * @param document - flow being laid out.
 * @returns one point per node, stored positions preferred.
 */
export function autoLayout(document: FlowDocument): Map<string, Point> {
  const outgoing = new Map<string, string[]>()
  for (const edge of document.edges) {
    if (edge.kind !== 'execution') continue
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to])
  }
  const start = document.nodes.find(node => node.kind === 'start')
  const depth = new Map<string, number>()
  if (start !== undefined) {
    const queue = [{ id: start.id, column: 0 }]
    depth.set(start.id, 0)
    for (const { id, column } of queue) {
      for (const next of outgoing.get(id) ?? []) {
        if (depth.has(next)) continue
        depth.set(next, column + 1)
        queue.push({ id: next, column: column + 1 })
      }
    }
  }
  const rows = new Map<number, number>()
  const placed = new Map<string, Point>()
  for (const node of document.nodes) {
    if (node.position !== undefined) {
      placed.set(node.id, node.position)
      continue
    }
    const column = depth.get(node.id) ?? 0
    const row = rows.get(column) ?? 0
    rows.set(column, row + 1)
    placed.set(node.id, { x: 80 + column * COLUMN, y: 80 + row * ROW })
  }
  return placed
}

/**
 * Pick an unused node id of the given kind.
 * @param document - document whose ids must stay unique.
 * @param kind - node kind naming the id prefix.
 * @returns the first unused id.
 */
export function nextNodeId(document: FlowDocument, kind: FlowNode['kind']): string {
  for (let index = 1; ; index++) {
    const candidate = `${kind}${index}`
    if (!document.nodes.some(node => node.id === candidate)) return candidate
  }
}

/** One free canvas slot below everything already placed. */
function nextSlot(draft: FlowDocument): Point {
  const layout = autoLayout(draft)
  const lowest = [...layout.values()].reduce((max, point) => Math.max(max, point.y), 0)
  return { x: 80, y: lowest + ROW }
}

/**
 * Append one agent node to the draft.
 * @param draft - document mutated in place.
 * @param templateId - template the node agent starts from.
 * @returns the new node's id.
 */
export function addAgentNode(draft: FlowDocument, templateId: AgentTemplateId): string {
  const id = nextNodeId(draft, 'agent')
  draft.nodes = [...draft.nodes, { kind: 'agent', id, templateId, instruction: 'Describe this step.', position: nextSlot(draft) }]
  return id
}

/**
 * Append one join node to the draft.
 * @param draft - document mutated in place.
 * @returns the new node's id.
 */
export function addJoinNode(draft: FlowDocument): string {
  const id = nextNodeId(draft, 'join')
  draft.nodes = [...draft.nodes, { kind: 'join', id, mode: 'all', position: nextSlot(draft) }]
  return id
}

/**
 * Append one condition node to the draft.
 * @param draft - document mutated in place.
 * @returns the new node's id.
 */
export function addConditionNode(draft: FlowDocument): string {
  const id = nextNodeId(draft, 'condition')
  draft.nodes = [...draft.nodes, { kind: 'condition', id, position: nextSlot(draft) }]
  return id
}

/**
 * Remove one node together with every edge that touched it.
 * @param draft - document mutated in place.
 * @param id - node identity to remove.
 */
export function removeNode(draft: FlowDocument, id: string): void {
  draft.nodes = draft.nodes.filter(node => node.id !== id)
  draft.edges = draft.edges.filter(edge => edge.from !== id && edge.to !== id)
}

/**
 * Connect two nodes with an execution edge. A second start-to-agent connection
 * adds the missing kind so the request can be referenced independently of
 * activation. Other pairs admit one edge only.
 * @param draft - document mutated in place.
 * @param from - source node id.
 * @param to - target node id.
 * @returns whether the edge was added.
 */
export function connectNodes(draft: FlowDocument, from: string, to: string): boolean {
  if (from === to) return false
  const source = draft.nodes.find(node => node.id === from)
  const target = draft.nodes.find(node => node.id === to)
  if (source === undefined || target === undefined || source.kind === 'end' || target.kind === 'start') return false
  const pair = draft.edges.filter(edge => edge.from === from && edge.to === to)
  const existing = pair[0]
  let kind: FlowEdge['kind'] = 'execution'
  if (existing !== undefined) {
    if (source.kind !== 'start' || target.kind !== 'agent' || pair.length !== 1) return false
    kind = existing.kind === 'execution' ? 'input' : 'execution'
  }
  draft.edges = [...draft.edges, { from, to, kind }]
  return true
}

/**
 * Check whether an edge can take one kind without duplicating another edge.
 * Input edges target agents and may reference any source except end.
 * @param document - edited graph.
 * @param index - edge's document position.
 * @param kind - desired relationship.
 * @returns whether the edit can be applied.
 */
export function canSetEdgeKind(document: FlowDocument, index: number, kind: FlowEdge['kind']): boolean {
  const edge = document.edges[index]
  if (edge === undefined) return false
  const source = document.nodes.find(node => node.id === edge.from)
  const target = document.nodes.find(node => node.id === edge.to)
  if (source === undefined || target === undefined) return false
  if (kind === 'input' && (source.kind === 'end' || target.kind !== 'agent')) return false
  return !document.edges.some((other, position) => position !== index && other.from === edge.from && other.to === edge.to
    && (other.kind === kind || source.kind !== 'start'))
}

/**
 * Change an edge's kind, clearing routing words from input edges.
 * @param draft - document mutated in place.
 * @param index - edge's document position.
 * @param kind - desired relationship.
 * @returns whether the edit was accepted.
 */
export function setEdgeKind(draft: FlowDocument, index: number, kind: FlowEdge['kind']): boolean {
  const edge = draft.edges[index]
  if (edge === undefined || !canSetEdgeKind(draft, index, kind)) return false
  const next: FlowEdge = { ...edge, kind }
  if (kind === 'input') delete next.result
  draft.edges = [...draft.edges.slice(0, index), next, ...draft.edges.slice(index + 1)]
  return true
}

/**
 * Set or clear one edge's routing word.
 * @param draft - document mutated in place.
 * @param index - the edge's document position.
 * @param result - routing word to set, or undefined to clear it.
 */
export function setEdgeResult(draft: FlowDocument, index: number, result: string | undefined): void {
  const edge = draft.edges[index]
  if (edge === undefined) return
  const next = { ...edge }
  if (result === undefined) delete next.result
  else next.result = result
  draft.edges = [...draft.edges.slice(0, index), next, ...draft.edges.slice(index + 1)]
}

/**
 * Remove one edge.
 * @param draft - document mutated in place.
 * @param index - the edge's document position.
 */
export function removeEdge(draft: FlowDocument, index: number): void {
  draft.edges = draft.edges.filter((_edge, position) => position !== index)
}

/**
 * Report whether one edge leaves a condition node, the only edges that carry a routing word.
 * @param document - document the edge belongs to.
 * @param index - the edge's document position.
 * @returns whether the edge is routable.
 */
export function isRoutableEdge(document: FlowDocument, index: number): boolean {
  const edge = document.edges[index]
  if (edge === undefined) return false
  return edge.kind === 'execution' && document.nodes.find(node => node.id === edge.from)?.kind === 'condition'
}
