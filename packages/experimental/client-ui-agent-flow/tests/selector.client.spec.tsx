// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionInputShell } from '../../../client/ui-conversation/src/client/input/facade.ts'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { FlowDocument, FlowId, FlowRun, FlowRunId } from '@deepseek-ai/dsh-experimental-agent-flow/types'
import type { InputActions, InputState, TokenSpan } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { FlowSelect, type FlowSelectProps } from '../src/client/FlowSelect.tsx'
import type { AgentFlowSnapshot } from '../src/client/controller.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const SESSION = 'session-1' as SessionId
const FLOW_A = 'flow-a' as FlowId
const FLOW_B = 'flow-b' as FlowId
const RUN = 'run-1' as FlowRunId
const INSERTION: TokenSpan = { start: 4, end: 4, draftRev: 1 }

function flow(id: FlowId, name: string): FlowDocument {
  return {
    id,
    name,
    maxIterations: 16,
    nodes: [{ kind: 'start', id: 'start' }, { kind: 'end', id: 'end' }],
    edges: [{ kind: 'execution', from: 'start', to: 'end' }],
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
  }
}

function run(overrides: Partial<FlowRun> = {}): FlowRun {
  return {
    id: RUN,
    flowId: FLOW_A,
    snapshot: flow(FLOW_A, 'Alpha'),
    parentSessionId: SESSION,
    status: 'running',
    input: 'write about bugs',
    nodeRuns: [],
    startedAt: '2026-10-10T00:00:00.000Z',
    ...overrides,
  }
}

function unusedHook(): never {
  throw new Error('The workflow selector reads only the input machine and its own face')
}

function inputState(overrides: Partial<InputState> = {}): InputState {
  return {
    draft: '',
    attachmentIds: [],
    draftRev: 1,
    phase: 'plain',
    occurrences: [],
    queue: [],
    ...overrides,
  }
}

/** Render the selector over controllable input-machine and roster stores. */
function bench(options: {
  claim?: InputState['claim']
  phase?: InputState['phase']
  flows?: FlowDocument[]
  runs?: FlowRun[]
  /** Drive the selector over the real input facade instead of a stub store. */
  shell?: SessionInputShell
} = {}) {
  const input = createSnapshotStore<InputState>(inputState({
    ...(options.claim === undefined ? {} : { claim: options.claim }),
    ...(options.phase === undefined ? {} : { phase: options.phase }),
  }))
  const roster = createSnapshotStore<AgentFlowSnapshot>({
    status: 'ready',
    flows: options.flows ?? [flow(FLOW_A, 'Alpha'), flow(FLOW_B, 'Beta')],
    templates: [],
    runs: options.runs ?? [],
    sessions: [],
    modelGroups: [],
    view: 'flows',
    nodeActivity: {},
  })
  const face = {
    refresh: vi.fn(async () => {}),
    claimFlow: vi.fn((flow: FlowDocument, span: TokenSpan) => options.shell === undefined
      ? true
      : options.shell.beginCommand({
        name: `agent-flow/${String(flow.id)}`,
        token: `工作流:${flow.name} `,
        hint: 'hint',
        submit: async () => ({ kind: 'success' }),
      }, span)),
    clearFlow: vi.fn((_span: TokenSpan) => true),
    openRuns: vi.fn(),
  }
  const inputActions: InputActions = options.shell?.actions ?? {
    captureInsertion: () => INSERTION,
    insertText: () => false,
    setDraft: () => {},
    addAttachments: () => false,
    removeAttachment: () => {},
    pruneAttachments: () => {},
    submit: () => {},
  }
  const props: FlowSelectProps = {
    ...face,
    sessionId: SESSION,
    useInput: bindSnapshotSelector(options.shell?.state ?? input),
    inputActions,
    useAgentFlow: bindSnapshotSelector(roster),
    /* The selector reads no other standard source; these seats must stay unused. */
    useSession: unusedHook,
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
  render(<FlowSelect {...props} />)
  return { input, roster, face }
}

/** The active claim of this selector, as the input machine would publish it. */
function ownClaim(token = '工作流:Beta '): NonNullable<InputState['claim']> {
  return { name: `agent-flow/${String(FLOW_B)}`, token, hint: 'hint' }
}

function trigger(): HTMLButtonElement {
  /* The trigger is the selector's only button; its accessible name tracks the
     selection (default label, flow name, or claim token). */
  return screen.getByRole('button') as HTMLButtonElement
}

function open(): void {
  fireEvent.click(trigger())
}

describe('FlowSelect', () => {
  it('claims the composer input for the picked flow, then replaces the claim token on switch', () => {
    const { input, face } = bench()
    expect(trigger().textContent).toBe('工作流')
    expect(face.refresh).not.toHaveBeenCalled()

    open()
    expect(face.refresh).toHaveBeenCalledExactlyOnceWith()
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['不选工作流', 'Alpha', 'Beta'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Beta' }))
    expect(face.claimFlow).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: FLOW_B }), { start: 0, end: 0, draftRev: 1 },
    )
    expect(screen.queryByRole('menuitem')).toBeNull()

    act(() => { input.set(inputState({ claim: ownClaim() })) })
    expect(trigger().textContent).toBe('Beta')
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Alpha' }))
    expect(face.claimFlow).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: FLOW_A }),
      { start: 0, end: '工作流:Beta '.length, draftRev: 1 },
    )
  })

  it('lifts only its own claim through the no-workflow row', () => {
    const { input, face } = bench()
    act(() => { input.set(inputState({ claim: ownClaim() })) })
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: '不选工作流' }))
    expect(face.clearFlow).toHaveBeenCalledExactlyOnceWith(
      { start: 0, end: '工作流:Beta '.length, draftRev: 1 },
    )

    act(() => { input.set(inputState({ claim: { name: 'run', token: '/run ' } })) })
    expect(trigger().textContent).toBe('工作流')
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: '不选工作流' }))
    expect(face.clearFlow).toHaveBeenCalledExactlyOnceWith(
      { start: 0, end: '工作流:Beta '.length, draftRev: 1 },
    )

    act(() => { input.set(inputState()) })
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: '不选工作流' }))
    expect(face.clearFlow).toHaveBeenCalledExactlyOnceWith(
      { start: 0, end: '工作流:Beta '.length, draftRev: 1 },
    )
  })

  it('shows the creation hint instead of rows when the roster is empty', () => {
    bench({ flows: [] })
    open()
    expect(screen.queryByRole('menuitem')).toBeNull()
    expect(screen.getByText('还没有流程。在 Agent Flow 面板中创建。')).toBeTruthy()
  })

  it('names a flow the roster no longer lists through its claim token', () => {
    const { input } = bench({ flows: [flow(FLOW_A, 'Alpha')] })
    act(() => { input.set(inputState({ claim: ownClaim('工作流:Beta (已删除) ') })) })
    expect(trigger().textContent).toBe('工作流:Beta (已删除)')
  })

  it('flags a run in flight on this session and opens the Runs tab from the menu', () => {
    const { face } = bench({ runs: [run()] })
    expect(trigger().getAttribute('aria-label')).toBe('工作流 · 当前会话有运行在进行')
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: '查看运行记录' }))
    expect(face.openRuns).toHaveBeenCalledExactlyOnceWith()
  })

  it('flags a run another session started when one of its nodes opened this session', () => {
    bench({
      runs: [{
        ...run(),
        parentSessionId: 'session-2' as SessionId,
        nodeRuns: [{ nodeId: 'implement', iteration: 0, status: 'running', agentSessionId: SESSION }],
      }],
    })
    expect(trigger().getAttribute('aria-label')).toBe('工作流 · 当前会话有运行在进行')
  })

  it('ignores runs owned by another session or already settled', () => {
    bench({ runs: [run({ parentSessionId: 'session-2' as SessionId }), run({ status: 'completed' })] })
    expect(trigger().getAttribute('aria-label')).toBe('工作流')
    open()
    expect(screen.queryByRole('menuitem', { name: '查看运行记录' })).toBeNull()
  })

  it('locks the trigger while the input machine adjudicates or submits', () => {
    const { input } = bench()
    expect(trigger().disabled).toBe(false)
    act(() => { input.set(inputState({ phase: 'adjudicating' })) })
    expect(trigger().disabled).toBe(true)
    act(() => { input.set(inputState({ phase: 'submitting', claim: ownClaim() })) })
    expect(trigger().disabled).toBe(true)
    act(() => { input.set(inputState({ claim: ownClaim() })) })
    expect(trigger().disabled).toBe(false)
  })

  it('keeps the menu open and reports a refused claim', () => {
    const { face } = bench()
    face.claimFlow.mockReturnValue(false)
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Beta' }))
    expect(screen.getByText('无法选中工作流，请重试')).toBeTruthy()
    expect(screen.getAllByRole('menuitem')).not.toHaveLength(0)
  })

  it('keeps typed text when a flow is picked after the draft', async () => {
    const ctx = new Context()
    const shell = new SessionInputShell({
      actx: ctx,
      defaultSink: async () => ({ kind: 'success' }),
      commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: () => '' },
    })
    try {
      shell.setDraft('please fix this bug')
      bench({ shell })
      open()
      fireEvent.click(screen.getByRole('menuitem', { name: 'Beta' }))
      const state = shell.state.getSnapshot()
      expect(state.phase).toBe('claimed')
      expect(state.draft).toBe('工作流:Beta please fix this bug')
    } finally {
      shell.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('closes the menu on a second trigger click or an outside pointer', () => {
    const { face } = bench()
    open()
    expect(face.refresh).toHaveBeenCalledTimes(1)
    open()
    expect(screen.queryByRole('menuitem')).toBeNull()
    expect(face.refresh).toHaveBeenCalledTimes(1)

    open()
    expect(screen.getAllByRole('menuitem')).not.toHaveLength(0)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menuitem')).toBeNull()
    open()
    expect(face.refresh).toHaveBeenCalledTimes(3)
  })
})
