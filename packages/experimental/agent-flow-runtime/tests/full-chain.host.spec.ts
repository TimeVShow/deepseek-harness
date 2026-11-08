import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply as gatewayClientApply, inject as gatewayClientInject } from '@deepseek-ai/dsh-api-gateway/client'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import type { ConnectionHandle, ConnectionRpcResult, ConnectionStateSource } from '@deepseek-ai/dsh-client-connection/client'
import type { ConnectionRpcHandler, PeerId, PeerScope } from '@deepseek-ai/dsh-client-connection'
import { SessionInputShell } from '@deepseek-ai/dsh-client-ui-conversation/src/client/input/facade.ts'
import AgentFlowService from '@deepseek-ai/dsh-experimental-agent-flow'
import agentFlowRemote from '@deepseek-ai/dsh-experimental-agent-flow/remote'
import type {} from '@deepseek-ai/dsh-experimental-agent-flow/remote'
import type { FlowDocument, FlowRun } from '@deepseek-ai/dsh-experimental-agent-flow/types'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { AgentFlowController } from '../../client-ui-agent-flow/src/client/controller.ts'
import { beginFlowClaim, createFlowClaim } from '../../client-ui-agent-flow/src/client/flow-claim.ts'
import * as AgentFlowRuntime from '../src/index.ts'

const contexts: Context[] = []
const directories: string[] = []
const disposers: (() => void)[] = []

/** Stop every controller/shell this test created before releasing their contexts. */
function cleanup(): void {
  for (const dispose of disposers.splice(0).reverse()) dispose()
}

afterEach(async () => {
  vi.restoreAllMocks()
  cleanup()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** One decoded Host RPC call after the operator peer is attached. */
type HostCall = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<ConnectionRpcResult<unknown>>

/** The Host `/api` interceptor one Client bridge forwards into. */
class HostConnection extends Service {
  handler: HostCall | undefined
  readonly operator: PeerScope

  constructor(ctx: Context) {
    super(ctx, 'connection')
    this.operator = {
      id: 'bridge' as PeerId,
      ctx,
      principal: { kind: 'owner' },
      signal: new AbortController().signal,
      interactions: 'answer',
      dispose: async () => {},
    }
  }

  get rpc() {
    return {
      intercept: (_channel: string, _matches: (endpoint: string) => boolean, handler: ConnectionRpcHandler) =>
        this.ctx.effect(() => {
          this.handler = (endpoint, payload, signal) => handler(endpoint, payload, signal, this.operator)
          return () => { this.handler = undefined }
        }),
    }
  }
}

/**
 * Build the Client Connection handle that forwards `/api` calls into the Host
 * interceptor. This is the only transport substitution; the generated Remote,
 * both Gateways, the input machine, the Controller, and the Host execution
 * stack are production implementations.
 * @param host - Host connection carrying the Gateway interceptor.
 * @returns a loopback connection handle.
 */
function clientConnection(host: HostConnection): ConnectionHandle {
  const state: ConnectionStateSource = {
    getSnapshot: () => 'connected',
    subscribe: () => () => {},
  }
  return {
    interactions: 'none',
    isLoopback: true,
    openWebSocket: () => { throw new Error('the chain test opens no websocket') },
    generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
    state,
    rpc: {
      call: async (channel, endpoint, payload, signal) => {
        const handler = host.handler
        if (channel !== '/api' || handler === undefined) throw new Error('bridge has no /api handler')
        return await handler(endpoint, payload, signal ?? new AbortController().signal)
      },
      /* The chain uses unary methods only; declaring an in-process carrier
         keeps the Client Gateway off its WebSocket mux. */
      open: async function* (): AsyncGenerator<never> {
        throw new Error('the chain test opens no Remote streams')
      },
    },
    reconnect: () => {},
    registerGenerationSource: () => () => {},
    start: () => ({ stop: () => {} }),
  }
}

interface Chain {
  readonly host: Context
  readonly client: Context
  readonly parent: Agent
  readonly flow: FlowDocument
  readonly shell: SessionInputShell
  readonly remote: Context['remote']
  readonly controller: AgentFlowController
  readonly navigated: SessionId[]
  readonly locked: SessionId[]
  readonly modelPrompts: () => string[]
  /** Source kinds of the conversation Sessions' logged user messages, in order. */
  readonly sessionSources: () => string[]
  readonly makeController: (navigate: (id: SessionId) => void, lock: (id: SessionId) => void) => AgentFlowController
}

/**
 * Boot a real Host (Agent loop, service, graph runtime, in-process subagents)
 * and a real Client projection (generated Remote, both Gateways, input machine,
 * Controller).
 * @param options - flow shape and scripted model responses.
 * @returns the two contexts and the client surfaces.
 */
async function bootChain(options: {
  flow?: 'worker' | 'interactive'
  /** Whether the interactive flow wires the original request into the node. */
  input?: boolean
  responses?: ConstructorParameters<typeof MockAdapter>[0]
} = {}): Promise<Chain> {
  const host = new Context()
  contexts.push(host)
  await mountAgentLoopTestDependencies(host)
  await mountWorkingDirectoryFixture(host)
  if (host.get('sessionProjections') === undefined) await host.plugin(SessionProjectionRegistry)
  await host.plugin(AgentLoop, { agents: [] })
  await host.plugin(SubagentService)
  await host.plugin(SpawnInProcess, { providerName: 'in-process' })
  await host.plugin(Storage)
  const pool = new MemoryMediaPool()
  host.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(host, { backend: 'memory', routes: {} })
  host.storage.mount('domain', facility)
  host.provide('storageDomain', facility)
  const bridge = new HostConnection(host)
  await host.plugin(TypertRegistry)
  await host.plugin(RemoteAccessService)
  await host.plugin(TypertGatewayService)
  await host.plugin(AgentFlowService)
  host.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
  const adapter = new MockAdapter([...(options.responses ?? [])])
  host.llm.registerAdapter(['mock'], adapter)
  await host.plugin(AgentFlowRuntime, { provider: 'in-process' })

  const dir = await mkdtemp(join(tmpdir(), 'dsh-flow-chain-'))
  directories.push(dir)
  const parent = await host.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' }, { cwd: dir })
  const template = await host.agentFlows.saveTemplate({ name: 'Worker' })
  const nodes = options.flow === 'interactive'
    ? [
      { kind: 'start' as const, id: 'start' },
      { kind: 'agent' as const, id: 'talk', templateId: template.id, instruction: 'clarify', interactive: true },
      { kind: 'end' as const, id: 'end' },
    ]
    : [
      { kind: 'start' as const, id: 'start' },
      { kind: 'agent' as const, id: 'task1', templateId: template.id, instruction: 'work one' },
      { kind: 'agent' as const, id: 'task2', templateId: template.id, instruction: 'work two' },
      { kind: 'end' as const, id: 'end' },
    ]
  const edges = options.flow === 'interactive'
    ? [
      { kind: 'execution' as const, from: 'start', to: 'talk' },
      ...options.input === false ? [] : [{ kind: 'input' as const, from: 'start', to: 'talk' }],
      { kind: 'execution' as const, from: 'talk', to: 'end' },
    ]
    : [
      { kind: 'execution' as const, from: 'start', to: 'task1' },
      { kind: 'execution' as const, from: 'task1', to: 'task2' },
      { kind: 'execution' as const, from: 'task2', to: 'end' },
    ]
  const flow = await host.agentFlows.saveFlow({ name: 'chain', nodes, edges })
  const sessionSources: string[] = []
  host.on('session/event', (session, event) => {
    if (String(session.id).startsWith('flow-') && event.type === 'user/message') {
      sessionSources.push(event.data.source.kind)
    }
  })

  const client = new Context()
  contexts.push(client)
  await client.plugin(TypertRegistry)
  client.provide('connection', clientConnection(bridge))
  await client.plugin({ inject: gatewayClientInject, apply: gatewayClientApply })
  await client.remote.$mount(agentFlowRemote)

  const shell = new SessionInputShell({
    actx: client,
    defaultSink: async () => ({ kind: 'success' }),
    commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: () => '' },
  })
  disposers.push(() => { shell.dispose() })
  client.on('slash/input-begin-command', request => shell.beginCommand(request.claim, request.span) ? true : undefined)

  const sessionRemote = {
    list: async () => ({
      ok: true as const,
      value: {
        items: [{
          sessionId: parent.session.id,
          agentAvailable: true,
          updatedAt: 1,
          running: false,
          blank: false,
          occupied: false,
          cwd: dir,
        }],
      },
    }),
    modelCatalog: async () => ({
      ok: true as const,
      value: {
        default: { provider: 'mock', model: 'mock' },
        routableProviders: ['mock'],
        groups: [],
        failures: [],
      },
    }),
  }
  const makeController = (navigate: (id: SessionId) => void, lock: (id: SessionId) => void): AgentFlowController => {
    const created = new AgentFlowController({ agentFlows: client.remote.agentFlows, session: sessionRemote }, navigate, lock)
    disposers.push(() => { created.dispose() })
    return created
  }
  const navigated: SessionId[] = []
  const locked: SessionId[] = []
  const controller = makeController(
    (id) => { navigated.push(id) },
    (id) => { locked.push(id) },
  )
  await controller.load()

  return {
    host,
    client,
    parent,
    flow,
    shell,
    remote: client.remote,
    controller,
    navigated,
    locked,
    modelPrompts: () => adapter.requests.map(request => request.messages
      .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
      .join('\n')),
    sessionSources: () => [...sessionSources],
    makeController,
  }
}

/**
 * Claim one flow with a draft and submit it through the production claim and
 * the scoped begin-command waterfall.
 * @param chain - running composition.
 * @param draft - composer text before the claim.
 */
function claimAndSubmit(chain: Chain, draft: string): void {
  chain.shell.setDraft(draft)
  const claim = createFlowClaim(chain.parent.session.id, chain.flow, {
    token: flow => `flow:${flow.name}`,
    hint: 'hint',
    emptyInput: 'empty run input',
    startFailed: message => `start failed: ${message}`,
  }, {
    start: (id, request) => chain.remote.agentFlows.start(id, request),
    noteStarted: (run) => { chain.controller.noteStarted(run) },
  })
  const claimed = beginFlowClaim(chain.client, claim, {
    start: 0,
    end: 0,
    draftRev: chain.shell.state.getSnapshot().draftRev,
  })
  expect(claimed).toBe(true)
  chain.shell.submit()
}

async function waitRun(chain: Chain, status: FlowRun['status']): Promise<FlowRun> {
  return await vi.waitFor(async () => {
    const runs = await chain.host.agentFlows.listRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0]?.status).toBe(status)
    return runs[0] as FlowRun
  }, { timeout: 5000, interval: 10 })
}

describe('generated Remote chain', () => {
  it('starts once from the production claim and hands results to the next worker', async () => {
    const chain = await bootChain({ responses: [textResponse('first'), textResponse('second')] })
    claimAndSubmit(chain, 'write the changelog')
    await vi.waitFor(() => {
      expect(chain.controller.state.getSnapshot().runs.map(run => run.status)).toEqual(['running'])
    }, { timeout: 2000, interval: 10 })

    const run = await waitRun(chain, 'completed')
    expect(run.parentSessionId).toBe(chain.parent.session.id)
    expect(run.input).toBe('write the changelog')
    expect(run.nodeRuns.find(entry => entry.nodeId === 'task1')).toMatchObject({ status: 'succeeded', handoff: 'first' })
    expect(run.nodeRuns.find(entry => entry.nodeId === 'task2')).toMatchObject({
      status: 'succeeded',
      handoff: 'second',
      inputs: [{ nodeId: 'task1', iteration: 0 }],
    })

    const prompts = chain.modelPrompts()
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain('work one')
    expect(prompts[1]).toContain('work two')
    expect(prompts[1]).toContain('## Handoff from task1\nfirst')
    for (const prompt of prompts) expect(prompt).not.toContain('write the changelog')

    await chain.controller.load()
    expect(chain.controller.state.getSnapshot().runs[0]).toMatchObject({ status: 'completed' })
    expect(chain.navigated).toEqual([])
  })

  it('does not start a run for an empty claimed input', async () => {
    const chain = await bootChain()
    claimAndSubmit(chain, '')
    await vi.waitFor(() => {
      expect(chain.shell.state.getSnapshot().phase).toBe('claimed')
      expect(chain.shell.notices.getSnapshot()?.text).toBe('empty run input')
    }, { timeout: 2000, interval: 10 })
    expect(await chain.host.agentFlows.listRuns()).toEqual([])
    expect(chain.controller.state.getSnapshot().runs).toEqual([])
  })

  it('navigates to a conversing node, then locks it after completion and reload', async () => {
    const chain = await bootChain({
      flow: 'interactive',
      responses: [textResponse('please clarify'), textResponse('done\nResult: done')],
    })
    claimAndSubmit(chain, 'clarify the task')
    const conversing = await vi.waitFor(async () => {
      const runs = await chain.host.agentFlows.listRuns()
      expect(runs[0]?.nodeRuns.find(entry => entry.nodeId === 'talk')?.status).toBe('conversing')
      return runs[0] as FlowRun
    }, { timeout: 5000, interval: 10 })
    const conversation = conversing.nodeRuns.find(entry => entry.nodeId === 'talk')?.agentSessionId
    if (conversation === undefined) throw new Error('conversation session missing')
    expect(chain.modelPrompts()[0]).toContain('clarify the task')
    /* The runtime rules and the human request stay distinguishable in the log,
       which is what the client projects as context versus user. */
    expect(chain.sessionSources()).toEqual(['agent-flow', 'user'])

    await chain.controller.load()
    expect(chain.navigated).toEqual([conversation])

    const concluded = await chain.remote.agentFlows.concludeConversation(chain.parent.session.id, conversing.id)
    expect(concluded.ok).toBe(true)
    const settled = await waitRun(chain, 'completed')
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'talk')).toMatchObject({ status: 'succeeded', result: 'done' })

    await chain.controller.load()
    expect(chain.locked).toEqual([conversation])
    const reloadedLocks: SessionId[] = []
    const reloaded = chain.makeController(() => {}, (id) => { reloadedLocks.push(id) })
    await reloaded.load()
    expect(reloadedLocks).toEqual([conversation])
    reloaded.dispose()
  })

  it('opens a conversation that reads no run input without inventing a human message', async () => {
    const chain = await bootChain({
      flow: 'interactive',
      input: false,
      responses: [textResponse('done\nResult: done')],
    })
    claimAndSubmit(chain, 'this message is not wired')

    const settled = await waitRun(chain, 'completed')
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'talk')?.status).toBe('succeeded')
    expect(chain.sessionSources()).toEqual(['agent-flow'])
    expect(chain.modelPrompts()[0]).not.toContain('this message is not wired')
  })

  it('surfaces a worker failure on the run record and client state', async () => {
    const chain = await bootChain({
      responses: [() => { throw new Error('worker refused') }],
    })
    claimAndSubmit(chain, 'fail please')
    const failed = await waitRun(chain, 'failed')
    expect(failed.error).toContain('child stopped with "error"')
    expect(failed.nodeRuns.find(entry => entry.nodeId === 'task1')).toMatchObject({ status: 'failed' })
    expect(failed.nodeRuns.find(entry => entry.nodeId === 'task2')).toMatchObject({ status: 'skipped' })
    await chain.controller.load()
    expect(chain.controller.state.getSnapshot().runs[0]).toMatchObject({ status: 'failed' })
    expect(chain.modelPrompts()).toHaveLength(1)
  })

  it('owns every controller timer so fixture teardown stops polling', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
    const chain = await bootChain({ responses: ['hang'] })
    claimAndSubmit(chain, 'slow task')
    const running = await waitRun(chain, 'running')
    const poll = setIntervalSpy.mock.calls.find(([, delay]) => delay === 1500)
    if (poll === undefined) throw new Error('the controller did not arm its poll')

    cleanup()
    const cleared = new Set<unknown>(clearIntervalSpy.mock.calls.map(call => call[0]))
    expect(setIntervalSpy.mock.results.some(result => result.type === 'return' && cleared.has(result.value))).toBe(true)
    await chain.remote.agentFlows.cancel(chain.parent.session.id, running.id)
    await waitRun(chain, 'cancelled')
  })

  it('cancels a live run through the generated Remote and the client state follows', async () => {
    const chain = await bootChain({ responses: ['hang'] })
    claimAndSubmit(chain, 'slow task')
    const running = await waitRun(chain, 'running')
    const cancelled = await chain.remote.agentFlows.cancel(chain.parent.session.id, running.id)
    expect(cancelled.ok).toBe(true)
    const settled = await waitRun(chain, 'cancelled')
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'task1')).toMatchObject({ status: 'failed', error: 'run cancelled' })
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'task2')).toMatchObject({ status: 'skipped' })
    await chain.controller.load()
    expect(chain.controller.state.getSnapshot().runs[0]).toMatchObject({ status: 'cancelled' })
  })
})
