// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  MutableSessionEventSource,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  SessionAssistantSettlementEntry, SessionEventLikeEntry, SessionSnapshot,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatus } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { FlowNodeRun, FlowRun } from '@deepseek-ai/dsh-experimental-agent-flow/types'
import {
  NodeActivityTracker, type NodeObservation, type SessionObservationSource,
} from '../src/client/activity-tracker.ts'

const SESSION = 'node-session' as SessionId

/** One mutable Session snapshot, the fields the tracker reads included. */
type LiveSession = { -readonly [K in keyof SessionSnapshot]: SessionSnapshot[K] }

function liveSession(): LiveSession {
  return {
    sessionId: SESSION, running: false, removed: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, blank: false, subagent: null,
    pendingSubmissions: [], lastAgentError: null, promptAttempted: false, awaitingFirstTurn: false,
  }
}

const event = (
  type: 'turn/start' | 'step/start' | 'request/header',
  data: Record<string, unknown>,
  time = 1_005,
): SessionEventLikeEntry => ({
  type: 'event',
  event: { seq: 1 as never, time, type, data } as never,
})
const reasoning = (time: number): SessionEventLikeEntry => ({
  type: 'transient',
  event: {
    type: 'assistant/live-chunk',
    seq: time,
    time,
    data: { attemptId: 'attempt-1' as never, turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'x' } },
  },
})
const toolCall = (callId: string, time: number): SessionEventLikeEntry => ({
  type: 'event',
  event: {
    seq: 1 as never,
    time,
    type: 'tool/call',
    data: { turn: 1, step: 1, callId, name: 'read', arguments: '{}' },
  } as never,
})
const settlement = (time: number): SessionAssistantSettlementEntry => ({
  type: 'event',
  event: {
    seq: 1 as never,
    time,
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'done' }], source: { provider: 'mock', model: 'mock' } }),
      stream: [],
    },
    surfaceOp: 'append',
  } as never,
})

const node = (status: FlowNodeRun['status'], sessionId: SessionId = SESSION): FlowNodeRun => ({
  nodeId: 'implement',
  iteration: 0,
  status,
  agentSessionId: sessionId,
})

const run = (status: FlowRun['status'], nodeRuns: FlowNodeRun[]): FlowRun => ({
  id: 'run-1' as FlowRun['id'],
  flowId: 'flow-1' as FlowRun['flowId'],
  snapshot: {
    id: 'flow-1' as FlowRun['flowId'], name: 'demo', maxIterations: 16, nodes: [], edges: [],
    createdAt: 'a', updatedAt: 'a',
  },
  parentSessionId: 'parent' as SessionId,
  status,
  input: 'go',
  nodeRuns,
  startedAt: '2026-11-04T00:00:00.000Z',
})

/** One retained Session's feed and snapshot, both production-shaped. */
interface ObservedSession {
  readonly feed: MutableSessionEventSource
  readonly snapshot: LiveSession
  readonly listeners: Set<() => void>
}

/** One tracker over fake retention/status sources and a recorded publish stream. */
function bench() {
  const sessions = new Map<SessionId, ObservedSession>()
  const status = new Map<SessionId, SessionStatus>()
  const retained: SessionId[] = []
  const released: SessionId[] = []
  const unknown = new Set<SessionId>()
  const published: { sessionId: SessionId; observation: NodeObservation }[] = []
  const statusListeners = new Set<() => void>()
  const observe = (target: SessionId): ObservedSession => {
    const existing = sessions.get(target)
    if (existing !== undefined) return existing
    const created: ObservedSession = { feed: new MutableSessionEventSource(), snapshot: liveSession(), listeners: new Set() }
    sessions.set(target, created)
    return created
  }
  const retain = vi.fn((target: SessionId) => {
    if (unknown.has(target)) throw new Error(`sessions.retain: unknown session ${String(target)}`)
    const session = observe(target)
    retained.push(target)
    return {
      binding: {
        eventSource: session.feed,
        session: {
          getSnapshot: () => session.snapshot,
          subscribe: (listener: () => void) => {
            session.listeners.add(listener)
            return () => { session.listeners.delete(listener) }
          },
        },
      },
      release: () => { released.push(target) },
    }
  })
  const service: SessionObservationSource = { retain }
  const tracker = new NodeActivityTracker(
    service,
    {
      getSnapshot: () => status,
      subscribe: (listener: () => void) => {
        statusListeners.add(listener)
        return () => { statusListeners.delete(listener) }
      },
    },
    (sessionId, observation) => { published.push({ sessionId, observation }) },
  )
  const sessionOf = (id: SessionId = SESSION): ObservedSession => {
    const session = sessions.get(id)
    if (session === undefined) throw new Error(`no session for ${String(id)}`)
    return session
  }
  const publishStatus = (): void => { for (const listener of [...statusListeners]) listener() }
  const publishSession = (id: SessionId = SESSION): void => {
    for (const listener of [...sessionOf(id).listeners]) listener()
  }
  return {
    tracker, retain, status, unknown, retained, released, published, sessionOf, publishStatus, publishSession,
  }
}

describe('NodeActivityTracker', () => {
  it('retains only running node Sessions of running runs', () => {
    const { tracker, retain, retained } = bench()
    tracker.sync([
      run('running', [node('running'), node('conversing', 'other' as SessionId), node('succeeded', 'done' as SessionId)]),
      run('completed', [node('running', 'settled' as SessionId)]),
    ])
    expect(retain).toHaveBeenCalledTimes(2)
    expect(retained).toEqual([SESSION, 'other'])
  })

  it('publishes the folded stage as the feed advances', () => {
    const { tracker, published, sessionOf } = bench()
    tracker.sync([run('running', [node('running')])])
    expect(published[0]?.observation).toMatchObject({ stage: 'unknown', observed: false, running: false })

    sessionOf().feed.append(event('turn/start', { turn: 1 }))
    expect(published.at(-1)?.observation).toMatchObject({ stage: 'preparing', turn: 1 })

    /* A step opens before it assembles anything; the logged request is the
       first evidence that one exists. */
    sessionOf().feed.append(event('step/start', { turn: 1, step: 1 }))
    expect(published.at(-1)?.observation.stage).toBe('preparing')
    sessionOf().feed.append(event('request/header', { header: { config: {} }, reason: 'initial' }))
    expect(published.at(-1)?.observation.stage).toBe('awaiting-response')

    sessionOf().feed.append(reasoning(2_000))
    expect(published.at(-1)?.observation).toMatchObject({ stage: 'reasoning', lastAt: 2_000 })
  })

  it('coalesces chunks that change nothing a surface renders', () => {
    const { tracker, published, sessionOf } = bench()
    tracker.sync([run('running', [node('running')])])
    sessionOf().feed.append(reasoning(2_000))
    const count = published.length
    /* Same phase, under a publishing step of new signal. */
    sessionOf().feed.append(reasoning(2_400))
    expect(published).toHaveLength(count)
    /* One full step of new signal is worth a render. */
    sessionOf().feed.append(reasoning(3_000))
    expect(published).toHaveLength(count + 1)
  })

  it('keeps folding after a settled attempt removes its transient rows', () => {
    const { tracker, published, sessionOf } = bench()
    tracker.sync([run('running', [node('running')])])
    for (let index = 0; index < 20; index += 1) sessionOf().feed.append(reasoning(2_000 + index))
    expect(published.at(-1)?.observation.stage).toBe('reasoning')

    /* The settlement shrinks the window: only the durable rows remain. */
    sessionOf().feed.settleAssistant('attempt-1' as never)
    sessionOf().feed.append(toolCall('call-1', 3_000))
    expect(published.at(-1)?.observation).toMatchObject({
      stage: 'tool',
      tools: [{ callId: 'call-1', name: 'read' }],
      lastAt: 3_000,
    })
  })

  it('folds the durable settlement a settled attempt publishes', () => {
    const { tracker, published, sessionOf } = bench()
    tracker.sync([run('running', [node('running')])])
    sessionOf().feed.append(reasoning(2_000))
    sessionOf().feed.settleAssistant('attempt-1' as never, settlement(2_500))
    /* A settled answer without tool calls leaves the loop preparing its next step. */
    expect(published.at(-1)?.observation.stage).toBe('preparing')
  })

  it('rebuilds from the whole window after a reconnect replaces it', () => {
    const { tracker, published, sessionOf } = bench()
    tracker.sync([run('running', [node('running')])])
    sessionOf().feed.append(reasoning(2_000))

    sessionOf().feed.replace([
      event('turn/start', { turn: 2 }, 4_000),
      toolCall('call-2', 5_000),
    ], false)
    expect(published.at(-1)?.observation).toMatchObject({
      stage: 'tool',
      tools: [{ callId: 'call-2', name: 'read' }],
      lastAt: 5_000,
    })
  })

  it('does not treat a prepended history page as new business activity', () => {
    const { tracker, published, sessionOf } = bench()
    tracker.sync([run('running', [node('running')])])
    sessionOf().feed.append(event('turn/start', { turn: 2 }, 4_000))
    const before = published.length

    sessionOf().feed.prepend([event('turn/start', { turn: 1 }, 1_000)], false)
    expect(published).toHaveLength(before)
    expect(published.at(-1)?.observation).toMatchObject({ stage: 'preparing', turn: 2, lastAt: 4_000 })
  })

  it('republishes when the live state a surface shows changes', () => {
    const { tracker, published, sessionOf, status, publishStatus, publishSession } = bench()
    tracker.sync([run('running', [node('running')])])
    const count = published.length

    /* A status notification that changes nothing observable stays quiet. */
    publishStatus()
    expect(published).toHaveLength(count)
    sessionOf().snapshot.running = true
    publishSession()
    expect(published.at(-1)?.observation.running).toBe(true)

    /* A submission leaves before any event exists for it: the Session snapshot
       is the only place that fact appears. */
    sessionOf().snapshot.pendingSubmissions = [{ id: 'message-1' } as never]
    publishSession()
    expect(published.at(-1)?.observation.pendingSubmissions).toBe(1)

    status.set(SESSION, { running: true, pendingInteraction: { key: 'k', kind: 'question', sessionId: SESSION } as never, completionUnread: false })
    publishStatus()
    expect(published.at(-1)?.observation.pendingInteraction).toBe(true)
    expect(published.length).toBeGreaterThan(count)
  })

  it('reports a failed stream instead of leaving its stage current', () => {
    const { tracker, published, sessionOf, publishSession } = bench()
    tracker.sync([run('running', [node('running')])])
    sessionOf().feed.append(reasoning(2_000))
    expect(published.at(-1)?.observation.streamFailed).toBe(false)

    sessionOf().snapshot.openState = 'error'
    sessionOf().snapshot.openError = { code: 'stream/lost', message: 'closed' } as never
    publishSession()
    expect(published.at(-1)?.observation).toMatchObject({ stage: 'reasoning', streamFailed: true })
  })

  it('republishes when the open tool set changes without changing its size', () => {
    const { tracker, published, sessionOf } = bench()
    tracker.sync([run('running', [node('running')])])
    sessionOf().feed.append(toolCall('call-1', 2_000))
    expect(published.at(-1)?.observation.tools).toEqual([{ callId: 'call-1', name: 'read' }])

    /* A reconnect window still holds one open tool, but a different one: the
       count alone would hide the change. */
    sessionOf().feed.replace([toolCall('call-2', 2_100)], false)
    expect(published.at(-1)?.observation.tools).toEqual([{ callId: 'call-2', name: 'read' }])
  })

  it('releases a node Session once its execution settles', () => {
    const { tracker, released, published, sessionOf } = bench()
    tracker.sync([run('running', [node('running')])])
    tracker.sync([run('running', [node('succeeded')])])
    expect(released).toEqual([SESSION])
    const count = published.length
    sessionOf().feed.append(reasoning(2_000))
    expect(published).toHaveLength(count)
  })

  it('releases every retained Session on dispose', () => {
    const { tracker, released } = bench()
    tracker.sync([run('running', [node('running'), node('conversing', 'other' as SessionId)])])
    tracker.dispose()
    expect(released).toEqual([SESSION, 'other'])
  })

  it('skips a Session the client has not catalogued yet and retries later', () => {
    const { tracker, unknown, retained, published } = bench()
    unknown.add(SESSION)
    tracker.sync([run('running', [node('running')])])
    expect(retained).toEqual([])
    expect(published).toEqual([])

    unknown.delete(SESSION)
    tracker.sync([run('running', [node('running')])])
    expect(retained).toEqual([SESSION])
    expect(published).toHaveLength(1)
  })

  it('retains a node Session only once across repeated roster reads', () => {
    const { tracker, retain } = bench()
    tracker.sync([run('running', [node('running')])])
    tracker.sync([run('running', [node('running')])])
    expect(retain).toHaveBeenCalledTimes(1)
  })
})
