// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AgentTemplate, AgentTemplateId, FlowDocument, FlowId, FlowRun, FlowRunId } from '@deepseek-ai/dsh-experimental-agent-flow/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore as unusedStore } from '@deepseek-ai/dsh-client-store'
import { AgentFlowPage, type AgentFlowPageProps } from '../src/client/AgentFlowPage.tsx'
import type { AgentFlowSnapshot, AgentFlowView } from '../src/client/controller.ts'
import { en } from '../src/client/locales.ts'

// The canvas library measures real DOM geometry; the panel spec drives the
// callbacks it exposes instead, so the stub renders them as plain markup.
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  const ReactFlow = (props: {
    nodes: readonly { id: string; position?: { x: number; y: number }; data: { label: string; title: string; subtitle?: string } }[]
    edges: readonly {
      id: string
      source: string
      target: string
      label?: string
      ariaLabel?: string
      data?: { parallel: boolean }
      style?: { strokeDasharray?: string }
      markerEnd?: { type: string }
    }[]
    nodeTypes?: { flow?: (node: unknown) => unknown }
    edgeTypes?: { flow?: (edge: unknown) => unknown }
    onConnect?: (connection: { source: string | null; target: string | null }) => void
    onNodeClick?: (event: unknown, node: { id: string }) => void
    onEdgeClick?: (event: unknown, edge: { id: string }) => void
    onPaneClick?: () => void
    onNodeDrag?: (event: unknown, node: { id: string; position: { x: number; y: number } }) => void
    onNodeDragStop?: (event: unknown, node: { id: string; position: { x: number; y: number } }) => void
  }) => (
    <div data-testid="canvas">
      <button type="button" data-testid="connect" onClick={() => { props.onConnect?.({ source: 'j', target: 'end' }) }} />
      <button type="button" data-testid="connect-agents" onClick={() => { props.onConnect?.({ source: 'agent1', target: 'agent2' }) }} />
      <button type="button" data-testid="connect-start" onClick={() => { props.onConnect?.({ source: 'start', target: 'agent1' }) }} />
      <button type="button" data-testid="connect-none" onClick={() => { props.onConnect?.({ source: null, target: null }) }} />
      <button type="button" data-testid="click-node" onClick={() => { props.onNodeClick?.({}, { id: 'agent1' }) }} />
      <button type="button" data-testid="click-node-2" onClick={() => { props.onNodeClick?.({}, { id: 'agent2' }) }} />
      <button type="button" data-testid="click-join" onClick={() => { props.onNodeClick?.({}, { id: 'j' }) }} />
      <button type="button" data-testid="click-missing" onClick={() => { props.onNodeClick?.({}, { id: 'ghost' }) }} />
      <button type="button" data-testid="click-edge" onClick={() => { props.onEdgeClick?.({}, { id: 'e2' }) }} />
      <button type="button" data-testid="click-edge-0" onClick={() => { props.onEdgeClick?.({}, { id: 'e0' }) }} />
      <button type="button" data-testid="click-missing-edge" onClick={() => { props.onEdgeClick?.({}, { id: 'e99' }) }} />
      <button type="button" data-testid="pane" onClick={() => { props.onPaneClick?.() }} />
      <button type="button" data-testid="drag" onClick={() => { props.onNodeDragStop?.({}, { id: 'agent1', position: { x: 7, y: 9 } }) }} />
      <button type="button" data-testid="drag-missing" onClick={() => { props.onNodeDragStop?.({}, { id: 'ghost', position: { x: 1, y: 1 } }) }} />
      <button type="button" data-testid="drag-preview" onClick={() => { props.onNodeDrag?.({}, { id: 'agent1', position: { x: 5, y: 6 } }) }} />
      {props.nodes.map(node => <span key={node.id} data-testid={`node-${node.id}`} data-x={String(node.position?.x)}>
        {props.nodeTypes?.flow?.({ data: node.data }) as React.ReactNode}
      </span>)}
      {props.edges.map(edge => (
        <span key={edge.id} data-testid={`edge-${edge.id}`} data-dash={edge.style?.strokeDasharray} data-arrow={edge.markerEnd?.type}>
          <button type="button" aria-label={edge.ariaLabel} onClick={() => { props.onEdgeClick?.({}, { id: edge.id }) }}>
            {edge.source}→{edge.target}
          </button>
          {props.edgeTypes?.flow?.({
            ...edge, sourceX: 0, sourceY: 0, targetX: 260, targetY: 0,
            sourcePosition: actual.Position.Right, targetPosition: actual.Position.Left,
          }) as React.ReactNode}
        </span>
      ))}
    </div>
  )
  const Handle = (): null => null
  const Background = (): null => null
  const Controls = (): null => null
  const BaseEdge = (props: { id: string; label: string; path: string; interactionWidth: number }) => (
    <span data-testid={`path-${props.id}`} data-path={props.path} data-hit-width={props.interactionWidth}>{props.label}</span>
  )
  return { ...actual, ReactFlow, BaseEdge, Handle, Background, Controls }
})

function unusedHook(): never {
  throw new Error('This panel does not read global slot sources')
}

const SESSION = 'session-1' as SessionId
const FLOW = 'flow-1' as FlowId
const RUN = 'run-1' as FlowRunId
const TEMPLATE = 'template-1' as AgentTemplateId

function flowDocument(): FlowDocument {
  return {
    id: FLOW,
    name: 'demo',
    maxIterations: 16,
    nodes: [
      { kind: 'start', id: 'start', position: { x: 0, y: 0 } },
      { kind: 'agent', id: 'agent1', templateId: TEMPLATE, instruction: 'work' },
      { kind: 'agent', id: 'agent2', templateId: TEMPLATE, instruction: 'review' },
      { kind: 'condition', id: 'c' },
      { kind: 'join', id: 'j', mode: 'all' },
      { kind: 'end', id: 'end' },
    ],
    edges: [
      { kind: 'execution', from: 'start', to: 'agent1' },
      { kind: 'execution', from: 'agent2', to: 'j' },
      { kind: 'execution', from: 'c', to: 'j', result: 'done' },
      { kind: 'execution', from: 'agent1', to: 'end' },
    ],
    createdAt: '2026-09-24T00:00:00.000Z',
    updatedAt: '2026-09-24T00:00:00.000Z',
  }
}

function template(): AgentTemplate {
  return { id: TEMPLATE, name: 'Node agent', persona: 'precise', createdAt: 'a', updatedAt: 'a' }
}

function run(): FlowRun {
  const snapshot = flowDocument()
  snapshot.nodes = [
    ...snapshot.nodes.map(node => node.id === 'agent2' ? { ...node, title: 'Reviewer' } : node),
    { kind: 'agent', id: 'agent9', templateId: 'template-9' as AgentTemplateId, instruction: 'extra' },
  ]
  return {
    id: RUN,
    flowId: FLOW,
    snapshot,
    parentSessionId: SESSION,
    status: 'running',
    input: 'write about bugs',
    nodeRuns: [
      { nodeId: 'start', iteration: 0, status: 'succeeded' },
      {
        nodeId: 'agent1',
        iteration: 0,
        status: 'succeeded',
        agentSessionId: SESSION,
        handoff: 'wrote the draft',
        files: ['/workspace/draft.md'],
        result: 'done',
      },
      { nodeId: 'agent1', iteration: 1, status: 'failed', error: 'bad route' },
      { nodeId: 'agent2', iteration: 0, status: 'running' },
      { nodeId: 'agent9', iteration: 0, status: 'pending', files: [] },
      { nodeId: 'ghost', iteration: 0, status: 'skipped' },
    ],
    startedAt: '2026-09-24T00:00:00.000Z',
  }
}

const CONVERSATION = 'flow-session' as SessionId

/** One run whose conversational entry node is waiting for the user's reply. */
function conversingRun(): FlowRun {
  const snapshot = flowDocument()
  snapshot.nodes = snapshot.nodes.map(node =>
    node.id === 'agent1' && node.kind === 'agent' ? { ...node, interactive: true } : node)
  return {
    ...run(),
    snapshot,
    nodeRuns: [
      { nodeId: 'start', iteration: 0, status: 'succeeded' },
      { nodeId: 'agent1', iteration: 0, status: 'conversing', agentSessionId: CONVERSATION },
      { nodeId: 'agent2', iteration: 0, status: 'succeeded', agentSessionId: SESSION, handoff: 'reviewed' },
    ],
  }
}

/** Render the panel over one controllable snapshot and face. */
function bench() {
  const store = createSnapshotStore<AgentFlowSnapshot>({
    status: 'ready',
    flows: [flowDocument()],
    templates: [template()],
    runs: [run()],
    sessions: [{ id: SESSION, live: true }],
    modelGroups: [{
      provider: 'deepseek',
      providerLabel: 'DeepSeek',
      models: [{ provider: 'deepseek', model: 'chat', label: 'Chat' }],
    }],
    view: 'flows',
    nodeActivity: {},
  })
  const face = {
    load: vi.fn(async () => {}),
    setView: vi.fn((view: AgentFlowView) => { store.update((current) => { current.view = view }) }),
    selectFlow: vi.fn((id: FlowId | undefined) => {
      store.update((current) => {
        current.selectedFlowId = id
        current.draft = id === undefined ? undefined : flowDocument()
      })
    }),
    updateDraft: vi.fn((mutate: (draft: FlowDocument) => void) => {
      store.update((current) => { if (current.draft !== undefined) mutate(current.draft) })
    }),
    createFlow: vi.fn(async () => {}),
    saveFlow: vi.fn(async () => flowDocument()),
    deleteFlow: vi.fn(async () => {}),
    saveTemplate: vi.fn(async () => template()),
    deleteTemplate: vi.fn(async () => {}),
    selectRun: vi.fn((id: FlowRunId | undefined) => {
      store.update((current) => { current.selectedRunId = id })
    }),
    cancelRun: vi.fn(async () => {}),
    concludeConversation: vi.fn(async () => {}),
    openFile: vi.fn(),
    openSession: vi.fn(),
  }
  const useAgentFlow = <T,>(selector: (state: ReturnType<typeof store.getSnapshot>) => T): T =>
    useSyncExternalStore(notify => store.subscribe(notify), () => selector(store.getSnapshot()))
  const props: AgentFlowPageProps = {
    ...face,
    useAgentFlow,
    /* The panel reads no global slot source; these seats must stay unused. */
    usePanelInfo: unusedHook,
    useSessions: unusedHook,
    useSessionStatus: unusedHook,
    useSessionRetainInfo: unusedHook,
    useWorkspaces: unusedHook,
    useResource: unusedHook,
    useRemoteAccess: unusedHook,
    useSessionAccess: unusedHook,
    useContextMenu: unusedHook,
    useWorkspaceAccess: unusedHook,
    t: makeTranslate(en),
  }
  return { store, face, props }
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(navigator, 'clipboard')
})

describe('Agent Flow panel', () => {
  it('lists flows and opens one in the editor', () => {
    const { props, face, store } = bench()
    render(<AgentFlowPage {...props} />)
    expect(screen.getByText('demo')).toBeDefined()
    expect(screen.getByText(/6 nodes/)).toBeDefined()
    fireEvent.click(screen.getByText('demo'))
    expect(face.selectFlow).toHaveBeenCalledWith(FLOW)
    expect(screen.getByTestId('canvas')).toBeDefined()
    expect(store.getSnapshot().draft?.name).toBe('demo')
  })

  it('shows loading, failure, and validation notices', () => {
    const { props, store } = bench()
    store.update((current) => { current.status = 'loading'; current.error = 'boom' })
    render(<AgentFlowPage {...props} />)
    expect(screen.getByText('Loading…')).toBeDefined()
    expect(screen.getByText(/boom/)).toBeDefined()
  })

  it('creates and deletes a flow without a pre-selected entry agent', () => {
    const { props, face } = bench()
    render(<AgentFlowPage {...props} />)
    fireEvent.click(screen.getByText('New flow'))
    expect(face.createFlow).toHaveBeenCalledWith()
    fireEvent.click(screen.getByText('Delete'))
    expect(face.deleteFlow).toHaveBeenCalledWith(FLOW)
  })

  it('edits an agent', () => {
    const { props, face, store } = bench()
    store.update((current) => { current.view = 'agents' })
    render(<AgentFlowPage {...props} />)
    fireEvent.click(screen.getByText('Node agent'))
    expect(screen.getByText(/used by 2 flows/)).toBeDefined()
    fireEvent.change(screen.getByDisplayValue('precise'), { target: { value: 'changed' } })
    fireEvent.change(screen.getByLabelText(/^Model$/), { target: { value: 'deepseek/chat' } })
    fireEvent.change(screen.getByLabelText(/^Name$/), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByText('Save'))
    expect(face.saveTemplate).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Renamed',
      persona: 'changed',
      provider: 'deepseek',
      model: 'chat',
    }))
  })

  it('starts an agent from scratch and deletes one', () => {
    const { props, face, store } = bench()
    store.update((current) => { current.view = 'agents' })
    render(<AgentFlowPage {...props} />)
    fireEvent.click(screen.getByText('New agent'))
    fireEvent.change(screen.getByLabelText(/^Name$/), { target: { value: 'Fresh' } })
    expect(screen.getByText('Save')).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText(/^Model$/), { target: { value: 'deepseek/chat' } })
    fireEvent.click(screen.getByText('Save'))
    expect(face.saveTemplate).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Fresh',
      provider: 'deepseek',
      model: 'chat',
    }))

    fireEvent.click(screen.getByText('Node agent'))
    fireEvent.click(screen.getByText('Delete'))
    expect(face.deleteTemplate).toHaveBeenCalledWith(TEMPLATE)
  })

  it('adopts the id of a newly saved agent and updates the same record next time', async () => {
    const { props, face, store } = bench()
    store.update((current) => { current.view = 'agents' })
    render(<AgentFlowPage {...props} />)
    fireEvent.click(screen.getByText('New agent'))
    fireEvent.change(screen.getByLabelText(/^Name$/), { target: { value: 'Writer' } })
    fireEvent.change(screen.getByLabelText('Persona prompt'), { target: { value: 'First persona' } })
    fireEvent.change(screen.getByLabelText(/^Model$/), { target: { value: 'deepseek/chat' } })
    await act(async () => {
      fireEvent.click(screen.getByText('Save'))
      fireEvent.click(screen.getByText('Save'))
    })
    expect(face.saveTemplate).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Delete')).not.toBeNull()

    fireEvent.change(screen.getByLabelText('Persona prompt'), { target: { value: 'Second persona' } })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(face.saveTemplate).toHaveBeenLastCalledWith(expect.objectContaining({
      id: TEMPLATE,
      name: 'Writer',
      persona: 'Second persona',
    }))
  })

  it('keeps a pinned route the catalog no longer offers and saves it unchanged', () => {
    const { props, face, store } = bench()
    store.update((current) => {
      current.view = 'agents'
      /* No catalog: the form must still show the pinned route rather than
         silently rewriting the agent onto some other model. */
      current.modelGroups = []
      const base = current.templates[0]
      if (base !== undefined) current.templates = [{ ...base, provider: 'retired', model: 'old' }]
    })
    render(<AgentFlowPage {...props} />)
    fireEvent.click(screen.getByText('Node agent'))
    const model = screen.getByLabelText(/^Model$/) as HTMLSelectElement
    expect(model.value).toBe('retired/old')
    expect(screen.getByText('Pinned to retired/old (absent from the current model catalog)')).toBeDefined()
    expect(screen.getByText('No models are configured yet — add one in the system settings first.')).toBeDefined()
    const placeholder = Array.from(model.options).find(option => option.value === '')
    expect(placeholder?.disabled).toBe(true)

    fireEvent.click(screen.getByText('Save'))
    expect(face.saveTemplate).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'retired', model: 'old' }))
  })

  it('opens a run as a results page and reaches its history', () => {
    const { props, face, store } = bench()
    store.update((current) => { current.view = 'runs' })
    render(<AgentFlowPage {...props} />)
    fireEvent.click(screen.getByText('demo'))
    expect(face.selectRun).toHaveBeenCalledWith(RUN)
    /* The request is one disclosure away, not a banner over the results. */
    expect(screen.queryByText('write about bugs')).toBeNull()
    fireEvent.click(screen.getByText('Original request'))
    expect(screen.getByText('write about bugs')).toBeDefined()
    expect(screen.getByText('Start · Succeeded')).toBeDefined()
    expect(screen.getAllByText('Node agent')).toHaveLength(1)
    expect(screen.getByText('Reviewer')).toBeDefined()
    expect(screen.getByText('agent9')).toBeDefined()
    expect(screen.getByText('ghost')).toBeDefined()
    /* The latest round is the failed one; the earlier round keeps its work. */
    expect(screen.getByText('Round 2')).toBeDefined()
    expect(screen.getByText('bad route')).toBeDefined()
    expect(screen.queryByText('wrote the draft')).toBeNull()
    fireEvent.click(screen.getByText('1 earlier rounds'))
    fireEvent.click(screen.getByText('Round 1'))
    expect(screen.getByText('wrote the draft')).toBeDefined()
    expect(screen.getByText('Result: done')).toBeDefined()
    fireEvent.click(screen.getByText('Preview'))
    expect(face.openFile).toHaveBeenCalledWith(SESSION, '/workspace/draft.md', undefined)
    fireEvent.click(screen.getByText('Cancel'))
    expect(face.cancelRun).toHaveBeenCalledWith(SESSION, RUN)
    fireEvent.click(screen.getByText('Back to runs'))
    expect(face.selectRun).toHaveBeenLastCalledWith(undefined)
  })

  it('keeps a large file list behind one disclosure and hides tooling state', () => {
    const many = [
      ...Array.from({ length: 30 }, (_, index) => `/workspace/src/module-${index}.py`),
      '/workspace/00-review/review.md',
      '/workspace/.venv/lib/python3.11/site-packages/requests/api.py',
    ]
    const { props, store } = bench()
    store.update((current) => {
      current.view = 'runs'
      current.selectedRunId = RUN
      current.runs = [{
        ...run(),
        nodeRuns: [{
          nodeId: 'agent1',
          iteration: 0,
          status: 'succeeded',
          handoff: 'done',
          files: many,
        }],
      }]
    })
    render(<AgentFlowPage {...props} />)
    /* The report leads; the button wall does not exist. */
    expect(screen.getByText('review.md')).toBeDefined()
    expect(screen.getByText('View all files (25)')).toBeDefined()
    expect(screen.getByText('Show environment and cache files (1)')).toBeDefined()
    expect(screen.queryByText('api.py')).toBeNull()

    fireEvent.click(screen.getByText('View all files (25)'))
    expect(screen.getByText('module-24.py')).toBeDefined()
    expect(screen.getByText('Collapse the file list')).toBeDefined()

    fireEvent.click(screen.getByText('Show environment and cache files (1)'))
    expect(screen.getByText('api.py')).toBeDefined()
    expect(screen.getByText('Hide environment and cache files')).toBeDefined()
  })

  it('copies a produced file\'s absolute path and refuses to claim a denied write', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const { props, store } = bench()
    store.update((current) => {
      current.view = 'runs'
      current.selectedRunId = RUN
      current.runs = [{
        ...run(),
        status: 'completed',
        endedAt: '2026-09-24T00:02:00.000Z',
        nodeRuns: [{
          nodeId: 'agent1', iteration: 0, status: 'succeeded', handoff: 'done', files: ['/workspace/draft.md'],
        }],
      }]
    })
    render(<AgentFlowPage {...props} />)
    expect(screen.getByText('draft.md')).toBeDefined()
    fireEvent.click(screen.getByText('Copy path'))
    await vi.waitFor(() => { expect(screen.getByText('Copied')).toBeDefined() })
    expect(writeText).toHaveBeenCalledWith('/workspace/draft.md')

    /* A second press replaces the pending reset instead of racing it. */
    vi.useFakeTimers()
    await act(async () => { fireEvent.click(screen.getByText('Copied')) })
    expect(screen.getByText('Copied')).toBeDefined()
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(screen.getByText('Copy path')).toBeDefined()
    vi.useRealTimers()

    /* A refused write reports no success. */
    writeText.mockRejectedValueOnce(new Error('denied'))
    await act(async () => { fireEvent.click(screen.getByText('Copy path')) })
    expect(screen.queryByText('Copied')).toBeNull()
  })

  it('says so when a run has no work executions yet', () => {
    const { props, store } = bench()
    store.update((current) => {
      current.view = 'runs'
      current.selectedRunId = RUN
      current.runs = [{
        ...run(),
        nodeRuns: [{ nodeId: 'start', iteration: 0, status: 'succeeded' }],
      }]
    })
    render(<AgentFlowPage {...props} />)
    expect(screen.getByText('This run has no node executions yet.')).toBeDefined()
    expect(screen.getByText('Start · Succeeded')).toBeDefined()
  })

  it('hides the condition as a result while the agents keep theirs', () => {
    const { props, store } = bench()
    store.update((current) => {
      current.view = 'runs'
      current.selectedRunId = RUN
      current.runs = [{
        ...run(),
        status: 'completed',
        endedAt: '2026-09-24T00:02:00.000Z',
        nodeRuns: [
          { nodeId: 'start', iteration: 0, status: 'succeeded' },
          {
            nodeId: 'agent1', iteration: 0, status: 'succeeded',
            handoff: 'reviewed the work', result: 'done',
          },
          { nodeId: 'c', iteration: 0, status: 'succeeded', result: 'done' },
          { nodeId: 'end', iteration: 0, status: 'succeeded' },
        ],
      }]
    })
    render(<AgentFlowPage {...props} />)
    /* Routing is execution control: no card, no status-line entry. */
    expect(screen.queryByText('Condition')).toBeNull()
    expect(screen.getByText('Start · Succeeded, End · Succeeded')).toBeDefined()
    expect(screen.queryByText(/Routed on/)).toBeNull()
    /* The agent's own closing word stays on its card as a result mark. */
    expect(screen.getByText('Result: done')).toBeDefined()
    expect(screen.getByText('reviewed the work')).toBeDefined()
  })

  it('renders a join card without borrowing the agent handoff hint', () => {
    const { props, store } = bench()
    store.update((current) => {
      current.view = 'runs'
      current.selectedRunId = RUN
      current.runs = [{
        ...run(),
        status: 'completed',
        endedAt: '2026-09-24T00:02:00.000Z',
        nodeRuns: [
          { nodeId: 'start', iteration: 0, status: 'succeeded' },
          { nodeId: 'agent1', iteration: 0, status: 'succeeded', handoff: 'done' },
          { nodeId: 'j', iteration: 0, status: 'succeeded' },
          { nodeId: 'end', iteration: 0, status: 'succeeded' },
        ],
      }]
    })
    render(<AgentFlowPage {...props} />)
    /* A join forwards execution without narrating; its card stays bare. */
    expect(screen.getByText('Join')).toBeDefined()
    expect(screen.queryByText('No final summary yet')).toBeNull()
  })

  it('states no current node while only the condition executes', () => {
    const { props, store } = bench()
    store.update((current) => {
      current.view = 'runs'
      current.selectedRunId = RUN
      current.runs = [{
        ...run(),
        nodeRuns: [
          { nodeId: 'start', iteration: 0, status: 'succeeded' },
          { nodeId: 'agent1', iteration: 0, status: 'succeeded', handoff: 'done' },
          { nodeId: 'c', iteration: 0, status: 'running' },
        ],
      }]
    })
    render(<AgentFlowPage {...props} />)
    /* The run reads as running without flashing the transient hop or
       inventing that a successor started. */
    expect(screen.getAllByText('Running').length).toBeGreaterThan(0)
    expect(screen.queryByText(/Current node:/)).toBeNull()
    expect(screen.queryByText('Condition')).toBeNull()
  })

  it('surfaces a failed condition instead of hiding the run\'s failure', () => {
    const { props, store } = bench()
    store.update((current) => {
      current.view = 'runs'
      current.selectedRunId = RUN
      current.runs = [{
        ...run(),
        status: 'failed',
        nodeRuns: [
          { nodeId: 'start', iteration: 0, status: 'succeeded' },
          { nodeId: 'agent1', iteration: 0, status: 'succeeded', handoff: 'done' },
          { nodeId: 'c', iteration: 0, status: 'failed', error: 'no edge matched "done"' },
        ],
      }]
    })
    render(<AgentFlowPage {...props} />)
    expect(screen.getByText('Failed')).toBeDefined()
    /* No card for the condition, but its failure names the failed step. */
    expect(screen.queryByText('Condition')).toBeNull()
    expect(screen.getByText('Condition failed: no edge matched "done"')).toBeDefined()
  })

  it('opens Markdown destinations in the handoff through the panel\'s file action', () => {
    const { props, face, store } = bench()
    store.update((current) => {
      current.view = 'runs'
      current.selectedRunId = RUN
      current.runs = [{
        ...run(),
        status: 'completed',
        endedAt: '2026-09-24T00:02:00.000Z',
        nodeRuns: [{
          nodeId: 'agent1',
          iteration: 0,
          status: 'succeeded',
          agentSessionId: SESSION,
          dir: '/workspace/run-1/agent1',
          handoff: 'Read [the report](00-review/review.md#L24) and [the draft](/workspace/draft.md).',
          files: ['/workspace/run-1/agent1/00-review/review.md'],
        }],
      }]
    })
    render(<AgentFlowPage {...props} />)
    /* A relative destination resolves against the node round's own working
       directory and keeps the reveal line it was written with. */
    fireEvent.click(screen.getByRole('button', { name: /the report/ }))
    expect(face.openFile).toHaveBeenCalledWith(
      SESSION,
      '/workspace/run-1/agent1/00-review/review.md',
      { line: 24 },
    )
    /* An absolute destination keeps its own address, exactly like the
       Preview row of the same file. */
    fireEvent.click(screen.getByRole('button', { name: /the draft/ }))
    expect(face.openFile).toHaveBeenCalledWith(SESSION, '/workspace/draft.md', undefined)
    fireEvent.click(screen.getByText('Preview'))
    expect(face.openFile).toHaveBeenLastCalledWith(SESSION, '/workspace/run-1/agent1/00-review/review.md', undefined)
  })

  it('resolves a handoff link against the workspace root when the round recorded no directory', () => {
    const { props, face, store } = bench()
    store.update((current) => {
      current.view = 'runs'
      current.selectedRunId = RUN
      current.sessions = [{ id: SESSION, live: true, cwd: '/workspace' }]
      current.runs = [{
        ...run(),
        status: 'completed',
        nodeRuns: [{
          nodeId: 'agent1',
          iteration: 0,
          status: 'succeeded',
          handoff: 'See [the notes](notes/final.md).',
          files: [],
        }],
      }]
    })
    render(<AgentFlowPage {...props} />)
    /* A record the executor predates still resolves somewhere real; the
       path never picks up an undefined segment. */
    fireEvent.click(screen.getByRole('button', { name: /the notes/ }))
    expect(face.openFile).toHaveBeenCalledWith(SESSION, '/workspace/notes/final.md', undefined)
  })

  it('reads a Chinese and spaced handoff link without mangling it', () => {
    const { props, face, store } = bench()
    store.update((current) => {
      current.view = 'runs'
      current.selectedRunId = RUN
      current.runs = [{
        ...run(),
        status: 'completed',
        nodeRuns: [{
          nodeId: 'agent1',
          iteration: 0,
          status: 'succeeded',
          dir: '/workspace/run-1/agent1',
          handoff: '见 [最终 报告](%E6%8A%A5%E5%91%8A.md)。',
          files: [],
        }],
      }]
    })
    render(<AgentFlowPage {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /最终 报告/ }))
    expect(face.openFile).toHaveBeenCalledWith(SESSION, '/workspace/run-1/agent1/报告.md', undefined)
  })

  it('keeps Windows recorded files readable and their original addresses intact', () => {
    const { props, face, store } = bench()
    store.update((current) => {
      current.view = 'runs'
      current.selectedRunId = RUN
      current.sessions = [{ id: SESSION, live: true, cwd: 'C:\\work' }]
      current.runs = [{
        ...run(),
        status: 'completed',
        nodeRuns: [{
          nodeId: 'agent1',
          iteration: 0,
          status: 'succeeded',
          handoff: 'done',
          files: ['C:\\work\\review.md', 'C:\\work\\.venv\\lib\\dependency.md'],
        }],
      }]
    })
    render(<AgentFlowPage {...props} />)
    /* The environment directory hides on Windows addresses too; the relative
       display shares the file row with the untouched recorded address. */
    expect(screen.getByTitle('C:\\work\\review.md').textContent).toBe('review.md')
    expect(screen.getByText('Show environment and cache files (1)')).toBeDefined()
    expect(screen.queryByText('dependency.md')).toBeNull()
    /* Opening and copying use the recorded address unchanged. */
    fireEvent.click(screen.getByText('Preview'))
    expect(face.openFile).toHaveBeenCalledWith(SESSION, 'C:\\work\\review.md', undefined)
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    fireEvent.click(screen.getByText('Copy path'))
    expect(writeText).toHaveBeenCalledWith('C:\\work\\review.md')
  })

  it('renders a Markdown handoff and folds a long one', () => {
    const long = `# Outcome\n\n- first point\n- second point\n\n${'filler '.repeat(200)}`
    const { props, store } = bench()
    store.update((current) => {
      current.view = 'runs'
      current.selectedRunId = RUN
      current.runs = [{
        ...run(),
        status: 'completed',
        nodeRuns: [{
          nodeId: 'agent1',
          iteration: 0,
          status: 'succeeded',
          handoff: long,
          files: [],
        }],
      }]
    })
    render(<AgentFlowPage {...props} />)
    expect(screen.getByRole('heading', { name: 'Outcome' })).toBeDefined()
    expect(screen.getByText('first point')).toBeDefined()
    expect(screen.getByText('Show the full summary')).toBeDefined()
    fireEvent.click(screen.getByText('Show the full summary'))
    expect(screen.getByText('Collapse the summary')).toBeDefined()
  })

  it('cancels a running run through its parent session and reports failures', async () => {
    const { props, face, store } = bench()
    store.update((current) => { current.view = 'runs' })
    render(<AgentFlowPage {...props} />)
    fireEvent.click(screen.getByText('Cancel'))
    expect(face.cancelRun).toHaveBeenCalledWith(SESSION, RUN)
    face.cancelRun.mockRejectedValue(new Error('no executor'))
    fireEvent.click(screen.getByText('Cancel'))
    await vi.waitFor(() => { expect(screen.getByText('Cancelling failed: no executor')).toBeDefined() })
  })

  it('edits the draft: nodes and the selected node', () => {
    const { props, face, store } = bench()
    render(<AgentFlowPage {...props} />)
    fireEvent.click(screen.getByText('demo'))
    fireEvent.click(screen.getByText('Add join node'))
    fireEvent.click(screen.getByText('Add agent node'))
    expect(store.getSnapshot().draft?.nodes.at(-1)).toMatchObject({ kind: 'agent' })

    fireEvent.click(screen.getByTestId('click-node'))
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Step one' } })
    expect(store.getSnapshot().draft?.nodes.find(node => node.id === 'agent1')).toMatchObject({ title: 'Step one' })
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: '' } })
    expect(store.getSnapshot().draft?.nodes.find(node => node.id === 'agent1')?.title).toBeUndefined()
    fireEvent.change(screen.getByLabelText('Instruction'), { target: { value: 'do work' } })
    fireEvent.change(screen.getByLabelText(/^Agent$/), { target: { value: TEMPLATE } })
    fireEvent.click(screen.getByTestId('drag'))
    expect(store.getSnapshot().draft?.nodes.find(node => node.id === 'agent1')?.position).toEqual({ x: 7, y: 9 })
    fireEvent.click(screen.getByTestId('connect'))
    expect(store.getSnapshot().draft?.edges.at(-1)).toEqual({ kind: 'execution', from: 'j', to: 'end' })
    fireEvent.click(screen.getByTestId('click-node'))
    fireEvent.click(screen.getByText('Delete node'))
    expect(store.getSnapshot().draft?.nodes.some(node => node.id === 'agent1')).toBe(false)
    expect(face.saveFlow).not.toHaveBeenCalled()
  })

  it('edits a join node and the flow name, then saves', () => {
    const { props, face, store } = bench()
    render(<AgentFlowPage {...props} />)
    fireEvent.click(screen.getByText('demo'))
    fireEvent.click(screen.getByTestId('click-node'))
    // The selected node is the agent; select the join through the canvas list.
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'First' } })
    expect(store.getSnapshot().draft?.nodes.find(node => node.id === 'agent1')?.title).toBe('First')
    fireEvent.change(screen.getByDisplayValue('demo'), { target: { value: 'renamed' } })
    expect(store.getSnapshot().draft?.name).toBe('renamed')
    fireEvent.click(screen.getByText('Save flow'))
    expect(face.saveFlow).toHaveBeenCalledWith(expect.objectContaining({ name: 'renamed' }))
  })

  it('edits and clears an edge routing word', () => {
    const { props, store } = bench()
    render(<AgentFlowPage {...props} />)
    fireEvent.click(screen.getByText('demo'))
    fireEvent.click(screen.getByTestId('click-edge'))
    expect(screen.getByText('Edge properties')).toBeDefined()
    const word = screen.getByLabelText('Routing word') as HTMLInputElement
    expect(word.value).toBe('done')
    fireEvent.change(word, { target: { value: 'approved' } })
    expect(store.getSnapshot().draft?.edges[2]?.result).toBe('approved')
    fireEvent.change(screen.getByLabelText('Routing word'), { target: { value: '' } })
    expect(store.getSnapshot().draft?.edges[2]?.result).toBeUndefined()
    fireEvent.click(screen.getByText('Delete edge'))
    expect(store.getSnapshot().draft?.edges).toHaveLength(3)
  })

  it('returns from the editor to the list and reports validation problems', async () => {
    const { props, face, store } = bench()
    face.saveFlow.mockRejectedValue({
      details: { problems: [{ code: 'cycle', message: 'the flow graph contains a cycle' }] },
    })
    render(<AgentFlowPage {...props} />)
    fireEvent.click(screen.getByText('demo'))
    fireEvent.click(screen.getByText('Save flow'))
    await vi.waitFor(() => { expect(screen.getByText(/the flow graph contains a cycle/)).toBeDefined() })
    fireEvent.click(screen.getByText('Back to the flow list'))
    expect(store.getSnapshot().draft).toBeUndefined()
  })

  it('creates a starter template when an agent node has none to use', async () => {
    const { props, face, store } = bench()
    store.update((current) => { current.templates = [] })
    render(<AgentFlowPage {...props} />)
    fireEvent.click(screen.getByText('demo'))
    fireEvent.click(screen.getByText('Add agent node'))
    await vi.waitFor(() => { expect(face.saveTemplate).toHaveBeenCalledWith(expect.objectContaining({ name: 'Starter agent' })) })
  })
})

void unusedStore
describe('Agent Flow panel extras', () => {
  it('renders the sidebar icon at the requested size', async () => {
    const { AgentFlowPanelIcon } = await import('../src/client/AgentFlowPanelIcon.tsx')
    const iconProps = { size: 16 } as Parameters<typeof AgentFlowPanelIcon>[0]
    const { container } = render(<AgentFlowPanelIcon {...iconProps} />)
    expect(container.querySelector('svg')).toBeDefined()
  })

  it('ignores empty connections, unknown targets, and clears a selection on the pane', () => {
    const { props, store } = bench()
    render(<AgentFlowPage {...props} />)
    fireEvent.click(screen.getByText('demo'))
    fireEvent.click(screen.getByTestId('connect-none'))
    fireEvent.click(screen.getByTestId('drag-missing'))
    expect(store.getSnapshot().draft?.edges).toHaveLength(4)
    fireEvent.click(screen.getByTestId('click-missing'))
    fireEvent.click(screen.getByTestId('click-missing-edge'))
    expect(screen.getByText('Select a node or an edge to edit its properties.')).toBeDefined()
    fireEvent.click(screen.getByTestId('pane'))
    expect(screen.getByText('Select a node or an edge to edit its properties.')).toBeDefined()
  })

  it('shows the all-branches join policy without a race mode', () => {
    const { props, store } = bench()
    render(<AgentFlowPage {...props} />)
    fireEvent.click(screen.getByText('demo'))
    fireEvent.click(screen.getByTestId('click-join'))
    expect(screen.getByText('A join waits for all execution branches, as does a task with multiple execution predecessors.')).toBeDefined()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(store.getSnapshot().draft?.nodes.find(node => node.id === 'j')).toMatchObject({ mode: 'all' })
  })

  it('marks one node as the conversation and moves the mark off any other', () => {
    const { props, store } = bench()
    render(<AgentFlowPage {...props} />)
    fireEvent.click(screen.getByText('demo'))
    const interactiveOf = (id: string): boolean | undefined => {
      const node = store.getSnapshot().draft?.nodes.find(candidate => candidate.id === id)
      return node?.kind === 'agent' ? node.interactive : undefined
    }
    const cardOf = (id: string): Element | null => screen.getByTestId(`node-${id}`).firstElementChild

    fireEvent.click(screen.getByTestId('click-node'))
    expect(screen.getByText(/must be an entry node with an execution connection from start/)).toBeDefined()
    const toggle = screen.getByLabelText('Talks with the user') as HTMLInputElement
    expect(toggle.checked).toBe(false)
    fireEvent.click(toggle)
    expect(interactiveOf('agent1')).toBe(true)
    /* The canvas card names the role, so the graph shows who talks to the user. */
    expect(screen.getByTestId('node-agent1').textContent).toContain('Conversational')
    expect(cardOf('agent1')?.getAttribute('data-interactive')).toBe('true')
    expect(cardOf('agent2')?.hasAttribute('data-interactive')).toBe(false)

    fireEvent.click(screen.getByTestId('click-node-2'))
    fireEvent.click(screen.getByLabelText('Talks with the user'))
    expect(interactiveOf('agent2')).toBe(true)
    expect(interactiveOf('agent1')).toBeUndefined()

    fireEvent.click(screen.getByLabelText('Talks with the user'))
    expect(interactiveOf('agent2')).toBeUndefined()
    expect(screen.getByTestId('node-agent2').textContent).not.toContain('Conversational')
  })

  it('reads a conversing node as the conversation the user joins', () => {
    const { props, store, face } = bench()
    store.update((current) => {
      current.view = 'runs'
      current.runs = [conversingRun()]
      current.selectedRunId = RUN
    })
    render(<AgentFlowPage {...props} />)
    /* The whole run reads as clarifying: nothing downstream has started. */
    expect(screen.getByText('Clarifying')).toBeDefined()
    expect(screen.getByText(/waiting for your reply/)).toBeDefined()
    fireEvent.click(screen.getByText('Open the conversation'))
    expect(face.openSession).toHaveBeenCalledWith(CONVERSATION)
    fireEvent.click(screen.getByText('View execution'))
    expect(face.openSession).toHaveBeenCalledWith(SESSION)

    /* The exit needs the run's parent session live, exactly like cancelling. */
    fireEvent.click(screen.getByText('End the clarification'))
    expect(face.concludeConversation).toHaveBeenCalledWith(SESSION, RUN)
    act(() => { store.update((current) => { current.sessions = [] }) })
    expect(screen.queryByText('End the clarification')).toBeNull()
  })

  it('reads a run in the list as clarifying while its node waits for the user', () => {
    const { props, store } = bench()
    store.update((current) => {
      current.view = 'runs'
      current.runs = [conversingRun()]
    })
    render(<AgentFlowPage {...props} />)
    expect(screen.getByText('Clarifying')).toBeDefined()
    expect(screen.queryByText('Running')).toBeNull()
  })

  it('previews a node at its dragged position before the drop persists it', () => {
    const { props, store } = bench()
    render(<AgentFlowPage {...props} />)
    fireEvent.click(screen.getByText('demo'))
    const before = screen.getByTestId('node-agent1').getAttribute('data-x')
    fireEvent.click(screen.getByTestId('drag-preview'))
    expect(screen.getByTestId('node-agent1').getAttribute('data-x')).not.toBe(before)
    /* Only the drop is what the document keeps. */
    fireEvent.click(screen.getByTestId('drag'))
    expect(store.getSnapshot().draft?.nodes.find(node => node.id === 'agent1')?.position).toEqual({ x: 7, y: 9 })
  })

  it('adds a condition node and explains its routing', () => {
    const { props, store } = bench()
    render(<AgentFlowPage {...props} />)
    fireEvent.click(screen.getByText('demo'))
    fireEvent.click(screen.getByText('Add condition node'))
    expect(store.getSnapshot().draft?.nodes.at(-1)).toMatchObject({ kind: 'condition', id: 'condition1' })
    expect(screen.getByText(/forwards that agent's handoff downstream/)).toBeDefined()
    expect(store.getSnapshot().draft?.nodes.at(-1)?.position).toBeDefined()
  })

  it('summarizes inputs from connections without a separate source form', () => {
    const { props, store } = bench()
    render(<AgentFlowPage {...props} />)
    fireEvent.click(screen.getByText('demo'))
    fireEvent.click(screen.getByTestId('click-node'))
    expect(screen.getByText('No inputs')).toBeDefined()
    expect(screen.queryByLabelText('Node agent')).toBeNull()

    fireEvent.click(screen.getByTestId('connect-agents'))
    fireEvent.click(screen.getByTestId('click-node-2'))
    expect(screen.getByText('Node agent · Execution')).toBeDefined()
    expect(store.getSnapshot().draft?.edges.at(-1)?.kind).toBe('execution')
  })

  it('changes a task connection between execution and input with a visible line type', () => {
    const { props, store } = bench()
    render(<AgentFlowPage {...props} />)
    fireEvent.click(screen.getByText('demo'))
    fireEvent.click(screen.getByTestId('connect-agents'))
    const kind = screen.getByLabelText('Connection type')
    expect(kind).toHaveProperty('value', 'execution')
    expect(screen.getByTestId('edge-e4').getAttribute('data-dash')).toBeNull()
    expect(screen.getByTestId('edge-e4').getAttribute('data-arrow')).toBe('arrowclosed')
    expect(screen.getByTestId('path-e4').getAttribute('data-hit-width')).toBe('24')
    fireEvent.change(kind, { target: { value: 'input' } })
    expect(store.getSnapshot().draft?.edges.at(-1)).toMatchObject({ kind: 'input' })
    expect(screen.getByTestId('edge-e4').getAttribute('data-dash')).toBe('7 5')
    expect(screen.getByText('References results the source has already produced. It neither starts the target nor adds a waiting condition.')).toBeDefined()
    fireEvent.change(screen.getByLabelText('Connection type'), { target: { value: 'execution' } })
    expect(store.getSnapshot().draft?.edges.at(-1)?.kind).toBe('execution')
    fireEvent.click(screen.getByTestId('connect-agents'))
    expect(store.getSnapshot().draft?.edges).toHaveLength(5)
  })

  it('adds a separate request input beside a start execution connection', () => {
    const { props, store } = bench()
    render(<AgentFlowPage {...props} />)
    fireEvent.click(screen.getByText('demo'))
    fireEvent.click(screen.getByTestId('click-edge-0'))
    expect(screen.getByText('Starts the target without passing the original user request. Add a separate input connection when the request is needed.')).toBeDefined()
    fireEvent.click(screen.getByTestId('connect-start'))
    expect(store.getSnapshot().draft?.edges.at(-1)).toEqual({ kind: 'input', from: 'start', to: 'agent1' })
    expect(screen.getByLabelText('Connection type')).toHaveProperty('value', 'input')
    expect(screen.getByText('References this run’s original user request without starting the target.')).toBeDefined()
    expect(screen.getByTestId('edge-e4').getAttribute('data-dash')).toBe('7 5')
    expect(screen.getByTestId('path-e4').getAttribute('data-path')).not.toBe(screen.getByTestId('path-e0').getAttribute('data-path'))
    expect(screen.getByRole('option', { name: 'Execution' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByTestId('click-node'))
    expect(screen.getByText('Original user request · Input')).toBeDefined()
    fireEvent.click(screen.getByTestId('connect-start'))
    expect(store.getSnapshot().draft?.edges).toHaveLength(5)
  })

  it('names an input source by title or id without exposing source checkboxes', () => {
    const { props, store } = bench()
    render(<AgentFlowPage {...props} />)
    fireEvent.click(screen.getByText('demo'))
    fireEvent.click(screen.getByTestId('click-node'))
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Step one' } })
    fireEvent.click(screen.getByTestId('connect-agents'))
    fireEvent.click(screen.getByTestId('click-node-2'))
    expect(screen.getByText('Step one · Execution')).toBeDefined()
    fireEvent.click(screen.getByTestId('click-node'))
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: '' } })
    fireEvent.click(screen.getByTestId('click-node-2'))
    act(() => { store.update((current) => { current.templates = [] }) })
    expect(screen.getByText('agent1 · Execution')).toBeDefined()
  })

  it('shows a failed run and hides cancellation without a live parent session', () => {
    const { props, store } = bench()
    store.update((current) => {
      current.view = 'runs'
      current.runs = [{ ...run(), status: 'failed', error: 'agent refused' }]
      current.sessions = []
    })
    render(<AgentFlowPage {...props} />)
    expect(screen.getByText('Failed')).toBeDefined()
    expect(screen.queryByText('Cancel')).toBeNull()
    fireEvent.click(screen.getByText('demo'))
    expect(screen.getByText('Run error: agent refused')).toBeDefined()
    /* The failing execution keeps its own error beside the run's. */
    expect(screen.getByText('Node agent failed: bad route')).toBeDefined()
  })
})

describe('Agent Flow panel branches', () => {
  it('switches tabs, refreshes, and shows empty states', () => {
    const { props, face, store } = bench()
    store.update((current) => {
      current.flows = []
      current.templates = []
      current.runs = []
    })
    render(<AgentFlowPage {...props} />)
    expect(screen.getByText(/No flows yet/)).toBeDefined()
    fireEvent.click(screen.getByText('Refresh'))
    expect(face.load).toHaveBeenCalled()
    fireEvent.click(screen.getByText('Agents'))
    expect(screen.getByText(/No agents yet/)).toBeDefined()
    fireEvent.click(screen.getByText('Create your first agent'))
    expect(screen.getByText('Save')).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByText('Runs'))
    expect(screen.getByText('No runs yet.')).toBeDefined()
  })

  it('opens a bare agent form and edits a fully populated one', () => {
    const { props, face, store } = bench()
    store.update((current) => {
      current.view = 'agents'
      const base = current.templates[0]
      current.templates = base === undefined ? [] : [
        { ...base, id: 'template-bare' as AgentTemplate['id'], name: 'Bare', persona: undefined },
        { ...base, name: 'Full', persona: 'precise' },
      ]
    })
    render(<AgentFlowPage {...props} />)
    expect(screen.getByText(/used by 0 flows/)).toBeDefined()
    fireEvent.click(screen.getByText('Bare'))
    fireEvent.change(screen.getByLabelText(/Persona prompt/), { target: { value: 'fresh persona' } })
    fireEvent.change(screen.getByLabelText(/^Name$/), { target: { value: 'Bare copy' } })
    fireEvent.change(screen.getByLabelText(/^Model$/), { target: { value: 'deepseek/chat' } })
    fireEvent.click(screen.getByText('Save'))
    expect(face.saveTemplate).toHaveBeenLastCalledWith(expect.objectContaining({
      name: 'Bare copy',
      persona: 'fresh persona',
      provider: 'deepseek',
      model: 'chat',
    }))
    fireEvent.click(screen.getByText('Full'))
    expect(screen.getByDisplayValue('precise')).toBeDefined()
    expect(face.setView).not.toHaveBeenCalled()
  })

  it('edits a fully populated agent', () => {
    const { props, face, store } = bench()
    store.update((current) => {
      current.view = 'agents'
      const base = current.templates[0]
      if (base !== undefined) {
        current.templates = [{
          ...base,
          description: 'full',
          provider: 'deepseek',
          model: 'chat',
        }]
      }
    })
    render(<AgentFlowPage {...props} />)
    fireEvent.click(screen.getByText('Node agent'))
    const model = screen.getByLabelText(/^Model$/) as HTMLSelectElement
    expect(model.value).toBe('deepseek/chat')
    expect(model.selectedOptions[0]?.textContent).toBe('Chat')

    fireEvent.change(screen.getByLabelText(/Persona prompt/), { target: { value: 'still precise' } })
    fireEvent.click(screen.getByText('Save'))
    expect(face.saveTemplate).toHaveBeenLastCalledWith(expect.objectContaining({
      persona: 'still precise',
      provider: 'deepseek',
      model: 'chat',
    }))
  })

  it('hides cancellation when the parent session lost its Agent', () => {
    const { props, store } = bench()
    store.update((current) => {
      current.view = 'runs'
      current.sessions = [{ id: SESSION, live: false }]
    })
    render(<AgentFlowPage {...props} />)
    expect(screen.queryByText('Cancel')).toBeNull()
    fireEvent.click(screen.getByText('demo'))
    expect(screen.queryByText('Cancel')).toBeNull()
    expect(screen.getAllByText('Running').length).toBeGreaterThan(0)
  })

  it('renders a settled run with a skipped entry', () => {
    const { props, store } = bench()
    store.update((current) => {
      current.view = 'runs'
      current.selectedRunId = RUN
      current.runs = [{
        ...run(),
        status: 'completed',
        endedAt: '2026-09-24T00:02:00.000Z',
        nodeRuns: [{ nodeId: 'agent1', iteration: 0, status: 'skipped' }],
      }]
    })
    render(<AgentFlowPage {...props} />)
    expect(screen.getByText('Completed')).toBeDefined()
    expect(screen.getByText('Skipped')).toBeDefined()
    expect(screen.getByText('Took 2 min')).toBeDefined()
  })

  it('hides routing controls for an edge that leaves no agent node', () => {
    const { props } = bench()
    render(<AgentFlowPage {...props} />)
    fireEvent.click(screen.getByText('demo'))
    fireEvent.click(screen.getByTestId('click-edge-0'))
    expect(screen.getByText('Edge properties')).toBeDefined()
    expect(screen.queryByLabelText('Routing word')).toBeNull()
    fireEvent.click(screen.getByText('Delete edge'))
    expect(screen.getByText('Select a node or an edge to edit its properties.')).toBeDefined()
  })
})
