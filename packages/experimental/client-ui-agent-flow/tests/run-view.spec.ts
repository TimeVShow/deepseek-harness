import { describe, expect, it } from 'vitest'
import type { AgentTemplateId, FlowDocument, FlowId, FlowRun, FlowRunId } from '@deepseek-ai/dsh-experimental-agent-flow/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  executionPredecessors, executionSuccessors, isWorkNode, lastActivityOf, latestEntryByNode,
  nodeDisplayName, nodeViewsOf, relatedRuns, runInvolvesSession, runPhaseOf, runStalled,
  runWaitsForUser, unmetPredecessors,
} from '../src/client/run-view.ts'

const SESSION = 'session-1' as SessionId
const NODE_SESSION = 'flow-node' as SessionId
const FLOW = 'flow-1' as FlowId
const RUN = 'run-1' as FlowRunId
const TEMPLATE = 'template-1' as AgentTemplateId

const templates = [{ id: TEMPLATE, name: 'Implement agent' }]

/** Design → implement → review, the handoff's sample graph, with a verdict loop. */
function graph(overrides: Partial<FlowDocument> = {}): FlowDocument {
  return {
    id: FLOW,
    name: 'Simple flow',
    maxIterations: 16,
    nodes: [
      { kind: 'start', id: 'start' },
      { kind: 'agent', id: 'design', templateId: TEMPLATE, instruction: 'design', interactive: true },
      { kind: 'agent', id: 'implement', templateId: TEMPLATE, instruction: 'implement' },
      { kind: 'agent', id: 'review', templateId: TEMPLATE, instruction: 'review' },
      { kind: 'condition', id: 'verdict' },
      { kind: 'end', id: 'end' },
    ],
    edges: [
      { kind: 'execution', from: 'start', to: 'design' },
      { kind: 'execution', from: 'design', to: 'implement' },
      { kind: 'execution', from: 'implement', to: 'review' },
      { kind: 'execution', from: 'review', to: 'verdict' },
      { kind: 'execution', from: 'verdict', to: 'end' },
      { kind: 'execution', from: 'verdict', to: 'implement' },
      { kind: 'input', from: 'start', to: 'design' },
    ],
    createdAt: '2026-11-04T00:00:00.000Z',
    updatedAt: '2026-11-04T00:00:00.000Z',
    ...overrides,
  }
}

function run(overrides: Partial<FlowRun> = {}): FlowRun {
  return {
    id: RUN,
    flowId: FLOW,
    snapshot: graph(),
    parentSessionId: SESSION,
    status: 'running',
    input: 'build a sorter',
    nodeRuns: [],
    startedAt: '2026-11-04T02:00:00.000Z',
    ...overrides,
  }
}

describe('run↔session association', () => {
  it('matches the parent session and every session a node execution opened', () => {
    const involved = run({
      nodeRuns: [{ nodeId: 'implement', iteration: 0, status: 'running', agentSessionId: NODE_SESSION }],
    })
    expect(runInvolvesSession(involved, SESSION)).toBe(true)
    expect(runInvolvesSession(involved, NODE_SESSION)).toBe(true)
    expect(runInvolvesSession(involved, 'other' as SessionId)).toBe(false)
  })

  it('lists live runs first, then newest first, for one session', () => {
    const older = { ...run(), id: 'run-2' as FlowRunId, status: 'completed' as const, startedAt: '2026-11-03T00:00:00.000Z' }
    const live = { ...run(), id: 'run-3' as FlowRunId, startedAt: '2026-11-02T00:00:00.000Z' }
    const newest = { ...run(), id: 'run-4' as FlowRunId, status: 'failed' as const, startedAt: '2026-11-04T00:00:00.000Z' }
    const related = relatedRuns([older, newest, live], SESSION)
    expect(related.map(entry => entry.id)).toEqual(['run-3', 'run-4', 'run-2'])
    /* Both comparison directions: a settled candidate first and a live one first. */
    expect(relatedRuns([live, older], SESSION).map(entry => entry.id)).toEqual(['run-3', 'run-2'])
    expect(relatedRuns([older, live], SESSION).map(entry => entry.id)).toEqual(['run-3', 'run-2'])
  })
})

describe('graph reads', () => {
  it('reads execution edges only; input edges are not dependencies or handoffs', () => {
    const record = run()
    expect(executionPredecessors(record, 'design')).toEqual(['start'])
    expect(executionSuccessors(record, 'verdict')).toEqual(['end', 'implement'])
    /* start ⇢ design is an input edge: it neither waits nor hands off. */
    expect(unmetPredecessors(record, 'design')).toEqual(['start'])
    expect(executionSuccessors(record, 'design')).toEqual(['implement'])
  })

  it('lists a duplicated execution relation once on each side', () => {
    const record = run({
      snapshot: graph({
        nodes: [
          { kind: 'start', id: 'start' },
          { kind: 'agent', id: 'design', templateId: TEMPLATE, instruction: 'd' },
          { kind: 'end', id: 'end' },
        ],
        edges: [
          { kind: 'execution', from: 'start', to: 'design' },
          { kind: 'execution', from: 'design', to: 'end' },
          { kind: 'execution', from: 'design', to: 'end' },
        ],
      }),
    })
    expect(executionSuccessors(record, 'design')).toEqual(['end'])
    expect(executionPredecessors(record, 'end')).toEqual(['design'])
  })

  it('excludes a condition predecessor that loops back to the same node', () => {
    const record = run({
      snapshot: graph({
        nodes: [
          { kind: 'start', id: 'start' },
          { kind: 'condition', id: 'gate' },
          { kind: 'agent', id: 'implement', templateId: TEMPLATE, instruction: 'b' },
        ],
        edges: [
          { kind: 'execution', from: 'start', to: 'gate' },
          { kind: 'execution', from: 'gate', to: 'gate' },
          { kind: 'execution', from: 'gate', to: 'implement' },
        ],
      }),
    })
    /* The gate's own round-trip edge is its rework trigger, not a wait. */
    expect(unmetPredecessors(record, 'gate')).toEqual(['start'])
  })

  it('follows an indirect path from a node back to its condition trigger', () => {
    const record = run({
      snapshot: graph({
        nodes: [
          { kind: 'condition', id: 'gate' },
          { kind: 'agent', id: 'implement', templateId: TEMPLATE, instruction: 'b' },
          { kind: 'agent', id: 'review', templateId: TEMPLATE, instruction: 'r' },
        ],
        edges: [
          { kind: 'execution', from: 'gate', to: 'implement' },
          { kind: 'execution', from: 'implement', to: 'review' },
          { kind: 'execution', from: 'review', to: 'gate' },
        ],
      }),
    })
    /* implement reaches gate through review, so gate is its rework trigger. */
    expect(unmetPredecessors(record, 'implement')).toEqual([])
  })

  it('keeps a condition predecessor that no path leads back to', () => {
    const record = run({
      snapshot: graph({
        nodes: [
          { kind: 'condition', id: 'gate' },
          { kind: 'agent', id: 'implement', templateId: TEMPLATE, instruction: 'b' },
        ],
        edges: [{ kind: 'execution', from: 'gate', to: 'implement' }],
      }),
    })
    /* Nothing leads from implement back to gate, so it must still start it. */
    expect(unmetPredecessors(record, 'implement')).toEqual(['gate'])
  })

  it('walks a converging graph once per node', () => {
    const record = run({
      snapshot: graph({
        nodes: [
          { kind: 'condition', id: 'gate' },
          { kind: 'agent', id: 'implement', templateId: TEMPLATE, instruction: 'b' },
          { kind: 'agent', id: 'left', templateId: TEMPLATE, instruction: 'l' },
          { kind: 'agent', id: 'right', templateId: TEMPLATE, instruction: 'r' },
          { kind: 'agent', id: 'merge', templateId: TEMPLATE, instruction: 'm' },
        ],
        edges: [
          { kind: 'execution', from: 'gate', to: 'implement' },
          { kind: 'execution', from: 'implement', to: 'left' },
          { kind: 'execution', from: 'implement', to: 'right' },
          { kind: 'execution', from: 'left', to: 'merge' },
          { kind: 'execution', from: 'right', to: 'merge' },
        ],
      }),
    })
    /* Both branches reach merge; the second visit is skipped, and no path
       leads back to the gate. */
    expect(unmetPredecessors(record, 'implement')).toEqual(['gate'])
  })

  it('classifies start and end as structural and agents as work', () => {
    const record = run()
    expect(isWorkNode(record, 'start')).toBe(false)
    expect(isWorkNode(record, 'end')).toBe(false)
    expect(isWorkNode(record, 'verdict')).toBe(true)
    expect(isWorkNode(record, 'missing')).toBe(true)
  })

  it('resolves names through titles, then templates, then nothing', () => {
    const titled = graph({
      nodes: [
        { kind: 'start', id: 'start' },
        { kind: 'agent', id: 'design', templateId: TEMPLATE, instruction: 'd', title: '设计' },
        { kind: 'agent', id: 'implement', templateId: TEMPLATE, instruction: 'b' },
        { kind: 'agent', id: 'loose', templateId: 'no-such-template' as AgentTemplateId, instruction: 'l' },
        { kind: 'end', id: 'end' },
      ],
      edges: [{ kind: 'execution', from: 'start', to: 'design' }, { kind: 'execution', from: 'design', to: 'end' }],
    })
    const record = { ...run(), snapshot: titled }
    expect(nodeDisplayName(record, 'design', templates)).toBe('设计')
    expect(nodeDisplayName(record, 'implement', templates)).toBe('Implement agent')
    expect(nodeDisplayName(record, 'loose', templates)).toBe('loose')
    expect(nodeDisplayName(record, 'end', templates)).toBeUndefined()
    expect(nodeDisplayName(record, 'missing', templates)).toBe('missing')
  })
})

describe('node views', () => {
  it('shows the live execution, the node blocked on it, and the latest completion', () => {
    const record = run({
      nodeRuns: [
        { nodeId: 'start', iteration: 0, status: 'succeeded', startedAt: '2026-11-04T02:00:00.000Z', endedAt: '2026-11-04T02:00:00.050Z' },
        { nodeId: 'design', iteration: 0, status: 'succeeded', startedAt: '2026-11-04T02:00:00.100Z', endedAt: '2026-11-04T02:01:00.000Z' },
        { nodeId: 'implement', iteration: 0, status: 'running', agentSessionId: NODE_SESSION, startedAt: '2026-11-04T02:01:00.100Z' },
        { nodeId: 'review', iteration: 0, status: 'pending' },
        { nodeId: 'verdict', iteration: 0, status: 'pending' },
        { nodeId: 'end', iteration: 0, status: 'pending' },
      ],
    })
    const views = nodeViewsOf(record)
    expect(views.map(view => [view.entry.nodeId, view.display, view.unmet])).toEqual([
      ['implement', 'running', []],
      ['review', 'waiting', ['implement']],
      ['design', 'settled', []],
    ])
  })

  it('shows a never-started node whose execution predecessors all settled as ready', () => {
    const record = run({
      nodeRuns: [
        { nodeId: 'start', iteration: 0, status: 'succeeded' },
        { nodeId: 'design', iteration: 0, status: 'succeeded' },
        { nodeId: 'implement', iteration: 0, status: 'pending' },
        { nodeId: 'review', iteration: 0, status: 'pending' },
        { nodeId: 'verdict', iteration: 0, status: 'pending' },
        { nodeId: 'end', iteration: 0, status: 'pending' },
      ],
    })
    const views = nodeViewsOf(record)
    /* implement is ready and already blocks review; verdict waits on review,
       which no view shows yet, so it stays out; design is the latest
       completion. */
    expect(views.map(view => [view.entry.nodeId, view.display])).toEqual([
      ['implement', 'ready'],
      ['review', 'waiting'],
      ['design', 'settled'],
    ])
  })

  it('hides a settled node that waits for its next loop round', () => {
    const record = run({
      nodeRuns: [
        { nodeId: 'start', iteration: 0, status: 'succeeded' },
        { nodeId: 'design', iteration: 0, status: 'succeeded' },
        { nodeId: 'implement', iteration: 0, status: 'succeeded', endedAt: '2026-11-04T02:05:00.000Z' },
        { nodeId: 'review', iteration: 0, status: 'succeeded', endedAt: '2026-11-04T02:06:00.000Z' },
        { nodeId: 'verdict', iteration: 0, status: 'succeeded', endedAt: '2026-11-04T02:06:01.000Z' },
        { nodeId: 'implement', iteration: 1, status: 'running', startedAt: '2026-11-04T02:06:02.000Z' },
        { nodeId: 'review', iteration: 1, status: 'pending' },
      ],
    })
    const views = nodeViewsOf(record)
    /* implement reads as round 2; review's round-2 entry waits on it;
       verdict already routed round 1 back, so it waits for a later round and
       shows only as the latest completion. */
    expect(views.map(view => [view.entry.nodeId, view.entry.iteration, view.display])).toEqual([
      ['implement', 1, 'running'],
      ['review', 1, 'waiting'],
      ['verdict', 0, 'settled'],
    ])
  })

  it('lets a skipped branch leave the wait set of a waiting node', () => {
    const parallel = graph({
      nodes: [
        { kind: 'start', id: 'start' },
        { kind: 'agent', id: 'alpha', templateId: TEMPLATE, instruction: 'a' },
        { kind: 'agent', id: 'beta', templateId: TEMPLATE, instruction: 'b' },
        { kind: 'join', id: 'merge', mode: 'all' },
        { kind: 'end', id: 'end' },
      ],
      edges: [
        { kind: 'execution', from: 'start', to: 'alpha' },
        { kind: 'execution', from: 'start', to: 'beta' },
        { kind: 'execution', from: 'alpha', to: 'merge' },
        { kind: 'execution', from: 'beta', to: 'merge' },
        { kind: 'execution', from: 'merge', to: 'end' },
      ],
    })
    const record = run({
      snapshot: parallel,
      nodeRuns: [
        { nodeId: 'start', iteration: 0, status: 'succeeded' },
        { nodeId: 'alpha', iteration: 0, status: 'skipped' },
        { nodeId: 'beta', iteration: 0, status: 'running', startedAt: '2026-11-04T02:00:00.000Z' },
        { nodeId: 'merge', iteration: 0, status: 'pending' },
      ],
    })
    expect(unmetPredecessors(record, 'merge')).toEqual(['beta'])
    expect(nodeViewsOf(record).map(view => [view.entry.nodeId, view.display, view.unmet])).toEqual([
      ['beta', 'running', []],
      ['merge', 'waiting', ['beta']],
      ['alpha', 'settled', []],
    ])
  })

  it('indexes the latest entry per node for round-aware reads', () => {
    const record = run({
      nodeRuns: [
        { nodeId: 'implement', iteration: 0, status: 'succeeded' },
        { nodeId: 'implement', iteration: 1, status: 'running' },
      ],
    })
    expect(latestEntryByNode(record).get('implement')?.iteration).toBe(1)
  })

  it('shows a conversing execution as the run waiting on the user', () => {
    const record = run({
      nodeRuns: [
        { nodeId: 'design', iteration: 0, status: 'conversing', agentSessionId: NODE_SESSION, startedAt: '2026-11-04T02:00:00.000Z' },
        { nodeId: 'implement', iteration: 0, status: 'pending' },
      ],
    })
    expect(nodeViewsOf(record).map(view => [view.entry.nodeId, view.display])).toEqual([
      ['design', 'conversing'],
      ['implement', 'waiting'],
    ])
  })

  it('does not repeat a node already shown as its live execution', () => {
    const record = run({
      nodeRuns: [
        /* A running record the latest settled entry replaced for the same node. */
        { nodeId: 'design', iteration: 0, status: 'running', startedAt: '2026-11-04T02:00:00.000Z' },
        { nodeId: 'design', iteration: 0, status: 'succeeded', endedAt: '2026-11-04T02:01:00.000Z' },
      ],
    })
    expect(nodeViewsOf(record).map(view => [view.entry.nodeId, view.display])).toEqual([
      ['design', 'running'],
      ['implement', 'ready'],
      ['review', 'waiting'],
    ])
  })

  it('keeps the newest parseable completion as the settled line', () => {
    const record = run({
      nodeRuns: [
        /* An unparseable ending cannot hold the line. */
        { nodeId: 'design', iteration: 0, status: 'succeeded', endedAt: 'nope' },
        { nodeId: 'implement', iteration: 0, status: 'succeeded', endedAt: '2026-11-04T02:05:00.000Z' },
        /* Listed later but older: the newer completion keeps the line. */
        { nodeId: 'review', iteration: 0, status: 'succeeded', endedAt: '2026-11-04T02:01:00.000Z' },
      ],
    })
    expect(nodeViewsOf(record).map(view => [view.entry.nodeId, view.display])).toEqual([
      ['verdict', 'ready'],
      ['implement', 'settled'],
    ])
  })
})

describe('phases and activity', () => {
  it('reads a conversing run as waiting for the user', () => {
    expect(runWaitsForUser(run({ status: 'completed' }))).toBe(false)
    expect(runWaitsForUser(run({
      nodeRuns: [{ nodeId: 'design', iteration: 0, status: 'conversing', agentSessionId: NODE_SESSION }],
    }))).toBe(true)
    expect(runPhaseOf(run({ status: 'failed' }))).toBe('failed')
    expect(runPhaseOf(run({
      nodeRuns: [{ nodeId: 'design', iteration: 0, status: 'conversing' }],
    }))).toBe('clarifying')
  })

  it('reads the most recent recorded transition, run start last', () => {
    const record = run({
      status: 'running',
      startedAt: '2026-11-04T02:00:00.000Z',
      nodeRuns: [
        { nodeId: 'design', iteration: 0, status: 'succeeded', startedAt: '2026-11-04T02:00:01.000Z', endedAt: '2026-11-04T02:01:00.000Z' },
        { nodeId: 'implement', iteration: 0, status: 'running', startedAt: '2026-11-04T02:01:01.000Z' },
      ],
    })
    expect(lastActivityOf(record)).toEqual({
      at: Date.parse('2026-11-04T02:01:01.000Z'),
      kind: 'node-started',
      nodeId: 'implement',
    })
    expect(lastActivityOf(run({ startedAt: '2026-11-04T02:00:00.000Z' }))).toEqual({
      at: Date.parse('2026-11-04T02:00:00.000Z'),
      kind: 'run-started',
    })
    /* A node that only queued has no transition to report. */
    expect(lastActivityOf(run({
      startedAt: '2026-11-04T02:00:00.000Z',
      nodeRuns: [{ nodeId: 'design', iteration: 0, status: 'pending' }],
    }))).toEqual({ at: Date.parse('2026-11-04T02:00:00.000Z'), kind: 'run-started' })
  })

  it("reads a terminal run's own ending as its last activity", () => {
    const record = run({
      status: 'completed',
      endedAt: '2026-11-04T02:09:00.000Z',
      nodeRuns: [
        { nodeId: 'design', iteration: 0, status: 'succeeded', startedAt: '2026-11-04T02:00:01.000Z', endedAt: '2026-11-04T02:01:00.000Z' },
      ],
    })
    expect(lastActivityOf(record)).toEqual({
      at: Date.parse('2026-11-04T02:09:00.000Z'),
      kind: 'run-ended',
    })
  })

  it('drops unparseable timestamps instead of reporting them', () => {
    const record = run({
      startedAt: 'not-a-date',
      nodeRuns: [{ nodeId: 'design', iteration: 0, status: 'succeeded', startedAt: '2026-11-04T02:00:01.000Z' }],
    })
    expect(lastActivityOf(record).at).toBe(Date.parse('2026-11-04T02:00:01.000Z'))
  })

  it('stalls only a running run quiet past the threshold', () => {
    const started = '2026-11-04T02:00:00.000Z'
    const now = Date.parse(started) + 600_000
    expect(runStalled(run({ startedAt: started }), now, 600_000)).toBe(true)
    expect(runStalled(run({ startedAt: started }), now, 600_001)).toBe(false)
    expect(runStalled(run({ startedAt: started, status: 'completed' }), now, 600_000)).toBe(false)
  })
})
