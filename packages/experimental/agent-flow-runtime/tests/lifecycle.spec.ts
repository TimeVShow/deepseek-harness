import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FlowRun } from '@deepseek-ai/dsh-experimental-agent-flow'
import AgentFlowService from '@deepseek-ai/dsh-experimental-agent-flow'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SubagentService from '@deepseek-ai/dsh-subagent'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as AgentFlowRuntime from '../src/index.ts'
import { GraphExecutor } from '../src/executor.ts'
import { StubProvider } from './stub-provider.ts'

const contexts: Context[] = []
const directories: string[] = []
const stops: (() => void)[] = []

afterEach(async () => {
  for (const stop of stops.splice(0)) stop()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true })
})

interface Deferred {
  readonly promise: Promise<void>
  resolve(): void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

type Mode = 'controller-error' | 'queued-conclude'

interface Harness {
  readonly ctx: Context
  readonly run: FlowRun
  readonly live: Agent
  readonly busy: () => boolean
  readonly cancelled: () => boolean
  readonly concluded: () => boolean
  readonly overlapped: () => boolean
  readonly started: Promise<void>
  readonly cleanup: Deferred
  markTerminal(): void
}

/**
 * Boot the real AgentLoop, storage, service, and GraphExecutor over a scripted
 * provider, then start one interactive flow whose tool holds real work.
 * @param mode - inject a controller failure after opening, or accept a conclude
 *   request while the first turn still runs.
 * @returns the live run, its interactive Agent, and the observation gates.
 */
async function harness(mode: Mode): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Storage)
  const pool = new MemoryMediaPool()
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(AgentFlowService)
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })

  const started = deferred()
  const cleanup = deferred()
  stops.push(() => { cleanup.resolve() })
  let busy = false
  let cancelled = false
  let concluded = false
  let terminal = false
  let overlap = false
  let runId: FlowRun['id'] | undefined

  ctx.tools.register(defineContentToolFixture({
    name: 'held_tool',
    description: 'holds real work until its turn is cancelled and cleanup is released',
    parameters: {},
    async execute(_args, exec) {
      if (terminal) overlap = true
      busy = true
      started.resolve()
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          cancelled = true
          resolve()
        }
        if (exec.signal.aborted) finish()
        else exec.signal.addEventListener('abort', finish, { once: true })
        void cleanup.promise.then(() => { if (!cancelled) resolve() })
      })
      // A failed controller must keep the node's work visible until the test
      // releases cleanup; a cancelled queued turn may drain immediately.
      if (mode === 'controller-error' && cancelled) await cleanup.promise
      busy = false
      return [{ type: 'text', text: 'released' }]
    },
  }))

  const runtime = new GraphExecutor(ctx, {
    executor: 'graph',
    provider: 'unused',
    maxConcurrentAgents: 4,
    maxConversationTurns: 16,
  })
  const first = mode === 'queued-conclude'
    ? (): ReturnType<typeof textResponse> => {
      concluded = runId !== undefined && runtime.concludeConversation(runId)
      return textResponse('ready\nResult: done')
    }
    : toolCallResponse('held-1', 'held_tool', {})
  ctx.llm.registerAdapter(['mock'], new MockAdapter(
    mode === 'queued-conclude' ? [first, toolCallResponse('held-2', 'held_tool', {})] : [first],
  ))
  ctx.agentFlows.registerExecutor({
    name: 'graph',
    cancel: (id) => { runtime.cancel(id) },
    concludeConversation: id => runtime.concludeConversation(id),
    async execute(controller) {
      runId = controller.run.id
      return await runtime.execute({
        ...controller,
        updateNodeRun: async (nodeId, patch) => {
          if (mode === 'controller-error' && patch.agentSessionId !== undefined) {
            await started.promise
            throw new Error('injected node publication failure')
          }
          return await controller.updateNodeRun(nodeId, patch)
        },
      })
    },
  })

  const dir = await mkdtemp(join(tmpdir(), 'dsh-flow-lifecycle-'))
  directories.push(dir)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' }, { cwd: dir })
  const template = await ctx.agentFlows.saveTemplate({ name: 'Clarifier' })
  const flow = await ctx.agentFlows.saveFlow({
    name: 'lifecycle review',
    nodes: [
      { kind: 'start', id: 'start' },
      { kind: 'agent', id: 'talk', templateId: template.id, instruction: 'clarify', interactive: true },
      { kind: 'end', id: 'end' },
    ],
    edges: [
      { kind: 'execution', from: 'start', to: 'talk' },
      { kind: 'execution', from: 'talk', to: 'end' },
    ],
  })
  const run = await ctx.agentFlows.start(parent, { flowId: flow.id, input: 'go', signal: new AbortController().signal })
  await vi.waitFor(() => {
    expect(ctx.agents.roots().some(agent => agent !== parent)).toBe(true)
  }, { timeout: 2000, interval: 10 })
  const live = ctx.agents.roots().find(agent => agent !== parent)
  if (live === undefined) throw new Error('no interactive root agent')
  return {
    ctx,
    run,
    live,
    busy: () => busy,
    cancelled: () => cancelled,
    concluded: () => concluded,
    overlapped: () => overlap,
    started: started.promise,
    cleanup,
    markTerminal: () => {
      terminal = true
      if (busy) overlap = true
    },
  }
}

async function terminal(harness: Harness, status: FlowRun['status']): Promise<FlowRun> {
  return await vi.waitFor(async () => {
    const run = await harness.ctx.agentFlows.readRun(harness.run.id)
    expect(run.status).toBe(status)
    return run
  }, { timeout: 5000, interval: 10 })
}

describe('runtime registration lifecycle', () => {
  it('settles its running flows when the runtime is unloaded, then accepts new runs', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Storage)
    const pool = new MemoryMediaPool()
    ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    await mountWorkingDirectoryFixture(ctx)
    if (ctx.get('sessionProjections') === undefined) await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentService)
    await ctx.plugin(AgentFlowService)
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('Please clarify')]))
    ctx.subagents.registerProvider(new StubProvider('stub', { task: { text: 'done' } }))
    const runtime = await ctx.plugin(AgentFlowRuntime, { provider: 'stub' })
    const dir = await mkdtemp(join(tmpdir(), 'dsh-flow-unload-'))
    directories.push(dir)
    const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' }, { cwd: dir })
    const template = await ctx.agentFlows.saveTemplate({ name: 'Worker' })
    const dialogue = await ctx.agentFlows.saveFlow({
      name: 'dialogue',
      nodes: [
        { kind: 'start', id: 'start' },
        { kind: 'agent', id: 'talk', templateId: template.id, instruction: 'ask', interactive: true },
        { kind: 'end', id: 'end' },
      ],
      edges: [{ kind: 'execution', from: 'start', to: 'talk' }, { kind: 'execution', from: 'talk', to: 'end' }],
    })
    const run = await ctx.agentFlows.start(parent, { flowId: dialogue.id, input: 'go', signal: new AbortController().signal })
    await vi.waitFor(async () => {
      const stored = await ctx.agentFlows.readRun(run.id)
      expect(stored.nodeRuns.find(entry => entry.nodeId === 'talk')?.status).toBe('conversing')
    }, { timeout: 2000, interval: 10 })

    await runtime.dispose()
    await vi.waitFor(async () => {
      expect((await ctx.agentFlows.readRun(run.id)).status).toBe('cancelled')
    }, { timeout: 2000, interval: 10 })
    const settled = await ctx.agentFlows.readRun(run.id)
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'talk')).toMatchObject({ status: 'failed', error: 'run cancelled' })

    await ctx.plugin(AgentFlowRuntime, { provider: 'stub' })
    const linear = await ctx.agentFlows.saveFlow({
      name: 'after reload',
      nodes: [
        { kind: 'start', id: 'start' },
        { kind: 'agent', id: 'task', templateId: template.id, instruction: 'work' },
        { kind: 'end', id: 'end' },
      ],
      edges: [{ kind: 'execution', from: 'start', to: 'task' }, { kind: 'execution', from: 'task', to: 'end' }],
    })
    const next = await ctx.agentFlows.start(parent, { flowId: linear.id, input: 'go', signal: new AbortController().signal })
    await vi.waitFor(async () => {
      expect((await ctx.agentFlows.readRun(next.id)).status).toBe('completed')
    }, { timeout: 2000, interval: 10 })
  })
})

describe('interactive run lifecycle', () => {
  it('cancels and drains a live interactive agent when its controller rejects after opening', async () => {
    const h = await harness('controller-error')
    await h.started
    await vi.waitFor(() => { expect(h.cancelled()).toBe(true) }, { timeout: 2000, interval: 10 })
    const duringFailure = await h.ctx.agentFlows.readRun(h.run.id)
    expect(duringFailure.status).toBe('running')
    expect(h.busy()).toBe(true)

    h.cleanup.resolve()
    const failed = await terminal(h, 'failed')
    expect(failed.error).toContain('injected node publication failure')
    expect(failed.error).toContain('node "talk" failed')
    expect(h.busy()).toBe(false)
    expect(h.live.status).toBe('idle')
    expect(h.overlapped()).toBe(false)
  })

  it('drains runtime-owned queued work before reporting normal completion', async () => {
    const h = await harness('queued-conclude')
    await vi.waitFor(() => { expect(h.concluded()).toBe(true) }, { timeout: 2000, interval: 10 })

    const completed = await terminal(h, 'completed')
    h.markTerminal()
    expect(completed.status).toBe('completed')
    h.cleanup.resolve()
    await h.live.whenIdle()
    // Give a queued follow-up one macrotask to surface before judging overlap.
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(h.busy()).toBe(false)
    expect(h.live.status).toBe('idle')
    expect(h.overlapped()).toBe(false)
  })
})
