/** Execution-only graph analysis shared by validation and the graph executor. */

import type { FlowDocument } from './spec.ts'

/** One strongly connected execution region; validation admits only serial review loops. */
export interface ExecutionLoop {
  /** Node entered on both the first pass and a later review return. */
  readonly header: string
  /** Node identities in document order. */
  readonly nodes: readonly string[]
  /** Execution-edge indices returning from this region to its header. */
  readonly backEdges: readonly number[]
  /** Execution-edge indices entering the region from outside it. */
  readonly entryEdges: readonly number[]
}

/** Execution adjacency and iteration regions; edge indices address the original document. */
export interface ExecutionGraphAnalysis {
  readonly incoming: ReadonlyMap<string, readonly number[]>
  readonly outgoing: ReadonlyMap<string, readonly number[]>
  /** Targets of the start node's execution edges. */
  readonly entries: readonly string[]
  readonly loops: readonly ExecutionLoop[]
  /** Nodes guaranteed to have completed before each target's first execution. */
  readonly guaranteedBefore: ReadonlyMap<string, ReadonlySet<string>>
  /**
   * Task results each target is guaranteed to receive from its execution
   * predecessors on every activation path. Condition choices and transparent
   * nodes are resolved path by path: a result carried on only some exclusive
   * branch is absent here.
   */
  readonly guaranteedHandoffs: ReadonlyMap<string, ReadonlySet<string>>
}

type Graph = Pick<FlowDocument, 'nodes' | 'edges'>

/**
 * Analyze execution relations without treating input references as scheduling.
 * Invalid editing drafts remain bounded and yield partial analysis; callers
 * must validate the document before executing its loop regions.
 * @param document - nodes and explicitly typed relations.
 * @returns execution adjacency, cyclic regions, and first-pass input availability.
 */
export function analyzeExecutionGraph(document: Graph): ExecutionGraphAnalysis {
  const ids = new Set(document.nodes.map(node => node.id))
  const incoming = new Map<string, number[]>([...ids].map(id => [id, []]))
  const outgoing = new Map<string, number[]>([...ids].map(id => [id, []]))
  document.edges.forEach((edge, index) => {
    if (edge.kind !== 'execution' || !ids.has(edge.from) || !ids.has(edge.to)) return
    incoming.get(edge.to)?.push(index)
    outgoing.get(edge.from)?.push(index)
  })
  const components = stronglyConnected(document, outgoing)
  const loops = components.filter(component => component.length > 1 || component.some(id =>
    outgoing.get(id)?.some(index => document.edges[index]?.to === id),
  )).map((component): ExecutionLoop => {
    const members = new Set(component)
    const nodes = document.nodes.filter(node => members.has(node.id)).map(node => node.id)
    /* v8 ignore next 1 -- the adjacency map is initialized for every node identity. */
    const entryEdges = nodes.flatMap(id => incoming.get(id) ?? [])
      .filter((index) => {
        const edge = document.edges[index]
        return edge !== undefined && !members.has(edge.from)
      })
    /* v8 ignore next 1 -- a loop region always contains at least one node. */
    const header = document.edges[entryEdges[0] ?? -1]?.to ?? nodes[0] ?? ''
    /* v8 ignore next 1 -- the adjacency map is initialized for every node identity. */
    const backEdges = (incoming.get(header) ?? []).filter((index) => {
      const edge = document.edges[index]
      return edge !== undefined && members.has(edge.from)
    })
    return { header, nodes, backEdges, entryEdges }
  })
  const starts = new Set(document.nodes.filter(node => node.kind === 'start').map(node => node.id))
  const entries = [...new Set(document.edges.filter(edge => edge.kind === 'execution' && starts.has(edge.from)).map(edge => edge.to))]
  return { incoming, outgoing, entries, loops, ...firstPass(document, incoming, outgoing, loops) }
}

/** Iterative Kosaraju traversal also handles incomplete or cyclic editing drafts. */
function stronglyConnected(document: Graph, outgoing: ReadonlyMap<string, readonly number[]>): string[][] {
  const reverse = new Map<string, string[]>()
  for (const [from, edges] of outgoing) {
    for (const index of edges) {
      const edge = document.edges[index]
      /* v8 ignore next 1 -- reverse indices come from this document’s own edge list. */
      if (edge === undefined) continue
      reverse.set(edge.to, [...(reverse.get(edge.to) ?? []), from])
    }
  }
  const visited = new Set<string>()
  const ordered: string[] = []
  for (const node of document.nodes) {
    const stack: { id: string; done: boolean }[] = [{ id: node.id, done: false }]
    while (stack.length > 0) {
      const frame = stack.pop()
      /* v8 ignore next 1 -- the loop condition guarantees a frame to pop. */
      if (frame === undefined) break
      const { id, done } = frame
      if (done) {
        ordered.push(id)
        continue
      }
      if (visited.has(id)) continue
      visited.add(id)
      stack.push({ id, done: true })
      /* v8 ignore next 1 -- the adjacency map is initialized for every node identity. */
      for (const index of outgoing.get(id) ?? []) {
        const edge = document.edges[index]
        /* v8 ignore next 1 -- adjacency indices address this document’s own edge list. */
        if (edge !== undefined) stack.push({ id: edge.to, done: false })
      }
    }
  }
  const assigned = new Set<string>()
  const components: string[][] = []
  for (const id of ordered.reverse()) {
    if (assigned.has(id)) continue
    const component: string[] = []
    const stack = [id]
    while (stack.length > 0) {
      const member = stack.pop()
      /* v8 ignore next 1 -- the loop condition guarantees a member to pop. */
      if (member === undefined) break
      if (assigned.has(member)) continue
      assigned.add(member)
      component.push(member)
      stack.push(...(reverse.get(member) ?? []))
    }
    components.push(component)
  }
  return components
}

/** Reduced multi-valued decision diagram for mutually exclusive condition routes. */
class Choices {
  private readonly nodes: { variable: number; branches: readonly number[] }[] = [
    { variable: Infinity, branches: [] }, { variable: Infinity, branches: [] },
  ]
  private readonly unique = new Map<string, number>()
  private readonly memo = new Map<string, number>()

  constructor(private readonly widths: readonly number[]) {}

  /** Predicate selecting one outgoing route of a condition node. */
  route(variable: number, branch: number): number {
    /* v8 ignore next 1 -- a condition route index is always within its width. */
    return this.node(variable, Array.from({ length: this.widths[variable] ?? 0 }, (_, index) => index === branch ? 1 : 0))
  }

  /** Disjoin or conjoin two canonical predicates. */
  combine(operation: 'and' | 'or', left: number, right: number): number {
    if (left === right) return left
    if (operation === 'and') {
      if (left === 0 || right === 0) return 0
      if (left === 1) return right
      if (right === 1) return left
    } else {
      if (left === 1 || right === 1) return 1
      if (left === 0) return right
      if (right === 0) return left
    }
    const key = `${operation}:${Math.min(left, right)}:${Math.max(left, right)}`
    const cached = this.memo.get(key)
    if (cached !== undefined) return cached
    const a = this.nodes[left]
    const b = this.nodes[right]
    /* v8 ignore next 1 -- ids are minted by node(), so both entries exist. */
    if (a === undefined || b === undefined) return 0
    const variable = Math.min(a.variable, b.variable)
    /* v8 ignore next 1 -- a condition route index is always within its width. */
    const branches = Array.from({ length: this.widths[variable] ?? 0 }, (_, index) => this.combine(
      operation,
      /* v8 ignore next 1 -- a node’s branches hold one entry per route of its variable. */
      a.variable === variable ? a.branches[index] ?? left : left,
      /* v8 ignore next 1 -- a node’s branches hold one entry per route of its variable. */
      b.variable === variable ? b.branches[index] ?? right : right,
    ))
    const result = this.node(variable, branches)
    this.memo.set(key, result)
    return result
  }

  /** Whether every selection activating target also activates source. */
  implies(target: number, source: number): boolean {
    return this.combine('and', target, source) === target
  }

  private node(variable: number, branches: readonly number[]): number {
    const first = branches[0]
    /* v8 ignore next 1 -- a condition with no routes never mints a decision node. */
    if (first === undefined) return 0
    if (branches.every(branch => branch === first)) return first
    const key = `${variable}:${branches.join(',')}`
    const cached = this.unique.get(key)
    if (cached !== undefined) return cached
    const id = this.nodes.length
    this.nodes.push({ variable, branches })
    this.unique.set(key, id)
    return id
  }
}

/**
 * First-pass predicates include all selected parallel predecessors and retain
 * exclusive condition choices. Cutting review returns rejects future-round
 * inputs while admitting completed outer-loop results on every later pass.
 * Task-result predicates follow the same choices, so a result carried only by
 * one exclusive branch is not reported as guaranteed.
 */
function firstPass(
  document: Graph,
  incoming: ReadonlyMap<string, readonly number[]>,
  outgoing: ReadonlyMap<string, readonly number[]>,
  loops: readonly ExecutionLoop[],
): {
  guaranteedBefore: ReadonlyMap<string, ReadonlySet<string>>
  guaranteedHandoffs: ReadonlyMap<string, ReadonlySet<string>>
} {
  const returns = new Set(loops.flatMap(loop => loop.backEdges))
  const conditions = document.nodes.filter(node => node.kind === 'condition')
  /* v8 ignore next 1 -- every condition node carries an adjacency entry. */
  const choices = new Choices(conditions.map(node => outgoing.get(node.id)?.length ?? 0))
  const conditionIndex = new Map(conditions.map((node, index) => [node.id, index]))
  const kinds = new Map(document.nodes.map(node => [node.id, node.kind]))
  /* v8 ignore next 1 -- the adjacency map is initialized for every node identity. */
  const pending = new Map(document.nodes.map(node => [node.id, (incoming.get(node.id) ?? []).filter(index => !returns.has(index)).length]))
  const queue = document.nodes.filter(node => pending.get(node.id) === 0).map(node => node.id)
  const active = new Map<string, number>()
  const edgeActive = new Map<number, number>()
  const ancestors = new Map<string, Set<string>>()
  /** Task results each node's own handoff carries under one condition choice. */
  const carried = new Map<string, ReadonlyMap<string, number>>()
  const guaranteedHandoffs = new Map<string, ReadonlySet<string>>()
  const starts = new Set(document.nodes.filter(node => node.kind === 'start').map(node => node.id))
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor]
    /* v8 ignore next 1 -- the queue index is bounded by the queue length. */
    if (id === undefined) break
    /* v8 ignore next 1 -- the adjacency map is initialized for every node identity. */
    const inbound = (incoming.get(id) ?? []).filter(index => !returns.has(index))
    let predicate = starts.has(id) ? 1 : 0
    const before = new Set<string>()
    for (const index of inbound) {
      const edge = document.edges[index]
      /* v8 ignore next 1 -- inbound indices address this document’s own edge list. */
      if (edge === undefined) continue
      /* v8 ignore next 1 -- every non-return inbound edge activates before its target is queued. */
      predicate = choices.combine('or', predicate, edgeActive.get(index) ?? 0)
      before.add(edge.from)
      /* v8 ignore next 1 -- the predecessor was processed before this node. */
      for (const ancestor of ancestors.get(edge.from) ?? []) before.add(ancestor)
    }
    active.set(id, predicate)
    ancestors.set(id, before)
    const own = new Map<string, number>()
    switch (kinds.get(id)) {
      case 'agent':
        /* A task hands off its own result and never inherits its inputs. */
        own.set(id, predicate)
        break
      case 'condition': {
        /* A condition transparently forwards its single predecessor's results. */
        const source = inbound[0] === undefined ? undefined : document.edges[inbound[0]]
        if (source !== undefined) {
          /* v8 ignore next 1 -- the condition’s predecessor was processed before it. */
          for (const [origin, value] of carried.get(source.from) ?? []) own.set(origin, value)
        }
        break
      }
      case 'join': {
        /* An all join merges the branches that activate under this choice. */
        for (const index of inbound) {
          const edge = document.edges[index]
          /* v8 ignore next 1 -- inbound indices address this document’s own edge list. */
          if (edge === undefined) continue
          /* v8 ignore next 1 -- each predecessor was processed before the join. */
          for (const [origin, value] of carried.get(edge.from) ?? []) {
            /* v8 ignore next 1 -- the first origin from a predecessor starts its union at zero. */
            own.set(origin, choices.combine('or', own.get(origin) ?? 0, choices.combine('and', edgeActive.get(index) ?? 0, value)))
          }
        }
        break
      }
      /* start and end produce no task result. */
      default: break
    }
    carried.set(id, own)
    const candidates = new Set<string>()
    for (const index of inbound) {
      const edge = document.edges[index]
      /* v8 ignore next 1 -- inbound indices address this document’s own edge list. */
      if (edge === undefined) continue
      /* v8 ignore next 1 -- each predecessor was processed before this node. */
      for (const origin of carried.get(edge.from)?.keys() ?? []) candidates.add(origin)
    }
    const guaranteed = new Set<string>()
    for (const origin of candidates) {
      let received = 0
      for (const index of inbound) {
        const edge = document.edges[index]
        /* v8 ignore next 1 -- inbound indices address this document’s own edge list. */
        if (edge === undefined) continue
        /* v8 ignore next 3 -- every non-return inbound edge activates before its target runs, and a predecessor that carries no such */
        received = choices.combine('or', received, choices.combine(
          'and', edgeActive.get(index) ?? 0, carried.get(edge.from)?.get(origin) ?? 0,
        ))
      }
      if (predicate !== 0 && choices.implies(predicate, received)) guaranteed.add(origin)
    }
    guaranteedHandoffs.set(id, guaranteed)
    const variable = conditionIndex.get(id)
    /* v8 ignore next 1 -- the adjacency map is initialized for every node identity. */
    outgoing.get(id)?.forEach((index, branch) => {
      if (returns.has(index)) return
      const edge = document.edges[index]
      /* v8 ignore next 1 -- adjacency indices address this document’s own edge list. */
      if (edge === undefined) return
      edgeActive.set(index, variable === undefined ? predicate : choices.combine('and', predicate, choices.route(variable, branch)))
      /* v8 ignore next 1 -- the adjacency map is initialized for every node identity. */
      const remaining = (pending.get(edge.to) ?? 0) - 1
      pending.set(edge.to, remaining)
      if (remaining === 0) queue.push(edge.to)
    })
  }
  const guaranteedBefore = new Map(document.nodes.map((node) => {
    const predicate = active.get(node.id) ?? 0
    /* v8 ignore start -- an ancestor is always processed before its descendants. */
    const guaranteed = new Set([...(ancestors.get(node.id) ?? [])].filter(id =>
      predicate !== 0 && choices.implies(predicate, active.get(id) ?? 0),
    ))
    /* v8 ignore stop */
    return [node.id, guaranteed]
  }))
  return { guaranteedBefore, guaranteedHandoffs }
}
