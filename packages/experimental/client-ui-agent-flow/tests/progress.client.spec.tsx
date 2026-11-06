// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { AgentTemplateId, FlowDocument, FlowId, FlowNodeRun, FlowRun, FlowRunId } from '@deepseek-ai/dsh-experimental-agent-flow/types'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { FlowRunProgress, type FlowRunProgressProps } from '../src/client/FlowRunProgress.tsx'
import type { NodeObservation } from '../src/client/activity-tracker.ts'
import type { AgentFlowSnapshot } from '../src/client/controller.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const SESSION = 'session-1' as SessionId
const OTHER_PARENT = 'session-2' as SessionId
const NODE_SESSION = 'flow-node' as SessionId
const FLOW = 'flow-1' as FlowId
const RUN = 'run-1' as FlowRunId
const TEMPLATE = 'template-1' as AgentTemplateId

function flowDocument(): FlowDocument {
  return {
    id: FLOW,
    name: 'Simple flow',
    maxIterations: 16,
    nodes: [
      { kind: 'start', id: 'start' },
      { kind: 'agent', id: 'design', templateId: TEMPLATE, instruction: 'design', interactive: true },
      { kind: 'agent', id: 'implement', templateId: TEMPLATE, instruction: 'implement' },
      { kind: 'agent', id: 'review', templateId: TEMPLATE, instruction: 'review' },
      { kind: 'end', id: 'end' },
    ],
    edges: [
      { kind: 'execution', from: 'start', to: 'design' },
      { kind: 'execution', from: 'design', to: 'implement' },
      { kind: 'execution', from: 'implement', to: 'review' },
      { kind: 'execution', from: 'review', to: 'end' },
    ],
    createdAt: '2026-11-04T00:00:00.000Z',
    updatedAt: '2026-11-04T00:00:00.000Z',
  }
}

const START = '2026-11-04T10:47:25.000Z'
const DESIGN_END = '2026-11-04T10:49:00.000Z'
const IMPLEMENT_START = '2026-11-04T10:49:01.000Z'

function run(overrides: Partial<FlowRun> = {}): FlowRun {
  return {
    id: RUN,
    flowId: FLOW,
    snapshot: flowDocument(),
    parentSessionId: SESSION,
    status: 'running',
    input: 'build a sorter',
    nodeRuns: [
      { nodeId: 'start', iteration: 0, status: 'succeeded' },
      { nodeId: 'design', iteration: 0, status: 'succeeded', agentSessionId: NODE_SESSION, startedAt: START, endedAt: DESIGN_END },
      { nodeId: 'implement', iteration: 0, status: 'running', agentSessionId: 'worker-1' as SessionId, startedAt: IMPLEMENT_START },
      { nodeId: 'end', iteration: 0, status: 'pending' },
    ],
    startedAt: START,
    ...overrides,
  }
}

function unusedHook(): never {
  throw new Error('The progress card reads only its face and the shared roster store')
}

/** The Session seat the slot type requires; the card reads none of it. */
const SESSION_SEAT: SessionSnapshot = {
  sessionId: SESSION, running: true, removed: false, openState: 'open', openError: null,
  hasMore: false, loadingOlder: false, promptError: null, blank: false, subagent: null,
  pendingSubmissions: [], lastAgentError: null, promptAttempted: true, awaitingFirstTurn: false,
}

/** The composer seat the slot type requires; the card reads none of it. */
const INPUT_SEAT: InputState = {
  draft: '', attachmentIds: [], draftRev: 0, phase: 'plain', occurrences: [], queue: [],
}

/** One published node observation, over the defaults a working Session has. */
function observation(overrides: Partial<NodeObservation> = {}): NodeObservation {
  return {
    stage: 'reasoning',
    tools: [],
    observed: true,
    running: true,
    pendingSubmissions: 0,
    pendingInteraction: false,
    streamFailed: false,
    ...overrides,
  }
}

interface BenchOptions {
  runs?: FlowRun[]
  syncError?: string
  sessions?: AgentFlowSnapshot['sessions']
  nodeActivity?: AgentFlowSnapshot['nodeActivity']
  /** Freeze the clock for relative wording and the stall threshold. */
  now?: number
  stallNoticeMs?: number
}

/** Render the progress card over one controllable roster store and a frozen clock. */
function bench(options: BenchOptions = {}) {
  const roster = createSnapshotStore<AgentFlowSnapshot>({
    status: 'ready',
    flows: [flowDocument()],
    templates: [{ id: TEMPLATE, name: '实现', createdAt: 'a', updatedAt: 'a' }],
    runs: options.runs ?? [run()],
    sessions: options.sessions ?? [{ id: SESSION, live: true }],
    modelGroups: [],
    view: 'runs',
    nodeActivity: options.nodeActivity ?? {},
    ...(options.syncError === undefined ? {} : { syncError: options.syncError }),
  })
  if (options.now !== undefined) vi.spyOn(Date, 'now').mockReturnValue(options.now)
  const face = {
    openRun: vi.fn(),
    openSession: vi.fn(),
    cancelRun: vi.fn(async () => {}),
  }
  const props: FlowRunProgressProps = {
    ...face,
    sessionId: SESSION,
    session: SESSION_SEAT,
    input: INPUT_SEAT,
    useAgentFlow: bindSnapshotSelector(roster),
    stallNoticeMs: options.stallNoticeMs ?? 600_000,
    /* The card reads no other standard source; these seats must stay unused. */
    useSession: unusedHook,
    useInput: unusedHook,
    inputActions: {} as never,
    useProjection: unusedHook,
    useConversation: unusedHook,
    useChat: unusedHook,
    useTrajectory: unusedHook,
    usePanelInfo: unusedHook,
    useSessions: unusedHook,
    useSessionStatus: unusedHook,
    useSessionRetainInfo: unusedHook,
    useWorkspaces: unusedHook,
    useResource: unusedHook,
    t: makeTranslate(zh),
  }
  const rendered = render(<FlowRunProgress {...props} />)
  return { roster, face, container: rendered.container }
}

describe('FlowRunProgress', () => {
  it('renders nothing for a session no run involves', () => {
    const { container } = bench({ runs: [] })
    expect(container.firstChild).toBeNull()
  })

  it('renders for a node session even though a different session started the run', () => {
    const { container } = bench({
      now: Date.parse('2026-11-04T10:57:25.000Z'),
      runs: [{ ...run(), parentSessionId: OTHER_PARENT, nodeRuns: [
        { nodeId: 'implement', iteration: 0, status: 'running', agentSessionId: SESSION, startedAt: IMPLEMENT_START },
      ] }],
    })
    expect(container.querySelector('[data-flow-progress]')).not.toBeNull()
    expect(screen.getByText('流程执行中')).not.toBeNull()
  })

  it('shows the live phase, the current node, and the last recorded activity', () => {
    bench({ now: Date.parse('2026-11-04T10:49:30.000Z') })
    expect(screen.getByLabelText('流程进度')).not.toBeNull()
    expect(screen.getByText('流程执行中')).not.toBeNull()
    expect(screen.getByText('Simple flow')).not.toBeNull()
    expect(screen.getByText('已进行 2 分钟')).not.toBeNull()
    /* The blocked successor names its live predecessor; the conversational
       node reads as the latest completion. */
    expect(screen.getByText('等待 实现')).not.toBeNull()
    expect(screen.getByText('最近活动：实现 开始 · 刚刚')).not.toBeNull()
  })

  it('opens the live node first and the run record for the full flow', () => {
    const { face } = bench({ now: Date.parse('2026-11-04T10:57:25.000Z') })
    fireEvent.click(screen.getByRole('button', { name: '查看当前节点' }))
    expect(face.openSession).toHaveBeenCalledExactlyOnceWith('worker-1' as SessionId)
    fireEvent.click(screen.getByRole('button', { name: '查看完整流程' }))
    expect(face.openRun).toHaveBeenCalledExactlyOnceWith(RUN)
  })

  it("reads a conversing flow as waiting for the user and opens that node's session", () => {
    bench({
      now: Date.parse('2026-11-04T10:57:25.000Z'),
      runs: [run({
        nodeRuns: [
          { nodeId: 'start', iteration: 0, status: 'succeeded' },
          { nodeId: 'design', iteration: 0, status: 'conversing', agentSessionId: NODE_SESSION, startedAt: START },
        ],
      })],
    })
    expect(screen.getByText('流程等待你回复')).not.toBeNull()
    expect(screen.getByText('等待你回复')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '查看当前节点' }))
    expect(screen.getByRole('button', { name: '查看当前节点' })).not.toBeNull()
  })

  it('reports a quiet run without claiming a failure and offers the cancel entry', () => {
    bench({
      now: Date.parse(DESIGN_END) + 600_000,
      runs: [run({ nodeRuns: [
        { nodeId: 'design', iteration: 0, status: 'running', agentSessionId: NODE_SESSION, startedAt: START },
      ] })],
    })
    expect(screen.getByText('较长时间没有新的活动')).not.toBeNull()
    expect(screen.getByText(/流程仍在运行，但最近没有新的记录/)).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.getByRole('button', { name: '取消中…' })).toHaveProperty('disabled', true)
  })

  it('keeps the cancelling posture until the roster confirms the run settled', async () => {
    const { roster, face } = bench({ now: Date.parse('2026-11-04T10:57:25.000Z') })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(face.cancelRun).toHaveBeenCalledExactlyOnceWith(SESSION, RUN)
    await act(async () => {})
    expect(screen.getByRole('button', { name: '取消中…' })).not.toBeNull()

    /* The roster still says running: the card must not claim a cancellation. */
    expect(screen.getByRole('button', { name: '取消中…' })).not.toBeNull()

    /* The roster confirms the run settled: the posture ends and the card
       reads the run's recorded outcome. */
    act(() => { roster.update((current) => { current.runs = [run({ status: 'cancelled' })] }) })
    expect(screen.getByText('流程已取消')).not.toBeNull()
    expect(screen.queryByRole('button', { name: '取消中…' })).toBeNull()
  })

  it('shows a failed cancel inline and re-enables the entry', async () => {
    const { face } = bench({ now: Date.parse('2026-11-04T10:57:25.000Z') })
    face.cancelRun.mockRejectedValueOnce(new Error('session gone'))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('取消失败：session gone') })
    expect(screen.getByRole('button', { name: '取消' })).toHaveProperty('disabled', false)
    /* A host rejection that is not an Error still states its reason. */
    face.cancelRun.mockRejectedValueOnce('plain')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('取消失败：plain') })
  })

  it('marks last-known state while reads fail and drops the mark when they recover', () => {
    const { roster } = bench({ syncError: 'offline', now: Date.parse('2026-11-04T10:57:25.000Z') })
    expect(screen.getByText('状态更新中断，以下为最后已知状态')).not.toBeNull()
    /* The run's own state still renders under the mark. */
    expect(screen.getByText('流程执行中')).not.toBeNull()
    act(() => { roster.update((current) => { current.syncError = undefined }) })
    expect(screen.queryByText('状态更新中断，以下为最后已知状态')).toBeNull()
  })

  it('does not raise the stall notice for a settled run or inside the threshold', () => {
    bench({
      now: Date.parse(DESIGN_END) + 600_000,
      runs: [run({ status: 'completed', endedAt: DESIGN_END })],
    })
    expect(screen.queryByText('较长时间没有新的活动')).toBeNull()
    expect(screen.getByText('流程已完成')).not.toBeNull()
  })

  it("picks between a session's runs explicitly instead of taking a random first", () => {
    const older = { ...run(), id: 'run-2' as FlowRunId, status: 'completed' as const, startedAt: '2026-11-03T00:00:00.000Z' }
    bench({
      now: Date.parse('2026-11-04T10:57:25.000Z'),
      runs: [older, run()],
    })
    /* The live run is the deterministic default, labelled with its flow name. */
    expect(screen.getByRole('button', { name: '选择要查看的运行' }).textContent).toBe('Simple flow')
    fireEvent.click(screen.getByRole('button', { name: '选择要查看的运行' }))
    /* Escape closes the picker without choosing a run. */
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menuitem', { name: 'Simple flow · 已完成 · build a sorter' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '选择要查看的运行' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Simple flow · 已完成 · build a sorter' }))
    expect(screen.getByText('流程已完成')).not.toBeNull()
  })

  it('names concurrent runs of one flow by the request that started each', () => {
    const early = { ...run(), id: 'run-early' as FlowRunId, input: 'audit the parser' }
    const late = { ...run(), id: 'run-late' as FlowRunId, input: 'audit the lexer' }
    bench({
      now: Date.parse('2026-11-04T10:57:25.000Z'),
      runs: [late, early],
    })
    fireEvent.click(screen.getByRole('button', { name: '选择要查看的运行' }))
    expect(screen.getByRole('menuitem', { name: 'Simple flow · 运行中 · audit the parser' })).not.toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Simple flow · 运行中 · audit the lexer' })).not.toBeNull()
  })

  it('falls back to the start clock when requests match', () => {
    const first = { ...run(), id: 'run-x' as FlowRunId, input: 'same request', startedAt: '2026-11-04T10:47:25.000Z' }
    const second = { ...run(), id: 'run-y' as FlowRunId, input: 'same request', startedAt: '2026-11-04T10:47:31.000Z' }
    bench({
      now: Date.parse('2026-11-04T10:57:25.000Z'),
      runs: [second, first],
    })
    fireEvent.click(screen.getByRole('button', { name: '选择要查看的运行' }))
    const labels = screen.getAllByRole('menuitem').map(item => item.textContent ?? '')
    expect(new Set(labels).size).toBe(2)
    for (const label of labels) {
      expect(label).toMatch(/^Simple flow · 运行中 · same request · \d{2}:\d{2}:\d{2}$/)
    }
  })

  it('falls back to the run identity when two runs start inside the same second', () => {
    const first = { ...run(), id: 'run-x' as FlowRunId, input: 'same request', startedAt: '2026-11-04T10:47:25.000Z' }
    const second = { ...run(), id: 'run-y' as FlowRunId, input: 'same request', startedAt: '2026-11-04T10:47:25.000Z' }
    bench({
      now: Date.parse('2026-11-04T10:57:25.000Z'),
      runs: [second, first],
    })
    fireEvent.click(screen.getByRole('button', { name: '选择要查看的运行' }))
    const labels = screen.getAllByRole('menuitem').map(item => item.textContent ?? '').sort()
    expect(labels[0]).toMatch(/^Simple flow · 运行中 · same request · \d{2}:\d{2}:\d{2} · #run-x$/)
    expect(labels[1]).toMatch(/^Simple flow · 运行中 · same request · \d{2}:\d{2}:\d{2} · #run-y$/)
  })

  it('bounds a long request summary and omits an empty one', () => {
    bench({
      now: Date.parse('2026-11-04T10:57:25.000Z'),
      runs: [
        { ...run(), id: 'run-long' as FlowRunId, input: 'x'.repeat(60) },
        { ...run(), id: 'run-empty' as FlowRunId, input: '' },
      ],
    })
    fireEvent.click(screen.getByRole('button', { name: '选择要查看的运行' }))
    const labels = screen.getAllByRole('menuitem').map(item => item.textContent ?? '')
    expect(labels).toContain(`Simple flow · 运行中 · ${'x'.repeat(39)}…`)
    expect(labels).toContain('Simple flow · 运行中')
  })

  it('keeps an unparseable start value verbatim before the identity suffix', () => {
    const first = { ...run(), id: 'run-x' as FlowRunId, input: 'same request', startedAt: 'not-a-date' }
    const second = { ...run(), id: 'run-y' as FlowRunId, input: 'same request', startedAt: 'not-a-date' }
    bench({
      now: Date.parse('2026-11-04T10:57:25.000Z'),
      runs: [second, first],
    })
    fireEvent.click(screen.getByRole('button', { name: '选择要查看的运行' }))
    const labels = screen.getAllByRole('menuitem').map(item => item.textContent ?? '').sort()
    expect(labels[0]).toBe('Simple flow · 运行中 · same request · not-a-date · #run-x')
    expect(labels[1]).toBe('Simple flow · 运行中 · same request · not-a-date · #run-y')
  })

  it("hides the cancel entry once the run's parent session no longer owns a live agent", () => {
    bench({
      now: Date.parse('2026-11-04T10:57:25.000Z'),
      sessions: [{ id: SESSION, live: false }],
    })
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull()
    expect(screen.getByRole('button', { name: '查看完整流程' })).not.toBeNull()
  })

  it('shows the loop round on a reworked node', () => {
    bench({
      now: Date.parse('2026-11-04T10:57:25.000Z'),
      runs: [run({ nodeRuns: [
        { nodeId: 'design', iteration: 0, status: 'succeeded', agentSessionId: NODE_SESSION, startedAt: START, endedAt: DESIGN_END },
        { nodeId: 'implement', iteration: 0, status: 'succeeded', agentSessionId: 'worker-1' as SessionId, startedAt: DESIGN_END },
        { nodeId: 'implement', iteration: 1, status: 'running', agentSessionId: 'worker-1' as SessionId, startedAt: '2026-11-04T10:56:00.000Z' },
      ] })],
    })
    expect(screen.getByText('第 2 轮')).not.toBeNull()
    expect(screen.getByText('最近活动：实现 开始 · 1 分钟前')).not.toBeNull()
  })

  it('reads a live reasoning stream as active work instead of a quiet record', () => {
    const now = Date.parse('2026-11-04T10:59:05.000Z')
    bench({
      /* The record has not moved for ten minutes; the Session stream has. */
      now,
      nodeActivity: { 'worker-1': observation({ lastAt: now - 1_000 }) },
    })
    expect(screen.getByText('推理中')).not.toBeNull()
    expect(screen.getByText('刚刚')).not.toBeNull()
    expect(screen.queryByText('较长时间没有新的活动')).toBeNull()
    /* The live stage replaces the record line rather than stacking above it. */
    expect(screen.queryByText(/最近活动/)).toBeNull()
    expect(screen.getByRole('button', { name: '查看推理过程' })).not.toBeNull()
  })

  it('raises the stall notice again once the observed stream goes quiet', () => {
    const now = Date.parse('2026-11-04T11:09:05.000Z')
    bench({
      now,
      nodeActivity: { 'worker-1': observation({ lastAt: now - 600_000 }) },
    })
    /* The quiet node is named, so one busy branch cannot hide another. */
    expect(screen.getByText(/实现 较长时间没有新的活动/)).not.toBeNull()
    expect(screen.getByText('10 分钟前')).not.toBeNull()
  })

  it('does not claim the user owes a reply while the conversational node is working', () => {
    const now = Date.parse('2026-11-04T10:50:00.000Z')
    bench({
      now,
      runs: [run({ nodeRuns: [
        { nodeId: 'start', iteration: 0, status: 'succeeded' },
        { nodeId: 'design', iteration: 0, status: 'conversing', agentSessionId: NODE_SESSION, startedAt: START },
      ] })],
      nodeActivity: { [String(NODE_SESSION)]: observation({ stage: 'reasoning', lastAt: now }) },
    })
    /* The record still says conversing; the working Session says otherwise. */
    expect(screen.getByText('流程执行中')).not.toBeNull()
    expect(screen.queryByText('流程等待你回复')).toBeNull()
    expect(screen.getByText('推理中')).not.toBeNull()
  })

  it('stops waiting as soon as the user submitted and the reply has not landed', () => {
    bench({
      now: Date.parse('2026-11-04T10:50:00.000Z'),
      runs: [run({ nodeRuns: [
        { nodeId: 'start', iteration: 0, status: 'succeeded' },
        { nodeId: 'design', iteration: 0, status: 'conversing', agentSessionId: NODE_SESSION, startedAt: START },
      ] })],
      nodeActivity: {
        [String(NODE_SESSION)]: observation({ stage: 'preparing', running: false, pendingSubmissions: 1 }),
      },
    })
    expect(screen.getByText('流程执行中')).not.toBeNull()
    expect(screen.getByText('准备执行')).not.toBeNull()
  })

  it('judges the waiting node and another running one separately', () => {
    const now = Date.parse('2026-11-04T10:59:05.000Z')
    bench({
      now,
      runs: [run({ nodeRuns: [
        { nodeId: 'start', iteration: 0, status: 'succeeded' },
        { nodeId: 'design', iteration: 0, status: 'conversing', agentSessionId: NODE_SESSION, startedAt: START },
        { nodeId: 'implement', iteration: 0, status: 'running', agentSessionId: 'worker-1' as SessionId, startedAt: IMPLEMENT_START },
      ] })],
      nodeActivity: {
        /* The waiting node is idle by design, not quiet. */
        [String(NODE_SESSION)]: observation({ stage: 'preparing', running: false, pendingInteraction: true, lastAt: now }),
        /* The other node is executing and has produced nothing for a while. */
        'worker-1': observation({ stage: 'tool', tools: [{ callId: 'call-1', name: 'read' }], lastAt: now - 700_000 }),
      },
    })
    expect(screen.getByText('流程等待你回复')).not.toBeNull()
    expect(screen.getByText(/较长时间没有新的活动/)).not.toBeNull()
  })

  it('waits again while the model asked a question inside the open turn', () => {
    bench({
      now: Date.parse('2026-11-04T10:50:00.000Z'),
      runs: [run({ nodeRuns: [
        { nodeId: 'start', iteration: 0, status: 'succeeded' },
        { nodeId: 'design', iteration: 0, status: 'conversing', agentSessionId: NODE_SESSION, startedAt: START },
      ] })],
      nodeActivity: { [String(NODE_SESSION)]: observation({ stage: 'preparing', pendingInteraction: true }) },
    })
    expect(screen.getByText('流程等待你回复')).not.toBeNull()
    expect(screen.getByText('等待你回复')).not.toBeNull()
  })

  it("shows each parallel node's own stage and business age", () => {
    const now = Date.parse('2026-11-04T10:59:05.000Z')
    bench({
      now,
      runs: [run({ nodeRuns: [
        { nodeId: 'implement', iteration: 0, status: 'running', agentSessionId: 'worker-1' as SessionId, startedAt: IMPLEMENT_START },
        { nodeId: 'review', iteration: 0, status: 'running', agentSessionId: 'worker-2' as SessionId, startedAt: IMPLEMENT_START },
      ] })],
      nodeActivity: {
        'worker-1': observation({ lastAt: now }),
        'worker-2': observation({ stage: 'tool', tools: [{ callId: 'call-1', name: 'read' }], lastAt: now - 300_000 }),
      },
    })
    expect(screen.getByText('推理中')).not.toBeNull()
    expect(screen.getByText('执行工具')).not.toBeNull()
    /* The busy node must not hide the other one's age. */
    expect(screen.getByText('5 分钟前')).not.toBeNull()
    expect(screen.getByText('刚刚')).not.toBeNull()
  })

  it("opens one node's own session from its detail entry", () => {
    const { face } = bench({
      now: Date.parse('2026-11-04T10:57:25.000Z'),
      runs: [run({ nodeRuns: [
        { nodeId: 'implement', iteration: 0, status: 'running', agentSessionId: 'worker-1' as SessionId, startedAt: IMPLEMENT_START },
      ] })],
    })
    fireEvent.click(screen.getByRole('button', { name: '查看 实现 的会话' }))
    expect(face.openSession).toHaveBeenCalledExactlyOnceWith('worker-1' as SessionId)
  })

  it('falls back to the recorded status for a stage without evidence', () => {
    bench({
      now: Date.parse('2026-11-04T10:57:25.000Z'),
      nodeActivity: { 'worker-1': observation({ stage: 'unknown' }) },
    })
    expect(screen.getByText('执行中')).not.toBeNull()
    expect(screen.queryByText('状态未知')).toBeNull()
  })

  it('never raises the quiet notice on a settled run, however old its retained observations are', () => {
    const now = Date.parse('2026-11-04T10:59:05.000Z')
    const cases: readonly FlowRun['status'][] = ['completed', 'failed', 'cancelled']
    for (const status of cases) {
      bench({
        now,
        runs: [run({
          status,
          endedAt: DESIGN_END,
          nodeRuns: [
            { nodeId: 'start', iteration: 0, status: 'succeeded' },
            {
              nodeId: 'implement', iteration: 0, status: status === 'completed' ? 'succeeded' : 'failed',
              agentSessionId: 'worker-1' as SessionId, startedAt: IMPLEMENT_START, endedAt: DESIGN_END,
            },
          ],
        })],
        nodeActivity: { 'worker-1': observation({ running: false, lastAt: now - 900_000 }) },
      })
      expect(screen.queryByText(/较长时间没有新的活动/)).toBeNull()
      cleanup()
    }
  })

  it('excludes a settled predecessor and keeps a fresh running node quiet-free', () => {
    const now = Date.parse('2026-11-04T10:59:05.000Z')
    bench({
      now,
      runs: [run({ nodeRuns: [
        { nodeId: 'start', iteration: 0, status: 'succeeded' },
        { nodeId: 'design', iteration: 0, status: 'succeeded', agentSessionId: NODE_SESSION, startedAt: START, endedAt: DESIGN_END },
        { nodeId: 'implement', iteration: 0, status: 'running', agentSessionId: 'worker-1' as SessionId, startedAt: IMPLEMENT_START },
      ] })],
      nodeActivity: {
        /* The settled predecessor keeps its last observation for reading. */
        [String(NODE_SESSION)]: observation({ running: false, lastAt: now - 900_000 }),
        'worker-1': observation({ lastAt: now }),
      },
    })
    expect(screen.queryByText(/较长时间没有新的活动/)).toBeNull()
  })

  it("keeps one branch's lost stream from hiding another branch's quiet", () => {
    const now = Date.parse('2026-11-04T10:59:05.000Z')
    bench({
      now,
      runs: [run({ nodeRuns: [
        { nodeId: 'implement', iteration: 0, status: 'running', agentSessionId: 'worker-1' as SessionId, startedAt: IMPLEMENT_START },
        { nodeId: 'review', iteration: 0, status: 'running', agentSessionId: 'worker-2' as SessionId, startedAt: IMPLEMENT_START },
      ] })],
      nodeActivity: {
        'worker-1': observation({ streamFailed: true, lastAt: now - 900_000 }),
        'worker-2': observation({ stage: 'tool', tools: [{ callId: 'call-1', name: 'read' }], lastAt: now - 900_000 }),
      },
    })
    expect(screen.getByText('连接中断')).not.toBeNull()
    expect(screen.getByText(/较长时间没有新的活动/)).not.toBeNull()
  })

  it('reports a closed turn without moving the node back to a generating stage', () => {
    bench({
      now: Date.parse('2026-11-04T10:57:25.000Z'),
      nodeActivity: { 'worker-1': observation({ stage: 'finished', running: false }) },
    })
    expect(screen.getByText('本轮已结束')).not.toBeNull()
  })

  it('keeps the recorded outcome of a settled run even when an observation lingers', () => {
    bench({
      now: Date.parse('2026-11-04T10:57:25.000Z'),
      runs: [run({
        status: 'completed',
        endedAt: DESIGN_END,
        nodeRuns: [
          { nodeId: 'start', iteration: 0, status: 'succeeded' },
          { nodeId: 'implement', iteration: 0, status: 'succeeded', agentSessionId: 'worker-1' as SessionId, startedAt: IMPLEMENT_START, endedAt: DESIGN_END },
        ],
      })],
      nodeActivity: { 'worker-1': observation() },
    })
    expect(screen.getByText('流程已完成')).not.toBeNull()
    expect(screen.getByText('成功')).not.toBeNull()
    expect(screen.queryByText('推理中')).toBeNull()
  })

  it('reads a run under a minute and one past an hour', () => {
    bench({
      now: Date.parse('2026-11-04T10:47:40.000Z'),
      runs: [run({ startedAt: '2026-11-04T10:47:25.000Z' })],
    })
    expect(screen.getByText('已进行 不足 1 分钟')).not.toBeNull()
    cleanup()
    bench({
      now: Date.parse('2026-11-04T13:49:25.000Z'),
      runs: [run({ startedAt: '2026-11-04T10:47:25.000Z' })],
    })
    expect(screen.getByText('已进行 3 小时 2 分钟')).not.toBeNull()
  })

  it('re-reads the clock while the card shows', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-04T10:47:40.000Z'))
    bench({ runs: [run({ startedAt: '2026-11-04T10:47:25.000Z' })] })
    expect(screen.getByText('已进行 不足 1 分钟')).not.toBeNull()
    act(() => {
      vi.setSystemTime(new Date('2026-11-04T10:49:40.000Z'))
      vi.advanceTimersByTime(1_000)
    })
    expect(screen.getByText('已进行 2 分钟')).not.toBeNull()
  })

  it('phrases an observed age in each relative bucket', () => {
    const now = Date.parse('2026-11-04T12:00:00.000Z')
    const cases: readonly [number, string][] = [
      [2 * 3_600_000, '2 小时前'],
      [3 * 86_400_000, '3 天前'],
      [40 * 86_400_000, '1 个月前'],
      [400 * 86_400_000, '1 年前'],
    ]
    for (const [age, text] of cases) {
      bench({ now, nodeActivity: { 'worker-1': observation({ lastAt: now - age }) } })
      expect(screen.getByText(text)).not.toBeNull()
      cleanup()
    }
  })

  it('phrases a recorded run-level transition it has no live stage for', () => {
    const early = '2026-11-04T10:00:00.000Z'
    const cases: readonly [FlowRun['status'], string][] = [
      ['completed', '流程完成'],
      ['failed', '流程失败'],
      ['cancelled', '流程取消'],
    ]
    for (const [status, text] of cases) {
      bench({
        now: Date.parse('2026-11-04T10:10:00.000Z'),
        runs: [run({
          status,
          startedAt: early,
          endedAt: '2026-11-04T10:05:00.000Z',
          nodeRuns: [{
            nodeId: 'design', iteration: 0, status: 'failed', startedAt: '2026-11-04T10:00:30.000Z', endedAt: '2026-11-04T10:04:00.000Z',
          }],
        })],
      })
      expect(screen.getByText(new RegExp(`最近活动：${text}`))).not.toBeNull()
      cleanup()
    }
    bench({
      now: Date.parse('2026-11-04T10:10:00.000Z'),
      runs: [run({ startedAt: early, nodeRuns: [] })],
    })
    expect(screen.getByText(/最近活动：流程开始/)).not.toBeNull()
  })

  it('phrases each recorded node ending it has no live stage for', () => {
    const cases: readonly [FlowNodeRun['status'], string][] = [
      ['succeeded', '实现 完成'],
      ['failed', '实现 失败'],
      ['skipped', '实现 跳过'],
    ]
    for (const [status, text] of cases) {
      bench({
        now: Date.parse('2026-11-04T10:10:00.000Z'),
        runs: [run({
          startedAt: '2026-11-04T10:00:00.000Z',
          nodeRuns: [{
            nodeId: 'implement', iteration: 0, status, startedAt: '2026-11-04T10:00:30.000Z', endedAt: '2026-11-04T10:05:00.000Z',
          }],
        })],
      })
      expect(screen.getByText(new RegExp(`最近活动：${text}`))).not.toBeNull()
      cleanup()
    }
  })

  it('reads a run whose graph has no conversational node', () => {
    bench({
      now: Date.parse('2026-11-04T10:57:25.000Z'),
      runs: [run({
        snapshot: {
          ...flowDocument(),
          nodes: [
            { kind: 'start', id: 'start' },
            { kind: 'agent', id: 'design', templateId: TEMPLATE, instruction: 'design' },
            { kind: 'end', id: 'end' },
          ],
          edges: [{ kind: 'execution', from: 'start', to: 'design' }, { kind: 'execution', from: 'design', to: 'end' }],
        },
      })],
    })
    expect(screen.getByText('流程执行中')).not.toBeNull()
  })

  it('names a join node with its kind label', () => {
    bench({
      now: Date.parse('2026-11-04T10:57:25.000Z'),
      runs: [run({
        snapshot: {
          ...flowDocument(),
          nodes: [
            { kind: 'start', id: 'start' },
            { kind: 'agent', id: 'design', templateId: TEMPLATE, instruction: 'design' },
            { kind: 'join', id: 'merge', mode: 'all' },
            { kind: 'end', id: 'end' },
          ],
          edges: [
            { kind: 'execution', from: 'start', to: 'design' },
            { kind: 'execution', from: 'design', to: 'merge' },
            { kind: 'execution', from: 'merge', to: 'end' },
          ],
        },
        nodeRuns: [
          { nodeId: 'start', iteration: 0, status: 'succeeded' },
          { nodeId: 'design', iteration: 0, status: 'succeeded', startedAt: START, endedAt: DESIGN_END },
          { nodeId: 'merge', iteration: 0, status: 'running', startedAt: IMPLEMENT_START },
        ],
      })],
    })
    expect(screen.getByText('汇聚')).not.toBeNull()
  })

  it('sends one cancel request however often the entry is pressed', () => {
    const { face } = bench({ now: Date.parse('2026-11-04T10:57:25.000Z') })
    const cancel = screen.getByRole('button', { name: '取消' })
    fireEvent.click(cancel)
    fireEvent.click(cancel)
    expect(face.cancelRun).toHaveBeenCalledTimes(1)
  })
})
