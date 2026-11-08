/** Complete execution-graph validation and availability checks for additional inputs. */

import type { FlowDocument } from './spec.ts'
import type { AgentTemplateId } from './types.ts'
import { analyzeExecutionGraph, type ExecutionGraphAnalysis } from './graph.ts'

/** Stable category of one rejected document rule; clients map codes to guidance. */
export type FlowProblemCode =
  | 'empty-name' | 'empty-document' | 'invalid-max-iterations' | 'invalid-node-id'
  | 'duplicate-node' | 'unknown-node' | 'duplicate-edge' | 'self-edge'
  | 'start-count' | 'end-count' | 'start-incoming' | 'end-outgoing' | 'start-outgoing' | 'end-incoming'
  | 'no-entry' | 'cycle' | 'unreachable' | 'no-path-to-end' | 'empty-instruction' | 'unknown-template'
  | 'unknown-source' | 'invalid-source' | 'input-target' | 'redundant-input'
  | 'result-allowed' | 'empty-result' | 'duplicate-result' | 'routing-edges'
  | 'condition-incoming' | 'condition-source' | 'condition-outgoing' | 'condition-per-agent'
  | 'interactive-count' | 'interactive-entry' | 'interactive-only-entry' | 'join-incoming'
  | 'parallel-loop' | 'loop-entry'

/** One rejected rule with its location, when the rule names one. */
export interface FlowProblem {
  readonly code: FlowProblemCode
  readonly message: string
  readonly nodeId?: string | undefined
  readonly edgeIndex?: number | undefined
}

const NODE_ID_RE = /^[A-Za-z0-9_-]+$/

/**
 * Validate the complete execution graph and every extra input reference.
 * Input edges cannot establish reachability or supply missing execution order.
 * @param document - candidate document; identity and timestamps are not checked here.
 * @param knownTemplateIds - template identities currently saved.
 * @returns all violations, including node or edge locations when applicable.
 */
export function validateFlow(document: FlowDocument, knownTemplateIds: ReadonlySet<AgentTemplateId>): FlowProblem[] {
  const problems: FlowProblem[] = []
  const add = (code: FlowProblemCode, message: string, nodeId?: string, edgeIndex?: number): void => {
    problems.push({ code, message, ...nodeId === undefined ? {} : { nodeId }, ...edgeIndex === undefined ? {} : { edgeIndex } })
  }
  if (!document.name.trim()) add('empty-name', 'flow name must not be empty')
  if (!Number.isInteger(document.maxIterations) || document.maxIterations < 1) add('invalid-max-iterations', 'maxIterations must be a positive integer')
  if (document.nodes.length === 0) {
    add('empty-document', 'a flow needs at least one node')
    return problems
  }
  const nodes = new Map(document.nodes.map(node => [node.id, node]))
  const seenNodes = new Set<string>()
  for (const node of document.nodes) {
    if (!NODE_ID_RE.test(node.id)) add('invalid-node-id', `node id "${node.id}" must match ${NODE_ID_RE}`, node.id)
    if (seenNodes.has(node.id)) add('duplicate-node', `duplicate node "${node.id}"`, node.id)
    seenNodes.add(node.id)
  }
  const graph = analyzeExecutionGraph(document)
  const seenEdges = new Set<string>()
  document.edges.forEach((edge, index) => {
    const from = nodes.get(edge.from)
    const to = nodes.get(edge.to)
    if (from === undefined || to === undefined) {
      add('unknown-node', `edge ${index} references a missing node ("${edge.from}" -> "${edge.to}")`, undefined, index)
      return
    }
    if (edge.from === edge.to) add('self-edge', `edge ${index} connects "${edge.from}" to itself`, undefined, index)
    const key = `${edge.kind}:${edge.from}:${edge.to}`
    if (seenEdges.has(key)) add('duplicate-edge', `duplicate ${edge.kind} edge "${edge.from}" -> "${edge.to}"`, undefined, index)
    seenEdges.add(key)
    if (edge.kind === 'input') {
      if (to.kind !== 'agent') add('input-target', 'an input edge must target an agent node', to.id, index)
      if (from.kind === 'end') add('unknown-source', 'an end node produces no input result', from.id, index)
      if (edge.result !== undefined) add('result-allowed', 'an input edge cannot carry a routing word', undefined, index)
      return
    }
    if (from.kind === 'end') add('end-outgoing', 'an end node must not have execution outputs', from.id, index)
    if (to.kind === 'start') add('start-incoming', 'a start node must not have execution inputs', to.id, index)
    if (from.kind !== 'condition' && edge.result !== undefined) add('result-allowed', 'only a condition execution edge may carry a routing word', from.id, index)
  })
  const starts = document.nodes.filter(node => node.kind === 'start')
  const ends = document.nodes.filter(node => node.kind === 'end')
  if (starts.length !== 1) add('start-count', `a flow needs exactly one start node, found ${starts.length}`)
  if (ends.length !== 1) add('end-count', `a flow needs exactly one end node, found ${ends.length}`)
  const start = starts[0]
  const end = ends[0]
  if (start !== undefined) {
    /* v8 ignore next 1 -- the adjacency map is initialized for every node identity. */
    if ((graph.outgoing.get(start.id)?.length ?? 0) === 0) add('start-outgoing', 'start needs at least one execution output', start.id)
    if (graph.entries.length === 0) add('no-entry', 'a flow needs an execution entry from start', start.id)
    const reachable = reach(start.id, graph.outgoing, document, false)
    for (const node of document.nodes) if (!reachable.has(node.id)) add('unreachable', `node "${node.id}" has no execution path from start`, node.id)
  }
  if (end !== undefined) {
    /* v8 ignore next 1 -- the adjacency map is initialized for every node identity. */
    if ((graph.incoming.get(end.id)?.length ?? 0) === 0) add('end-incoming', 'end needs at least one execution input', end.id)
    const reaching = reach(end.id, graph.incoming, document, true)
    for (const node of document.nodes) if (!reaching.has(node.id)) add('no-path-to-end', `node "${node.id}" has no execution path to end`, node.id)
  }
  validateLoops(document, graph, problems)
  let interactiveCount = 0
  for (const node of document.nodes) {
    /* v8 ignore next 1 -- the adjacency map is initialized for every node identity. */
    const ins = graph.incoming.get(node.id) ?? []
    /* v8 ignore next 1 -- the adjacency map is initialized for every node identity. */
    const outs = graph.outgoing.get(node.id) ?? []
    if (node.kind === 'agent') {
      if (!node.instruction.trim()) add('empty-instruction', `agent "${node.id}" needs an instruction`, node.id)
      if (!knownTemplateIds.has(node.templateId)) add('unknown-template', `agent "${node.id}" references an unsaved template`, node.id)
      if (outs.filter((index) => {
        const edge = document.edges[index]
        return edge !== undefined && nodes.get(edge.to)?.kind === 'condition'
      }).length > 1) add('condition-per-agent', 'one agent may feed at most one condition node', node.id)
      if (node.interactive === true) {
        interactiveCount += 1
        if (!graph.entries.includes(node.id)) add('interactive-entry', 'an interactive node must be an execution entry from start', node.id)
      }
    }
    if (node.kind === 'join' && ins.length < 2) add('join-incoming', `join "${node.id}" needs at least two execution inputs`, node.id)
    if (node.kind !== 'condition') continue
    if (ins.length !== 1) add('condition-incoming', 'a condition needs exactly one execution input', node.id)
    else {
      const source = ins[0]
      /* v8 ignore next 1 -- the branch above guarantees exactly one execution input. */
      const edge = source === undefined ? undefined : document.edges[source]
      if (edge === undefined || nodes.get(edge.from)?.kind !== 'agent') add('condition-source', 'a condition execution input must come from an agent', node.id)
    }
    if (outs.length === 0) add('condition-outgoing', 'a condition needs at least one execution output', node.id)
    const words = new Set<string>()
    for (const index of outs) {
      const word = document.edges[index]?.result
      if (word === undefined) add('routing-edges', 'every condition execution output needs a routing word', node.id, index)
      else if (!word.trim()) add('empty-result', 'routing words must not be empty', node.id, index)
      else if (words.has(word)) add('duplicate-result', `condition "${node.id}" repeats routing word "${word}"`, node.id, index)
      if (word !== undefined) words.add(word)
    }
  }
  if (interactiveCount > 1) add('interactive-count', 'a flow admits at most one interactive node')
  if (interactiveCount > 0 && graph.entries.length > 1) add('interactive-only-entry', 'an interactive node must be the only execution entry')
  validateInputs(document, graph, problems)
  return problems
}

/** Traverse only the supplied execution adjacency. */
function reach(start: string, adjacency: ReadonlyMap<string, readonly number[]>, document: FlowDocument, reverse: boolean): Set<string> {
  const found = new Set<string>()
  const pending = [start]
  while (pending.length > 0) {
    const id = pending.pop()
    /* v8 ignore next 1 -- the loop condition guarantees an identity to pop. */
    if (id === undefined) break
    if (found.has(id)) continue
    found.add(id)
    /* v8 ignore next 1 -- the adjacency map is initialized for every node identity. */
    for (const index of adjacency.get(id) ?? []) {
      const edge = document.edges[index]
      /* v8 ignore next 1 -- adjacency indices address this document’s own edge list. */
      if (edge === undefined) continue
      pending.push(reverse ? edge.from : edge.to)
    }
  }
  return found
}

/** Reject unconditional cycles in every component and nonserial cyclic regions. */
function validateLoops(document: FlowDocument, graph: ExecutionGraphAnalysis, problems: FlowProblem[]): void {
  const nodes = new Map(document.nodes.map(node => [node.id, node]))
  const remaining = new Map(document.nodes.map(node => [node.id, 0]))
  const adjacency = new Map<string, string[]>()
  for (const edge of document.edges) {
    if (edge.kind !== 'execution' || nodes.get(edge.from)?.kind === 'condition' || !nodes.has(edge.from) || !nodes.has(edge.to)) continue
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to])
    /* v8 ignore next 1 -- the adjacency map is initialized for every node identity. */
    remaining.set(edge.to, (remaining.get(edge.to) ?? 0) + 1)
  }
  const queue = [...remaining].filter(([, degree]) => degree === 0).map(([id]) => id)
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor]
    /* v8 ignore next 1 -- the loop condition guarantees an identity to pop. */
    if (id === undefined) break
    for (const next of adjacency.get(id) ?? []) {
      /* v8 ignore next 1 -- the adjacency map is initialized for every node identity. */
      remaining.set(next, (remaining.get(next) ?? 0) - 1)
      if (remaining.get(next) === 0) queue.push(next)
    }
  }
  const cyclic = [...remaining].find(([, degree]) => degree > 0)
  if (cyclic !== undefined) problems.push({ code: 'cycle', message: `execution cycle without a condition through "${cyclic[0]}"`, nodeId: cyclic[0] })
  for (const loop of graph.loops) {
    const members = new Set(loop.nodes)
    const entries = new Set(loop.entryEdges.flatMap((index) => {
      const edge = document.edges[index]
      /* v8 ignore next 1 -- entry indices address this document’s own edge list. */
      return edge === undefined ? [] : [edge.to]
    }))
    /* v8 ignore start -- the loop shape rules out reading a missing back edge. */
    if (entries.size !== 1 || nodes.get(loop.header)?.kind !== 'agent'
      || loop.backEdges.length !== 1 || nodes.get(document.edges[loop.backEdges[0] ?? -1]?.from ?? '')?.kind !== 'condition') {
      /* v8 ignore stop */
      problems.push({ code: 'loop-entry', message: 'a review loop needs one agent entry and one conditional return to that entry', nodeId: loop.header })
    }
    const parallel = loop.nodes.find((id) => {
      const node = nodes.get(id)
      /* v8 ignore next 1 -- loop members are node identities of this document. */
      if (node === undefined) return false
      /* v8 ignore next 1 -- the adjacency map is initialized for every node identity. */
      const ins = (graph.incoming.get(id) ?? []).filter((index) => {
        const edge = document.edges[index]
        return edge !== undefined && members.has(edge.from)
      })
      /* v8 ignore next 1 -- the adjacency map is initialized for every node identity. */
      const outs = graph.outgoing.get(id) ?? []
      const internal = outs.filter((index) => {
        const edge = document.edges[index]
        return edge !== undefined && members.has(edge.to)
      })
      return node.kind === 'join' || ins.length !== 1 || internal.length !== 1
        || (node.kind !== 'condition' && outs.length !== 1)
    })
    if (parallel !== undefined) problems.push({ code: 'parallel-loop', message: 'parallel forks and merges inside review loops are unsupported', nodeId: parallel })
  }
}

/** Validate explicit references without extending execution order or transitive task results. */
function validateInputs(document: FlowDocument, graph: ExecutionGraphAnalysis, problems: FlowProblem[]): void {
  const nodes = new Map(document.nodes.map(node => [node.id, node]))
  const origins = (id: string, visited = new Set<string>()): Set<string> => {
    /* v8 ignore next 1 -- the recursion descends acyclic execution relations. */
    if (visited.has(id)) return new Set()
    visited.add(id)
    const kind = nodes.get(id)?.kind
    if (kind === 'agent') return new Set([id])
    /* v8 ignore next 1 -- an origin chain reaches an agent before any non-producing kind. */
    if (kind !== 'condition' && kind !== 'join') return new Set()
    /* v8 ignore next 1 -- the adjacency map is initialized for every node identity. */
    return new Set((graph.incoming.get(id) ?? []).flatMap((index) => {
      const edge = document.edges[index]
      /* v8 ignore next 1 -- adjacency indices address this document’s own edge list. */
      return edge === undefined ? [] : [...origins(edge.from, new Set(visited))]
    }))
  }
  document.edges.forEach((edge, edgeIndex) => {
    if (edge.kind !== 'input' || !nodes.has(edge.from) || nodes.get(edge.to)?.kind !== 'agent') return
    if (!graph.guaranteedBefore.get(edge.to)?.has(edge.from)) {
      problems.push({ code: 'invalid-source', message: `input "${edge.from}" is not guaranteed before "${edge.to}" on every execution path`, nodeId: edge.to, edgeIndex })
      return
    }
    if (nodes.get(edge.from)?.kind === 'start') return
    const supplied = origins(edge.from)
    // Redundant only when every activation path into the target already hands
    // off each supplied result. Transparent nodes merge possible sources, so
    // their union cannot answer this; the predicate analysis can.
    const guaranteed = graph.guaranteedHandoffs.get(edge.to)
    if (supplied.size > 0 && [...supplied].every(id => guaranteed?.has(id) === true)) {
      problems.push({ code: 'redundant-input', message: `execution edges already hand off input "${edge.from}" to "${edge.to}"`, nodeId: edge.to, edgeIndex })
    }
  })
}
