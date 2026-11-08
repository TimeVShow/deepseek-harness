// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { CommandClaim } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AgentTemplateId, FlowDocument, FlowRun } from '@deepseek-ai/dsh-experimental-agent-flow/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { apply as nodeApply } from '../src/index.ts'
import { apply, inject, resolvePanelConfig } from '../src/client/index.ts'
import { AgentFlowPage } from '../src/client/AgentFlowPage.tsx'
import { AgentFlowPanelIcon } from '../src/client/AgentFlowPanelIcon.tsx'
import { FlowRunProgress } from '../src/client/FlowRunProgress.tsx'
import { FlowSelect } from '../src/client/FlowSelect.tsx'
import { en, zh } from '../src/client/locales.ts'
import {
  FLOW_CLAIM_PREFIX, messageOf, mountAgentFlowPanel, PANEL_ID, problemsOf,
  type AgentFlowInjected, type FlowSelectInjected,
} from '../src/client/mount.ts'

const SESSION = 'session-1' as SessionId
const TEMPLATE = 'template-1' as AgentTemplateId

const flowDocument: FlowDocument = {
  id: 'flow-1' as FlowDocument['id'],
  name: 'demo',
  maxIterations: 16,
  nodes: [],
  edges: [],
  createdAt: 'a',
  updatedAt: 'a',
}

const runRecord: FlowRun = {
  id: 'run-1' as FlowRun['id'],
  flowId: flowDocument.id,
  snapshot: flowDocument,
  parentSessionId: SESSION,
  status: 'running',
  input: 'fix the bug',
  nodeRuns: [],
  startedAt: 'a',
}

/** The root Session a conversational node materializes. */
const CONVERSATION = 'flow-session' as SessionId

/** One running run whose conversational entry node already opened its session. */
const conversationalRun: FlowRun = {
  id: 'run-2' as FlowRun['id'],
  flowId: flowDocument.id,
  snapshot: {
    ...flowDocument,
    nodes: [
      { kind: 'start', id: 'start' },
      { kind: 'agent', id: 'clarify', templateId: TEMPLATE, instruction: 'ask', interactive: true },
      { kind: 'end', id: 'end' },
    ],
    edges: [{ kind: 'execution', from: 'start', to: 'clarify' }, { kind: 'execution', from: 'clarify', to: 'end' }],
  },
  parentSessionId: SESSION,
  status: 'running',
  input: 'write a sorter',
  nodeRuns: [
    { nodeId: 'start', iteration: 0, status: 'succeeded' },
    { nodeId: 'clarify', iteration: 0, status: 'conversing', agentSessionId: CONVERSATION },
    { nodeId: 'end', iteration: 0, status: 'pending' },
  ],
  startedAt: 'a',
}

/** The same run after settlement: its conversational node is concluded. */
const concludedRun: FlowRun = {
  ...conversationalRun,
  status: 'completed',
  nodeRuns: [
    { nodeId: 'start', iteration: 0, status: 'succeeded' },
    { nodeId: 'clarify', iteration: 0, status: 'succeeded', agentSessionId: CONVERSATION },
    { nodeId: 'end', iteration: 0, status: 'succeeded' },
  ],
}

/** A concluded conversational node whose execution successor still runs. */
const concludedWithLiveSuccessor: FlowRun = {
  ...concludedRun,
  status: 'running',
  snapshot: {
    ...flowDocument,
    nodes: [
      { kind: 'start', id: 'start' },
      { kind: 'agent', id: 'clarify', templateId: TEMPLATE, instruction: 'ask', interactive: true },
      { kind: 'agent', id: 'implement', templateId: TEMPLATE, instruction: 'build' },
      { kind: 'end', id: 'end' },
    ],
    edges: [
      { kind: 'execution', from: 'start', to: 'clarify' },
      { kind: 'execution', from: 'clarify', to: 'implement' },
      { kind: 'execution', from: 'implement', to: 'end' },
    ],
  },
  nodeRuns: [
    { nodeId: 'start', iteration: 0, status: 'succeeded' },
    { nodeId: 'clarify', iteration: 0, status: 'succeeded', agentSessionId: CONVERSATION },
    { nodeId: 'implement', iteration: 0, status: 'running' },
    { nodeId: 'end', iteration: 0, status: 'pending' },
  ],
}

/** Boot the browser half over fakes: the Remote mount point, one session, and the slot tree. */
async function bench(options: {
  mountFails?: boolean
  localeFails?: boolean
  startFails?: boolean
  conversational?: boolean
  concluded?: boolean
  liveSuccessor?: boolean
  /** Override the runs one read reports. */
  runs?: FlowRun[]
} = {}) {
  const ctx = new Context()
  const mounted: TypertRemoteContribution[] = []
  const unmounted: number[] = []
  const calls: string[] = []
  const ok = <T>(value: T) => Promise.resolve({ ok: true as const, value })
  const saved = { id: 'flow-1', name: 'saved', maxIterations: 16, nodes: [], edges: [], createdAt: 'a', updatedAt: 'a' }
  const template = { id: 'template-1', name: 'saved', createdAt: 'a', updatedAt: 'a' }
  const startError = { ok: false as const, error: { code: 'agent-flow/refused', message: 'refused' } }
  const agentFlows = {
    listFlows: () => { calls.push('listFlows'); return ok([]) },
    listTemplates: () => { calls.push('listTemplates'); return ok([template]) },
    listRuns: () => {
      calls.push('listRuns')
      if (options.runs !== undefined) return ok([...options.runs])
      if (options.concluded === true) return ok([concludedRun])
      if (options.liveSuccessor === true) return ok([concludedWithLiveSuccessor])
      return ok(options.conversational === true ? [conversationalRun] : [])
    },
    saveFlow: () => { calls.push('saveFlow'); return ok(saved) },
    deleteFlow: () => { calls.push('deleteFlow'); return ok(undefined) },
    saveTemplate: () => { calls.push('saveTemplate'); return ok(template) },
    deleteTemplate: () => { calls.push('deleteTemplate'); return ok(undefined) },
    cancel: () => { calls.push('cancel'); return ok(undefined) },
    concludeConversation: (sessionId: SessionId, id: string) => {
      calls.push(`concludeConversation:${String(sessionId)}:${id}`)
      return ok(undefined)
    },
    start: (sessionId: SessionId, request: { flowId: FlowDocument['id']; input: string }) => {
      calls.push(`start:${String(sessionId)}:${request.input}`)
      if (options.startFails === true) return Promise.resolve(startError)
      return ok(options.conversational === true ? conversationalRun : runRecord)
    },
  }
  const session = {
    list: () => { calls.push('sessionList'); return ok({ items: [] }) },
    modelCatalog: () => {
      calls.push('modelCatalog')
      return ok({
        default: { provider: 'deepseek', model: 'chat' },
        routableProviders: ['deepseek'],
        groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'chat', name: 'Chat' }] }],
        failures: [],
      })
    },
  }
  ctx.provide('remote', {
    $mount: async (contribution: TypertRemoteContribution) => {
      if (options.mountFails === true) throw new Error('mount refused')
      mounted.push(contribution)
      return async () => { unmounted.push(mounted.length) }
    },
    agentFlows,
    session,
  } as never)
  /* Mounting the real contribution publishes these namespaces as services; the
     bench provides them directly so the UI half can activate. */
  ctx.provide('remote.agentFlows', agentFlows)
  ctx.provide('remote.session', session)
  const uiWorkspace = { openSession: vi.fn() }
  ctx.provide('uiWorkspace', uiWorkspace as never)
  const blocks = { set: vi.fn(), storeFor: vi.fn(), forget: vi.fn() }
  ctx.provide('conversation', { blocks } as never)
  const openResource = vi.fn()
  /* The seat the real service publishes while a conversation is on screen;
     the bench starts with none mounted, exactly like the panel on screen. */
  const mountedListeners = new Set<() => void>()
  let mountedSession: SessionId | undefined
  const mountSidebar = (id: SessionId | undefined) => {
    mountedSession = id
    for (const listener of [...mountedListeners]) listener()
  }
  ctx.provide('sidebarRight', {
    openResource,
    mounted: {
      getSnapshot: () => mountedSession,
      subscribe: (listener: () => void) => {
        mountedListeners.add(listener)
        return () => { mountedListeners.delete(listener) }
      },
    },
  } as never)
  /* The session scope the selector's claim dispatches route through, plus the
     retain face the activity tracker uses to follow a node Session. */
  const scopeFiber = ctx.plugin(() => {})
  ctx.provide('sessions', {
    scope: (id: SessionId) => id === SESSION ? scopeFiber.ctx : undefined,
    retain: vi.fn((target: SessionId) => ({
      binding: {
        eventSource: { getSnapshot: () => ({ entries: [] }), subscribe: () => () => {} },
        session: {
          getSnapshot: () => ({ sessionId: target, running: false, pendingSubmissions: [], openState: 'open' }),
          subscribe: () => () => {},
        },
      },
      release: vi.fn(),
    })),
  } as never)
  ctx.provide('uiSession', {
    sessionStatus: { getSnapshot: () => new Map(), subscribe: () => () => {} },
  } as never)
  const layout = { selectPanel: vi.fn() }
  ctx.provide('layout', layout as never)
  if (options.localeFails === true) {
    ctx.provide('locale', {
      register: () => { throw new Error('locale refused') },
      bind: () => () => 'x',
    } as never)
  } else {
    ctx.provide('locale', new LocaleRuntime(ctx))
  }
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      main: { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
      'conversation.input.left': { kind: 'list', scope: 'session' },
      'conversation.input.dock': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
  return { ctx, mounted, unmounted, calls, scopeCtx: scopeFiber.ctx, layout, uiWorkspace, blocks, openResource, mountSidebar }
}

/** Read one member of a slot inject face (records erase member types). */
function member<K extends keyof FlowSelectInjected>(face: Record<string, unknown>, key: K): FlowSelectInjected[K] {
  return face[key] as FlowSelectInjected[K]
}

describe('Agent Flow browser plugin', () => {
  it('has an inert host half', () => {
    nodeApply()
    expect(typeof nodeApply).toBe('function')
  })

  it('defaults the stall notice to ten minutes and refuses unusable values', () => {
    expect(resolvePanelConfig()).toEqual({ stallNoticeMs: 600_000 })
    expect(resolvePanelConfig({})).toEqual({ stallNoticeMs: 600_000 })
    expect(resolvePanelConfig({ stallNoticeMs: 30_000 })).toEqual({ stallNoticeMs: 30_000 })
    expect(() => resolvePanelConfig({ stallNoticeMs: 4_999 })).toThrow()
    expect(() => resolvePanelConfig({ stallNoticeMs: 600.5 })).toThrow()
    expect(() => resolvePanelConfig({ stallNoticeMs: 86_400_001 })).toThrow()
  })

  it('mounts its own Remote contribution and the panel surfaces', async () => {
    const { ctx, mounted, calls, layout, uiWorkspace, openResource, mountSidebar } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    expect(mounted).toHaveLength(1)
    const panel = ctx.slots.entries('main').find(entry => entry.options.key === PANEL_ID)
    expect(panel?.component).toBe(AgentFlowPage)
    const entry = ctx.slots.entries('sidebar.panellist').find(candidate => candidate.options.id === PANEL_ID)
    expect(entry?.component).toBe(AgentFlowPanelIcon)
    expect(entry?.options.order).toBe(30)
    const label = entry?.options.label
    expect(typeof label === 'function' ? label() : label).toBe('Agent Flow')

    /* The injected face reads through the mounted namespace. */
    const injected = panel?.inject?.()
    const call = (key: string, ...args: never[]): Promise<unknown> => {
      const fn = injected?.[key] as ((...args: never[]) => unknown) | undefined
      if (fn === undefined) throw new Error(`the Agent Flow face lacks ${key}`)
      return Promise.resolve(fn(...args))
    }
    /* The flow-progress dock joins the composer stack. */
    const dock = ctx.slots.entries('conversation.input.dock').find(candidate => candidate.options.id === PANEL_ID)
    expect(dock?.component).toBe(FlowRunProgress)
    const dockFace = dock?.inject?.(SESSION as never) as {
      stallNoticeMs?: number
      openRun?: (id: FlowRun['id']) => void
      openSession?: (id: SessionId) => void
      cancelRun?: (session: SessionId, id: FlowRun['id']) => Promise<void>
    } | undefined
    expect(dockFace?.stallNoticeMs).toBe(600_000)
    dockFace?.openRun?.('run-1' as FlowRun['id'])
    expect(layout.selectPanel).toHaveBeenCalledWith(PANEL_ID)
    dockFace?.openSession?.(SESSION)
    expect(uiWorkspace.openSession).toHaveBeenCalledWith(SESSION)
    await dockFace?.cancelRun?.(SESSION, 'run-1' as FlowRun['id'])
    expect(calls).toContain('cancel')
    /* Mounting already read the roster once, so a concluded conversation's
       composer block applies without the panel ever opening. */
    await call('load')
    expect(calls.slice(-5)).toEqual(['listFlows', 'listTemplates', 'listRuns', 'sessionList', 'modelCatalog'])
    await call('setView', 'runs' as never)
    await call('selectFlow', undefined as never)
    await call('updateDraft', (() => {}) as never)
    await call('openSession', 'session-1' as never)
    await call('createFlow', 'template-1' as never)
    await call('saveFlow', { name: 'n', nodes: [], edges: [] } as never)
    await call('deleteFlow', 'flow-1' as never)
    await call('saveTemplate', { name: 't' } as never)
    await call('deleteTemplate', 'template-1' as never)
    await call('selectRun', 'run-1' as never)
    /* A file opens as its session resource; a reveal line a Markdown
       destination carried travels as the file resource's navigation
       parameter instead of joining the address. While the panel is on
       screen the conversation's seat is gone, so the open first switches to
       the run's conversation and lands once that seat has bound. */
    await call('openFile', 'session-1' as never, 'out.md' as never)
    expect(openResource).not.toHaveBeenCalled()
    expect(uiWorkspace.openSession).toHaveBeenCalledWith(SESSION)
    /* Another session mounting changes nothing for the pending open. */
    mountSidebar('session-9' as SessionId)
    expect(openResource).not.toHaveBeenCalled()
    mountSidebar(SESSION)
    expect(openResource).toHaveBeenCalledTimes(1)
    expect(openResource.mock.calls[0]?.[1]).toBeUndefined()
    expect(String(openResource.mock.calls[0]?.[0])).toContain('out.md')
    /* With the conversation on screen the open is immediate. */
    await call('openFile', 'session-1' as never, 'src/main.py' as never, { line: 24 } as never)
    expect(openResource).toHaveBeenCalledTimes(2)
    expect(openResource.mock.calls[1]).toEqual([
      expect.stringContaining('src/main.py'),
      { params: { line: 24 } },
    ])
    await call('cancelRun', 'session-1' as never, 'run-1' as never)
    await call('concludeConversation', 'session-1' as never, 'run-1' as never)
    expect(calls).toContain('concludeConversation:session-1:run-1')
    await ctx.fiber.dispose()
  })

  it('folds a repeated waiting open and lands every distinct one on mount', async () => {
    const { ctx, uiWorkspace, openResource, mountSidebar } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const panel = ctx.slots.entries('main').find(entry => entry.options.key === PANEL_ID)
    const injected = panel?.inject?.() as AgentFlowInjected | undefined
    if (injected === undefined) throw new Error('the Agent Flow face is missing')
    injected.openFile(SESSION, 'out.md')
    /* Repeating the identical request adds no pending entry and no second
       switch; a different file still asks for the conversation itself. */
    injected.openFile(SESSION, 'out.md')
    injected.openFile(SESSION, 'src/main.py', { line: 4 })
    expect(uiWorkspace.openSession.mock.calls).toEqual([[SESSION], [SESSION]])
    expect(openResource).not.toHaveBeenCalled()
    mountSidebar(SESSION)
    expect(openResource).toHaveBeenCalledTimes(2)
    expect(String(openResource.mock.calls[0]?.[0])).toContain('out.md')
    expect(openResource.mock.calls[0]?.[1]).toBeUndefined()
    expect(openResource.mock.calls[1]).toEqual([expect.stringContaining('src/main.py'), { params: { line: 4 } }])
    await ctx.fiber.dispose()
  })

  it('drops waiting opens on unload instead of firing them into an inactive context', async () => {
    const { ctx, openResource, mountSidebar } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    try {
      const panel = ctx.slots.entries('main').find(entry => entry.options.key === PANEL_ID)
      const injected = panel?.inject?.() as AgentFlowInjected | undefined
      if (injected === undefined) throw new Error('the Agent Flow face is missing')
      injected.openFile(SESSION, 'out.md')
      await fiber.dispose()
      /* The conversation's seat mounting after the unload must not fire the
         dropped request. */
      mountSidebar(SESSION)
      expect(openResource).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('cancels the waiting open when the navigation switch is refused', async () => {
    const { ctx, uiWorkspace, openResource, mountSidebar } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    try {
      uiWorkspace.openSession.mockImplementation(() => { throw new Error('navigation refused') })
      const panel = ctx.slots.entries('main').find(entry => entry.options.key === PANEL_ID)
      const injected = panel?.inject?.() as AgentFlowInjected | undefined
      if (injected === undefined) throw new Error('the Agent Flow face is missing')
      expect(() => { injected.openFile(SESSION, 'out.md') }).toThrow('navigation refused')
      /* The cancelled request no longer fires when the conversation mounts. */
      mountSidebar(SESSION)
      expect(openResource).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('registers the composer workflow selector and routes claims through the session scope', async () => {
    const { ctx, scopeCtx, layout, calls } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const entry = ctx.slots.entries('conversation.input.left').find(candidate => candidate.options.id === PANEL_ID)
    expect(entry?.component).toBe(FlowSelect)
    expect(entry?.options.order).toBe(30)
    const face = entry?.inject?.(SESSION as never)
    if (face === undefined) throw new Error('the selector inject face is missing')

    /* Claiming dispatches the scoped begin-command event; the hub's listener
       answers true when the editor applied the token. */
    const requests: { claim: CommandClaim; span: unknown }[] = []
    const off = scopeCtx.on('slash/input-begin-command', (request) => {
      requests.push(request)
      return true
    })
    const claimFlow = member(face, 'claimFlow')
    expect(claimFlow(flowDocument, { start: 0, end: 0, draftRev: 1 })).toBe(true)
    expect(requests).toHaveLength(1)
    const claim = requests[0]!.claim
    expect(claim.name).toBe(`${FLOW_CLAIM_PREFIX}${String(flowDocument.id)}`)
    expect(claim.token).toContain('demo')
    expect(claim.token.endsWith(' ')).toBe(true)
    /* A refused dispatch (no accepting listener) reports no claim. */
    off()
    expect(claimFlow(flowDocument, { start: 0, end: 0, draftRev: 1 })).toBe(false)

    /* The claim's submit starts the run through the Remote namespace, bound to
       the claiming session, and arms the in-flight indicator immediately. */
    const empty = await claim.submit('   ', scopeCtx, [])
    expect(empty.kind).toBe('error')
    if (empty.kind === 'error') {
      expect([zh['selector.emptyInput'], en['selector.emptyInput']]).toContain(empty.text)
    }
    const started = await claim.submit('  fix the bug  ', scopeCtx, [])
    expect(started.kind).toBe('success')
    expect(calls).toContain(`start:${String(SESSION)}:fix the bug`)
    const hooks = member(face, 'hooks')
    expect(hooks.agentFlow.getSnapshot().runs.map(run => run.id)).toEqual([runRecord.id])

    /* Clearing dispatches the consume-token event with the span guard. */
    const guards: unknown[] = []
    scopeCtx.on('slash/input-consume-token', (request) => {
      guards.push(request.guard)
      return true
    })
    const clearFlow = member(face, 'clearFlow')
    const span = { start: 0, end: claim.token.length, draftRev: 1 }
    expect(clearFlow(span)).toBe(true)
    expect(guards).toEqual([{ kind: 'span', span }])

    /* The in-flight entry opens the panel's Runs tab. */
    member(face, 'openRuns')()
    expect(hooks.agentFlow.getSnapshot().view).toBe('runs')
    expect(layout.selectPanel).toHaveBeenCalledExactlyOnceWith(PANEL_ID)
    await ctx.fiber.dispose()
  })

  it('blocks a concluded conversation at mount, without the panel ever opening', async () => {
    const { ctx, blocks } = await bench({ concluded: true })
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    /* The graph's only execution successor is the structural end node, so the
       block reads the run's recorded outcome instead of successor names. */
    await vi.waitFor(() => {
      expect(blocks.set).toHaveBeenCalledExactlyOnceWith(CONVERSATION, { reason: en['composer.locked.completed'] })
    })
    await ctx.fiber.dispose()
  })

  it('names a live successor in a concluded conversation block at mount', async () => {
    const { ctx, blocks } = await bench({ liveSuccessor: true })
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await vi.waitFor(() => {
      expect(blocks.set).toHaveBeenCalledExactlyOnceWith(
        CONVERSATION, { reason: en['composer.locked.continuing'].replace('{names}', 'saved') },
      )
    })
    await ctx.fiber.dispose()
  })

  it('states a settled outcome without a live successor, and stays neutral while the run continues', async () => {
    const cases = [
      ['failed', en['composer.locked.failed']],
      ['cancelled', en['composer.locked.cancelled']],
      ['running', en['composer.locked']],
    ] as const
    for (const [status, reason] of cases) {
      const { ctx, blocks } = await bench({ runs: [{ ...concludedRun, status }] })
      const fiber = ctx.plugin({ inject: [...inject], apply })
      await fiber.await()
      await vi.waitFor(() => {
        expect(blocks.set).toHaveBeenCalledExactlyOnceWith(CONVERSATION, { reason })
      })
      await ctx.fiber.dispose()
    }
  })

  it('follows a started run into its conversational node', async () => {
    const { ctx, scopeCtx, uiWorkspace } = await bench({ conversational: true })
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const panel = ctx.slots.entries('main').find(entry => entry.options.key === PANEL_ID)
    const injected = panel?.inject?.() as AgentFlowInjected | undefined
    const selector = ctx.slots.entries('conversation.input.left').find(candidate => candidate.options.id === PANEL_ID)
      ?.inject?.(SESSION as never)
    if (selector === undefined) throw new Error('the selector inject face is missing')
    const claims: CommandClaim[] = []
    scopeCtx.on('slash/input-begin-command', (request) => {
      claims.push(request.claim)
      return true
    })
    member(selector, 'claimFlow')(flowDocument, { start: 0, end: 0, draftRev: 1 })
    expect((await claims[0]!.submit('write a sorter', scopeCtx, [])).kind).toBe('success')

    /* The first read after the start finds the node's session and moves the
       user into it; a later read does not move them again. */
    const load = injected?.['load'] as (() => Promise<unknown>) | undefined
    if (load === undefined) throw new Error('the Agent Flow face lacks load')
    await load()
    expect(uiWorkspace.openSession).toHaveBeenCalledExactlyOnceWith(CONVERSATION)
    await load()
    expect(uiWorkspace.openSession).toHaveBeenCalledExactlyOnceWith(CONVERSATION)
    await ctx.fiber.dispose()
  })

  it('reports a refused run start as an error outcome', async () => {
    const { ctx, scopeCtx } = await bench({ startFails: true })
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = ctx.slots.entries('conversation.input.left').find(candidate => candidate.options.id === PANEL_ID)
    const face = entry?.inject?.(SESSION as never)
    if (face === undefined) throw new Error('the selector inject face is missing')
    const claims: CommandClaim[] = []
    scopeCtx.on('slash/input-begin-command', (request) => {
      claims.push(request.claim)
      return true
    })
    member(face, 'claimFlow')(flowDocument, { start: 0, end: 0, draftRev: 1 })
    const outcome = await claims[0]!.submit('fix the bug', scopeCtx, [])
    expect(outcome.kind).toBe('error')
    if (outcome.kind === 'error') expect(outcome.text).toContain('refused')
    await ctx.fiber.dispose()
  })

  it('refuses to claim when the session scope is gone', async () => {
    const { ctx } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = ctx.slots.entries('conversation.input.left').find(candidate => candidate.options.id === PANEL_ID)
    const face = entry?.inject?.('session-gone' as never)
    if (face === undefined) throw new Error('the selector inject face is missing')
    expect(member(face, 'claimFlow')(flowDocument, { start: 0, end: 0, draftRev: 1 })).toBe(false)
    expect(member(face, 'clearFlow')({ start: 0, end: 1, draftRev: 1 })).toBe(false)
    await ctx.fiber.dispose()
  })

  it('withdraws the Remote namespace and all surfaces on unload', async () => {
    const { ctx, unmounted } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.slots.entries('main')).toHaveLength(1)
    await fiber.dispose()
    expect(ctx.slots.entries('main')).toHaveLength(0)
    expect(ctx.slots.entries('sidebar.panellist')).toHaveLength(0)
    expect(ctx.slots.entries('conversation.input.left')).toHaveLength(0)
    expect(unmounted).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('reads validation problems out of a rejected Remote call', () => {
    expect(problemsOf({ details: { problems: [{ code: 'cycle', message: 'a cycle' }] } })).toEqual(['a cycle'])
    expect(problemsOf(new Error('plain'))).toEqual([])
    expect(problemsOf('plain')).toEqual([])
    expect(messageOf('plain')).toBe('plain')
    expect(messageOf(new Error('boom'))).toBe('boom')
  })

  it('rolls back the Remote namespace when the UI registration fails', async () => {
    const { ctx, unmounted } = await bench({ localeFails: true })
    await expect(mountAgentFlowPanel(ctx, {} as TypertRemoteContribution, { stallNoticeMs: 600_000 })).rejects.toThrow('locale refused')
    expect(unmounted).toHaveLength(1)
    expect(ctx.slots.entries('main')).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('reports a refused Remote mount instead of half-registering the UI', async () => {
    const { ctx } = await bench({ mountFails: true })
    await expect(mountAgentFlowPanel(ctx, {} as TypertRemoteContribution, { stallNoticeMs: 600_000 })).rejects.toThrow('mount refused')
    expect(ctx.slots.entries('main')).toHaveLength(0)
    await ctx.fiber.dispose()
  })
})
