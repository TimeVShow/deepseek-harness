// @vitest-environment jsdom
/**
 * Keyless chain regression for the live-activity path: ordered Session events
 * enter the shared client event feed, the tracker folds them, the panel
 * controller publishes the observation, and the progress card renders it. No
 * synthetic `nodeActivity` values stand in for the observer here, so a break in
 * any hop fails the same assertion the user would see.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { MutableSessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionSnapshot, SessionTarget } from '@deepseek-ai/dsh-api-session-controller/client'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionStatus } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AgentTemplateId, FlowDocument, FlowRun, FlowRunId } from '@deepseek-ai/dsh-experimental-agent-flow/types'
import type {} from '@deepseek-ai/dsh-experimental-agent-flow/remote'
import { NodeActivityTracker, type SessionObservationSource } from '../src/client/activity-tracker.ts'
import { AgentFlowController } from '../src/client/controller.ts'
import { FlowRunProgress, type FlowRunProgressProps } from '../src/client/FlowRunProgress.tsx'
import { zh } from '../src/client/locales.ts'

const SESSION = 'session-1' as SessionId
const NODE = 'worker-1' as SessionId
const FLOW = 'flow-1' as FlowRun['flowId']
const RUN = 'run-1' as FlowRunId
const TEMPLATE = 'template-1' as AgentTemplateId

/** Now the fixtures render at; the run started half an hour earlier. */
const NOW = Date.parse('2026-11-04T11:00:00.000Z')

/** One mutable Session snapshot; the chain flips its live fields between steps. */
type LiveSession = { -readonly [K in keyof SessionSnapshot]: SessionSnapshot[K] }

function liveSession(): LiveSession {
  return {
    sessionId: NODE, running: false, removed: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, blank: false, subagent: null,
    pendingSubmissions: [], lastAgentError: null, promptAttempted: false, awaitingFirstTurn: false,
  }
}

/** The Session seat the slot type requires; the card reads none of it. */
const SESSION_SEAT: SessionSnapshot = { ...liveSession(), sessionId: SESSION }

/** The composer seat the slot type requires; the card reads none of it. */
const INPUT_SEAT: InputState = {
  draft: '', attachmentIds: [], draftRev: 0, phase: 'plain', occurrences: [], queue: [],
}

function flow(interactive: boolean): FlowDocument {
  return {
    id: FLOW,
    name: 'Chain flow',
    maxIterations: 16,
    nodes: [
      { kind: 'start', id: 'start' },
      { kind: 'agent', id: 'clarify', templateId: TEMPLATE, instruction: 'ask', ...interactive ? { interactive: true } : {} },
      { kind: 'agent', id: 'implement', templateId: TEMPLATE, instruction: 'build' },
      { kind: 'end', id: 'end' },
    ],
    edges: [
      { kind: 'execution', from: 'start', to: 'clarify' },
      { kind: 'execution', from: 'clarify', to: 'implement' },
      { kind: 'execution', from: 'implement', to: 'end' },
    ],
    createdAt: '2026-11-04T00:00:00.000Z',
    updatedAt: '2026-11-04T00:00:00.000Z',
  }
}

/**
 * One run whose node Session the chain observes.
 * @param options.interactive - whether the entry node converses with the user.
 * @param options.status - recorded run status.
 * @returns the run record.
 */
function record(options: { interactive: boolean; status: FlowRun['status'] }): FlowRun {
  const node = options.interactive ? 'clarify' : 'implement'
  return {
    id: RUN,
    flowId: FLOW,
    snapshot: flow(options.interactive),
    parentSessionId: SESSION,
    status: options.status,
    input: 'build a sorter',
    nodeRuns: [
      { nodeId: 'start', iteration: 0, status: 'succeeded' },
      options.interactive
        ? {
          nodeId: node, iteration: 0,
          status: options.status === 'running' ? 'conversing' : 'succeeded',
          agentSessionId: NODE,
          startedAt: new Date(NOW - 20 * 60_000).toISOString(),
        }
        : {
          nodeId: node, iteration: 0,
          status: options.status === 'running' ? 'running' : 'succeeded',
          agentSessionId: NODE,
          startedAt: new Date(NOW - 20 * 60_000).toISOString(),
        },
    ],
    startedAt: new Date(NOW - 30 * 60_000).toISOString(),
    ...options.status === 'running' ? {} : { endedAt: new Date(NOW - 60_000).toISOString() },
  }
}

/** One ordered Session event as the feed stores it. */
function durable<T extends SessionEvent['type']>(type: T, data: SessionEvent<T>['data'], time: number, seq: number): SessionEvent {
  return { type, data, time, seq: seq as never } as SessionEvent
}

/** Assemble the production chain: controller store → tracker → card. */
async function chain(options: { interactive: boolean; status?: FlowRun['status'] }) {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  function ok<T>(value: T) {
    return Promise.resolve({ ok: true as const, value })
  }
  const feed = new MutableSessionEventSource()
  const live = liveSession()
  const liveListeners = new Set<() => void>()
  const status = new Map<SessionId, SessionStatus>()
  const statusListeners = new Set<() => void>()
  const released: SessionId[] = []
  const roster = { current: [record({ interactive: options.interactive, status: options.status ?? 'running' })] }
  const remote = {
    agentFlows: {
      listFlows: () => ok([flow(options.interactive)]),
      listTemplates: () => ok([{ id: TEMPLATE, name: 'Builder', createdAt: 'a', updatedAt: 'a' }]),
      listRuns: () => ok(roster.current),
      readFlow: () => ok(flow(options.interactive)),
      readRun: () => ok(record({ interactive: options.interactive, status: options.status ?? 'running' })),
      readTemplate: () => ok({ id: TEMPLATE, name: 'Builder', createdAt: 'a', updatedAt: 'a' }),
      saveFlow: () => ok(flow(options.interactive)),
      deleteFlow: () => ok(undefined),
      saveTemplate: () => ok({ id: TEMPLATE, name: 'Builder', createdAt: 'a', updatedAt: 'a' }),
      deleteTemplate: () => ok(undefined),
      cancel: () => ok(undefined),
      concludeConversation: () => ok(undefined),
      start: () => ok(record({ interactive: options.interactive, status: 'running' })),
    },
    session: {
      list: () => ok({
        items: [{ sessionId: SESSION, agentAvailable: true, updatedAt: 1, running: false, blank: false, occupied: false }],
      }),
      modelCatalog: () => ok({
        default: { provider: 'deepseek', model: 'chat' },
        routableProviders: ['deepseek'],
        groups: [],
        failures: [],
      }),
    },
  }
  const controller = new AgentFlowController(remote, () => {}, () => {})
  const sessions: SessionObservationSource = {
    retain: (target: SessionTarget) => {
      expect(target).toBe(NODE)
      return {
        binding: {
          eventSource: feed,
          session: {
            getSnapshot: () => live,
            subscribe: (listener: () => void) => {
              liveListeners.add(listener)
              return () => { liveListeners.delete(listener) }
            },
          },
        },
        release: () => { released.push(NODE) },
      }
    },
  }
  const tracker = new NodeActivityTracker(
    sessions,
    {
      getSnapshot: () => status,
      subscribe: (listener: () => void) => {
        statusListeners.add(listener)
        return () => { statusListeners.delete(listener) }
      },
    },
    (sessionId, observation) => { controller.noteActivity(sessionId, observation) },
  )
  const stopTracking = controller.state.subscribe(() => {
    tracker.sync(controller.state.getSnapshot().runs)
  })
  await controller.load()

  const props: FlowRunProgressProps = {
    openRun: () => {},
    openSession: () => {},
    cancelRun: async () => {},
    sessionId: SESSION,
    session: SESSION_SEAT,
    input: INPUT_SEAT,
    useAgentFlow: bindSnapshotSelector(controller.state),
    stallNoticeMs: 600_000,
    useSession: () => { throw new Error('unused') },
    useInput: () => { throw new Error('unused') },
    inputActions: {} as never,
    useProjection: () => { throw new Error('unused') },
    useConversation: () => { throw new Error('unused') },
    useChat: () => { throw new Error('unused') },
    useTrajectory: () => { throw new Error('unused') },
    usePanelInfo: () => { throw new Error('unused') },
    useSessions: () => { throw new Error('unused') },
    useSessionStatus: () => { throw new Error('unused') },
    useSessionRetainInfo: () => { throw new Error('unused') },
    useWorkspaces: () => { throw new Error('unused') },
    useResource: () => { throw new Error('unused') },
    t: makeTranslate(zh),
  }
  render(<FlowRunProgress {...props} />)
  return {
    controller, tracker, feed, live, status, statusListeners, released, roster,
    publishSession: () => { for (const listener of [...liveListeners]) listener() },
    dispose: () => { stopTracking(); tracker.dispose() },
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('live activity chain', () => {
  it('keeps a reasoning stream card active past the record-based stall threshold', async () => {
    const { feed, dispose } = await chain({ interactive: false })
    expect(screen.getByText('执行中')).not.toBeNull()

    act(() => {
      feed.append({ type: 'event', event: durable('turn/start', { turn: 1 }, NOW - 19 * 60_000, 1) })
      feed.append({ type: 'event', event: durable('step/start', { turn: 1, step: 1 }, NOW - 19 * 60_000, 2) })
      feed.append({
        type: 'transient',
        event: {
          type: 'assistant/live-chunk',
          seq: NOW - 1_000,
          time: NOW - 1_000,
          data: { attemptId: 'attempt-1' as never, turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'x' } },
        },
      })
    })

    /* The record has not moved for twenty minutes; the stream is current. */
    expect(screen.getByText('推理中')).not.toBeNull()
    expect(screen.getByText('刚刚')).not.toBeNull()
    expect(screen.queryByText(/较长时间没有新的活动/)).toBeNull()
    expect(screen.getByRole('button', { name: '查看推理过程' })).not.toBeNull()
    dispose()
  })

  it('waits for the user, then stops waiting once the Session works on the reply', async () => {
    const { feed, live, status, statusListeners, dispose } = await chain({ interactive: true })
    expect(screen.getByText('流程等待你回复')).not.toBeNull()

    /* The user replied: the submission is in flight before the turn opens. */
    act(() => {
      live.pendingSubmissions = [{ id: 'message-1' } as never]
      for (const listener of [...statusListeners]) listener()
    })
    expect(screen.getByText('流程执行中')).not.toBeNull()
    expect(screen.queryByText('流程等待你回复')).toBeNull()

    /* The turn opened and reasoning is arriving. */
    act(() => {
      live.pendingSubmissions = []
      live.running = true
      feed.append({ type: 'event', event: durable('turn/start', { turn: 2 }, NOW - 5_000, 3) })
      feed.append({
        type: 'transient',
        event: {
          type: 'assistant/live-chunk',
          seq: NOW - 1_000,
          time: NOW - 1_000,
          data: { attemptId: 'attempt-2' as never, turn: 2, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'x' } },
        },
      })
    })
    expect(screen.getByText('流程执行中')).not.toBeNull()
    expect(screen.getByText('推理中')).not.toBeNull()

    /* The model asks inside the turn: the user owes an answer again. */
    act(() => {
      status.set(NODE, {
        running: false,
        pendingInteraction: { key: 'question-1', kind: 'question', sessionId: NODE } as never,
        completionUnread: false,
      })
      for (const listener of [...statusListeners]) listener()
    })
    expect(screen.getByText('流程等待你回复')).not.toBeNull()
    dispose()
  })

  it('keeps following the node after its attempt settles', async () => {
    const { feed, dispose } = await chain({ interactive: false })
    act(() => {
      feed.append({ type: 'event', event: durable('turn/start', { turn: 1 }, NOW - 19 * 60_000, 1) })
      feed.append({
        type: 'transient',
        event: {
          type: 'assistant/live-chunk',
          seq: NOW - 2_000,
          time: NOW - 2_000,
          data: { attemptId: 'attempt-1' as never, turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'x' } },
        },
      })
    })
    expect(screen.getByText('推理中')).not.toBeNull()

    /* The settlement removes the streamed rows; the next durable event must
       still reach the card. */
    act(() => {
      feed.settleAssistant('attempt-1' as never)
      feed.append({
        type: 'event',
        event: durable('tool/call', { turn: 1, step: 1, callId: 'call-1' as never, name: 'read', arguments: '{}' }, NOW - 1_000, 4),
      })
    })
    expect(screen.getByText('执行工具')).not.toBeNull()
    dispose()
  })

  it('reports a lost node stream instead of reading it as silence', async () => {
    const { feed, live, publishSession, dispose } = await chain({ interactive: false })
    act(() => {
      feed.append({ type: 'event', event: durable('turn/start', { turn: 1 }, NOW - 30 * 60_000, 1) })
      feed.append({
        type: 'transient',
        event: {
          type: 'assistant/live-chunk',
          seq: NOW - 20 * 60_000,
          time: NOW - 20 * 60_000,
          data: { attemptId: 'attempt-1' as never, turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'x' } },
        },
      })
    })
    /* Quiet past the threshold, but the fold alone cannot say the run stalled. */
    expect(screen.getByText(/较长时间没有新的活动/)).not.toBeNull()

    act(() => {
      live.openState = 'error'
      publishSession()
    })
    expect(screen.getByText('连接中断')).not.toBeNull()
    expect(screen.queryByText(/较长时间没有新的活动/)).toBeNull()
    dispose()
  })

  it('releases the node Session and reads the recorded outcome once the run settles', async () => {
    const { controller, released, roster, dispose } = await chain({ interactive: false })
    roster.current = [record({ interactive: false, status: 'completed' })]
    await act(async () => { await controller.load() })
    expect(released).toEqual([NODE])
    expect(screen.getByText('流程已完成')).not.toBeNull()
    expect(screen.getByText('成功')).not.toBeNull()
    dispose()
  })
})
