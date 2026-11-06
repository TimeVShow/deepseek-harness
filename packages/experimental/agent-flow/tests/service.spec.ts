import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import AgentFlowService from '../src/index.ts'
import { AgentTemplateId, FlowId, FlowRunId } from '../src/index.ts'
import type { FlowDocument, FlowDraft, FlowExecutionResult, FlowNode, FlowRun, FlowRunController } from '../src/index.ts'

const contexts: Context[] = []
const executorGates: { resolve: (value: FlowExecutionResult) => void }[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const gate of executorGates.splice(0)) gate.resolve({ stopReason: 'cancelled' })
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

interface Harness {
  ctx: Context
  service: AgentFlowService
  fiber: Context['fiber']
  pool: MemoryMediaPool
}

/** Boot the real storage/domain/service composition over the in-memory backend. */
async function setup(
  config: Record<string, unknown> = {},
  pool = new MemoryMediaPool(),
  beforeWrite?: (table: string, key: string, value?: unknown) => Promise<void>,
): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(pool)
  if (beforeWrite !== undefined) {
    const open = backend.kv.open.bind(backend.kv)
    backend.kv.open = async (descriptor) => {
      const unit = await open(descriptor)
      const put = unit.putRecord.bind(unit)
      const remove = unit.deleteRecord.bind(unit)
      unit.putRecord = async (table, key, value) => { await beforeWrite(table, key, value); await put(table, key, value) }
      unit.deleteRecord = async (table, key) => { await beforeWrite(table, key); await remove(table, key) }
      return unit
    }
  }
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(AgentFlowService, config)
  return { ctx, service: ctx.agentFlows, fiber, pool }
}

/** Minimal parent Agent: the service reads and records only its session identity. */
const parent = { session: { id: SessionId('parent-session') } } as Agent

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** A storage-readiness gate with no payload. */
function barrier(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((ready) => { resolve = ready })
  return { promise, resolve }
}

/** An executor that records its controller and settles only when the test resolves the gate. */
function gateExecutor(): {
  executor: {
    name: string
    execute: (controller: FlowRunController) => Promise<FlowExecutionResult>
    cancel: ReturnType<typeof vi.fn<(id: FlowRunId) => void>>
    concludeConversation: ReturnType<typeof vi.fn<(id: FlowRunId) => boolean>>
  }
  captured: () => FlowRunController
  gate: ReturnType<typeof deferred<FlowExecutionResult>>
} {
  let controller: FlowRunController | undefined
  const gate = deferred<FlowExecutionResult>()
  executorGates.push(gate)
  const concludeConversation = vi.fn<(id: FlowRunId) => boolean>(() => false)
  return {
    gate,
    captured: () => {
      if (controller === undefined) throw new Error('executor not started')
      return controller
    },
    executor: {
      name: 'graph',
      async execute(received: FlowRunController) {
        controller = received
        return await gate.promise
      },
      cancel: vi.fn<(id: FlowRunId) => void>(),
      concludeConversation,
    },
  }
}

/** Wait for one run to reach a terminal status, polling the persisted record. */
async function waitForSettled(service: AgentFlowService, id: FlowRunId, status: FlowRun['status']): Promise<FlowRun> {
  return await vi.waitFor(async () => {
    const run = await service.readRun(id)
    expect(run.status).toBe(status)
    return run
  }, { timeout: 2000, interval: 10 })
}

/** Save the fixtures: two templates and a graph whose condition node routes to a join. */
async function seed(service: AgentFlowService): Promise<FlowDocument> {
  const classifier = await service.saveTemplate({ name: 'Classifier', description: 'sorts input', provider: 'mock', model: 'mock' })
  const writer = await service.saveTemplate({ name: 'Writer', persona: 'You write concise summaries.' })
  const nodes: FlowNode[] = [
    { kind: 'start', id: 'start' },
    { kind: 'agent', id: 'a1', templateId: classifier.id, instruction: 'classify the request' },
    { kind: 'condition', id: 'c' },
    { kind: 'agent', id: 'a2', templateId: writer.id, instruction: 'handle the fallback' },
    { kind: 'join', id: 'j', mode: 'all' },
    { kind: 'end', id: 'end' },
  ]
  const draft: FlowDraft = {
    name: 'demo',
    nodes,
    edges: [
      { kind: 'execution', from: 'start', to: 'a1' },
      { kind: 'execution', from: 'a1', to: 'c' },
      { kind: 'execution', from: 'c', to: 'j', result: 'direct' },
      { kind: 'execution', from: 'c', to: 'a2', result: 'fallback' },
      { kind: 'execution', from: 'a2', to: 'j' },
      { kind: 'execution', from: 'j', to: 'end' },
    ],
  }
  return await service.saveFlow(draft)
}

/** One task with no conditional paths, for storage ordering cases. */
function linearDraft(templateId: AgentTemplateId): FlowDraft {
  return {
    name: 'linear',
    nodes: [
      { kind: 'start', id: 'start' },
      { kind: 'agent', id: 'task', templateId, instruction: 'do the task' },
      { kind: 'end', id: 'end' },
    ],
    edges: [{ kind: 'execution', from: 'start', to: 'task' }, { kind: 'execution', from: 'task', to: 'end' }],
  }
}

describe('AgentFlowService templates', () => {
  it('creates, reads, lists, and replaces templates', async () => {
    const { service } = await setup()
    const created = await service.saveTemplate({ name: 'Writer', persona: 'stub' })
    expect(created.id).toBeTruthy()
    expect(created.createdAt).toBe(created.updatedAt)

    const replaced = await service.saveTemplate({ id: created.id, name: 'Writer 2', persona: 'stub' })
    expect(replaced.createdAt).toBe(created.createdAt)
    expect(replaced.updatedAt >= created.updatedAt).toBe(true)

    expect((await service.listTemplates()).map(template => template.name)).toEqual(['Writer 2'])
    expect(await service.readTemplate(created.id)).toMatchObject({ name: 'Writer 2' })
  })

  it('rejects empty names, unknown reads, and the template limit', async () => {
    const { service } = await setup({ maxTemplates: 1 })
    await expect(service.saveTemplate({ name: '' })).rejects.toMatchObject({ code: 'agent-flow/invalid' })
    await service.saveTemplate({ name: 'One' })
    await expect(service.saveTemplate({ name: 'Two' })).rejects.toMatchObject({
      code: 'agent-flow/limit',
      details: { kind: 'templates', limit: 1 },
    })
    await expect(service.readTemplate(AgentTemplateId('ghost'))).rejects.toMatchObject({
      code: 'agent-flow/not-found',
      details: { kind: 'template' },
    })
  })
})

describe('AgentFlowService flows', () => {
  it('saves a valid flow, defaults its iteration bound, and rejects invalid ones with their problem list', async () => {
    const { service } = await setup()
    const flow = await seed(service)
    expect(flow.maxIterations).toBe(16)
    expect(await service.readFlow(flow.id)).toMatchObject({ name: 'demo' })
    expect((await service.listFlows()).map(entry => entry.name)).toEqual(['demo'])

    const custom = await service.saveFlow({ ...structuredClone(flow), id: undefined, name: 'custom', maxIterations: 3 })
    expect(custom.maxIterations).toBe(3)

    const cycle: FlowDraft = structuredClone(flow)
    cycle.nodes = cycle.nodes.filter(node => node.id !== 'c')
    cycle.edges = [
      { kind: 'execution', from: 'start', to: 'a1' },
      { kind: 'execution', from: 'a1', to: 'a2' },
      { kind: 'execution', from: 'a2', to: 'a1' },
      { kind: 'execution', from: 'a1', to: 'j' },
      { kind: 'execution', from: 'a2', to: 'j' },
      { kind: 'execution', from: 'j', to: 'end' },
    ]
    await expect(service.saveFlow(cycle)).rejects.toHaveProperty('details.problems.0.code', 'cycle')

    await expect(service.saveFlow({ ...structuredClone(flow), name: '' })).rejects.toMatchObject({
      code: 'agent-flow/invalid',
      details: { problems: [{ code: 'empty-name' }] },
    })

    await expect(service.saveFlow({ ...structuredClone(flow), maxIterations: 0 })).rejects.toMatchObject({
      code: 'agent-flow/invalid',
      details: { problems: [{ code: 'invalid-max-iterations' }] },
    })
  })

  it('enforces the flow limit and refuses deleting templates referenced by flows', async () => {
    const { service } = await setup({ maxFlows: 1 })
    const flow = await seed(service)
    const templates = await service.listTemplates()

    await expect(service.saveFlow({ ...structuredClone(flow), id: undefined, name: 'second' })).rejects.toMatchObject({
      code: 'agent-flow/limit',
      details: { kind: 'flows', limit: 1 },
    })

    await expect(service.deleteTemplate(templates[0]!.id)).rejects.toMatchObject({
      code: 'agent-flow/template-in-use',
      details: { flows: [String(flow.id)] },
    })
    await service.deleteFlow(flow.id)
    await expect(service.deleteTemplate(templates[0]!.id)).resolves.toBe(undefined)
  })
  it('rejects invalid executor registrations and treats a repeated disposer as a no-op', async () => {
    const { service } = await setup()
    const flow = await seed(service)
    const executor = gateExecutor().executor
    expect(() => service.registerExecutor({ ...executor, name: '  ' })).toThrow('executor name must not be empty')
    const dispose = service.registerExecutor(executor)
    expect(() => service.registerExecutor(gateExecutor().executor)).toThrow('duplicate agent flow executor: graph')
    await dispose()
    await dispose()
    await expect(service.start(parent, { flowId: flow.id, input: 'x', signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'agent-flow/executor-missing' })
  })

  it('cannot admit a run into an executor unregistered while its first write was pending', async () => {
    const putReached = barrier()
    const releasePut = barrier()
    let firstRunWrite = true
    const { service } = await setup({}, new MemoryMediaPool(), async (table, _key, value) => {
      if (!firstRunWrite || table !== 'runs' || typeof value !== 'object' || value === null || !('status' in value) || value.status !== 'running') return
      firstRunWrite = false
      putReached.resolve()
      await releasePut.promise
    })
    const flow = await seed(service)
    let signal: AbortSignal | undefined
    const executor = {
      name: 'graph',
      async execute(controller: FlowRunController): Promise<FlowExecutionResult> {
        signal = controller.signal
        await new Promise<void>((resolve) => {
          if (controller.signal.aborted) resolve()
          else controller.signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
        return { stopReason: 'cancelled' }
      },
      cancel: (_id: FlowRunId): void => {},
      concludeConversation: (_id: FlowRunId): boolean => false,
    }
    const unregister = service.registerExecutor(executor)
    const starting = service.start(parent, { flowId: flow.id, input: 'go', signal: new AbortController().signal })
    await putReached.promise
    const unloading = unregister()
    releasePut.resolve()
    const run = await starting
    await unloading
    await waitForSettled(service, run.id, 'cancelled')
    expect(signal?.aborted).toBe(true)
  })

  it('rejects a blank executor name at load', async () => {
    await expect(setup({ executor: '   ' })).rejects.toThrow('executor must not be an empty name')
  })

  it('defaults every deployment limit when constructed with an empty config', () => {
    const ctx = new Context()
    contexts.push(ctx)
    const service = new AgentFlowService(ctx)
    expect(() => service.registerExecutor(gateExecutor().executor)).not.toThrow()
  })

  it('retains a completed outcome after a failed terminal write and retries it on cancel', async () => {
    const attempted = barrier()
    let unavailable = false
    const { service, ctx } = await setup({ maxRuns: 1 }, new MemoryMediaPool(), async (table, _key, value) => {
      if (table === 'runs' && typeof value === 'object' && value !== null && 'status' in value && value.status !== 'running' && unavailable) {
        attempted.resolve()
        throw new Error('terminal storage unavailable')
      }
    })
    const report = vi.spyOn(ctx.logger, 'error')
    const flow = await seed(service)
    const first = gateExecutor()
    const disposeFirst = service.registerExecutor(first.executor)
    const settledRun = await service.start(parent, { flowId: flow.id, input: 'a', signal: new AbortController().signal })
    first.gate.resolve({ stopReason: 'completed' })
    await waitForSettled(service, settledRun.id, 'completed')
    await disposeFirst()

    const second = gateExecutor()
    service.registerExecutor(second.executor)
    const failingRun = await service.start(parent, { flowId: flow.id, input: 'b', signal: new AbortController().signal })
    unavailable = true
    second.gate.resolve({ stopReason: 'completed' })
    await attempted.promise
    await expect(service.readRun(failingRun.id)).rejects.toThrow('terminal storage unavailable')
    expect(report).toHaveBeenCalledWith(expect.stringContaining('outcome is retained for retry'))
    await expect(second.captured().updateNodeRun('a1', { status: 'running' })).rejects.toMatchObject({ code: 'agent-flow/run-not-active' })

    unavailable = false
    await service.cancel(parent, failingRun.id)
    expect(second.executor.cancel).not.toHaveBeenCalled()
    expect(await service.readRun(failingRun.id)).toMatchObject({ status: 'completed' })
    expect(await service.listRuns()).toHaveLength(1)
    await expect(service.readRun(settledRun.id)).rejects.toMatchObject({ code: 'agent-flow/not-found' })
    await expect(service.deleteFlow(flow.id)).resolves.toBeUndefined()
  })

  it('keeps terminal records readable when retention deletion fails', async () => {
    const { service, pool, ctx } = await setup({ maxRuns: 1 })
    const flow = await seed(service)
    const harness = gateExecutor()
    service.registerExecutor(harness.executor)
    const first = await service.start(parent, { flowId: flow.id, input: 'a', signal: new AbortController().signal })
    harness.gate.resolve({ stopReason: 'completed' })
    await waitForSettled(service, first.id, 'completed')
    const warn = vi.spyOn(ctx.logger, 'warn')
    vi.spyOn(pool, 'consumeInjectedFailure')
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => { throw new Error('retention unavailable') })
    const second = await service.start(parent, { flowId: flow.id, input: 'b', signal: new AbortController().signal })
    await waitForSettled(service, second.id, 'completed')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('retention unavailable'))
    expect((await service.listRuns()).map(run => run.status)).toEqual(['completed', 'completed'])
  })

  it('drops only one colliding run under the retention limit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const pin = () => vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const { service } = await setup({ maxRuns: 1 })
    const flow = await seed(service)
    const first = gateExecutor()
    const disposeFirst = service.registerExecutor(first.executor)
    pin()
    const runA = await service.start(parent, { flowId: flow.id, input: 'a', signal: new AbortController().signal })
    first.gate.resolve({ stopReason: 'completed' })
    await waitForSettled(service, runA.id, 'completed')
    await disposeFirst()

    const second = gateExecutor()
    service.registerExecutor(second.executor)
    pin()
    const runB = await service.start(parent, { flowId: flow.id, input: 'b', signal: new AbortController().signal })
    second.gate.resolve({ stopReason: 'completed' })

    const remaining = await vi.waitFor(async () => {
      const runs = await service.listRuns()
      expect(runs).toHaveLength(1)
      return runs
    }, { timeout: 2000, interval: 10 })
    expect([String(runA.id), String(runB.id)]).toContain(String(remaining[0]!.id))
    expect(remaining[0]!.status).toBe('completed')
  })

  it('breaks display-order ties deterministically', async () => {
    const { service } = await setup()
    await service.saveTemplate({ name: 'Same' })
    await service.saveTemplate({ name: 'Same' })
    const templateIds = (await service.listTemplates()).map(template => String(template.id))
    expect(templateIds).toEqual(templateIds.slice().sort((a, b) => a.localeCompare(b)))

    const flow = await seed(service)
    await service.saveFlow({ ...structuredClone(flow), id: undefined })
    const flowIds = (await service.listFlows()).map(entry => String(entry.id))
    expect(flowIds).toEqual(flowIds.slice().sort((a, b) => a.localeCompare(b)))
  })

  it('rejects records that fail their persisted schema', async () => {
    const { service } = await setup()
    const flow = await seed(service)
    await expect(service.saveTemplate({ name: 'Bad', model: 5 } as never)).rejects.toMatchObject({
      code: 'agent-flow/invalid',
      details: { problems: [{ code: 'invalid-record' }] },
    })
    await expect(service.saveFlow({ ...structuredClone(flow), edges: 'nope' as never })).rejects.toMatchObject({
      code: 'agent-flow/invalid',
      details: { problems: [{ code: 'invalid-record' }] },
    })
  })

  it('resolves unknown identities as not-found on every read and delete', async () => {
    const { service } = await setup()
    await seed(service)
    await expect(service.readFlow(FlowId('ghost'))).rejects.toMatchObject({
      code: 'agent-flow/not-found', details: { kind: 'flow' },
    })
    await expect(service.deleteFlow(FlowId('ghost'))).rejects.toMatchObject({ code: 'agent-flow/not-found' })
    await expect(service.readRun(FlowRunId('ghost'))).rejects.toMatchObject({
      code: 'agent-flow/not-found', details: { kind: 'run' },
    })
    await expect(service.deleteTemplate(AgentTemplateId('ghost'))).rejects.toMatchObject({
      code: 'agent-flow/not-found', details: { kind: 'template' },
    })
  })
})

describe('AgentFlowService operation ordering', () => {
  it('admits only one concurrent flow creation at the count limit', async () => {
    const entered = barrier()
    const release = barrier()
    const { service } = await setup({ maxFlows: 1 }, new MemoryMediaPool(), async (table) => {
      if (table === 'flows') { entered.resolve(); await release.promise }
    })
    const template = await service.saveTemplate({ name: 'Worker' })
    const first = service.saveFlow(linearDraft(template.id))
    await entered.promise
    const second = expect(service.saveFlow({ ...linearDraft(template.id), name: 'second' }))
      .rejects.toMatchObject({ code: 'agent-flow/limit', details: { kind: 'flows', limit: 1 } })
    release.resolve()
    await first
    await second
    expect(await service.listFlows()).toHaveLength(1)
  })

  it('admits only one concurrent template creation at the count limit', async () => {
    const entered = barrier()
    const release = barrier()
    const { service } = await setup({ maxTemplates: 1 }, new MemoryMediaPool(), async (table) => {
      if (table === 'templates') { entered.resolve(); await release.promise }
    })
    const first = service.saveTemplate({ name: 'first' })
    await entered.promise
    const second = expect(service.saveTemplate({ name: 'second' }))
      .rejects.toMatchObject({ code: 'agent-flow/limit', details: { kind: 'templates', limit: 1 } })
    release.resolve()
    await first
    await second
    expect(await service.listTemplates()).toHaveLength(1)
  })

  it('keeps a template referenced by a flow whose durable save is still pending', async () => {
    const entered = barrier()
    const release = barrier()
    const { service } = await setup({}, new MemoryMediaPool(), async (table) => {
      if (table === 'flows') { entered.resolve(); await release.promise }
    })
    const template = await service.saveTemplate({ name: 'Worker' })
    const saving = service.saveFlow(linearDraft(template.id))
    await entered.promise
    const deleting = expect(service.deleteTemplate(template.id)).rejects.toMatchObject({ code: 'agent-flow/template-in-use' })
    release.resolve()
    const flow = await saving
    await deleting
    expect(await service.readTemplate(template.id)).toMatchObject({ name: 'Worker' })
    expect(await service.readFlow(flow.id)).toMatchObject({ name: 'linear' })
  })

  it('rejects saving a reference whose template deletion was accepted first', async () => {
    const entered = barrier()
    const release = barrier()
    const { service } = await setup({}, new MemoryMediaPool(), async (table, _key, value) => {
      if (table === 'templates' && value === undefined) { entered.resolve(); await release.promise }
    })
    const template = await service.saveTemplate({ name: 'Worker' })
    const deleting = service.deleteTemplate(template.id)
    await entered.promise
    const saving = expect(service.saveFlow(linearDraft(template.id))).rejects.toMatchObject({
      code: 'agent-flow/invalid', details: { problems: [{ code: 'unknown-template' }] },
    })
    release.resolve()
    await deleting
    await saving
    expect(await service.listFlows()).toEqual([])
  })

  it('reserves a flow while its new run is still being persisted', async () => {
    const entered = barrier()
    const release = barrier()
    const { service } = await setup({}, new MemoryMediaPool(), async (table, _key, value) => {
      if (table === 'runs' && typeof value === 'object' && value !== null && 'status' in value && value.status === 'running') {
        entered.resolve()
        await release.promise
      }
    })
    const flow = await seed(service)
    const harness = gateExecutor()
    service.registerExecutor(harness.executor)
    const starting = service.start(parent, { flowId: flow.id, input: 'go', signal: new AbortController().signal })
    await entered.promise
    const deleting = expect(service.deleteFlow(flow.id)).rejects.toMatchObject({ code: 'agent-flow/flow-in-use' })
    release.resolve()
    const run = await starting
    await deleting
    harness.gate.resolve({ stopReason: 'completed' })
    await waitForSettled(service, run.id, 'completed')
  })

  it('rejects starting a flow whose deletion was accepted first', async () => {
    const entered = barrier()
    const release = barrier()
    const { service } = await setup({}, new MemoryMediaPool(), async (table, _key, value) => {
      if (table === 'flows' && value === undefined) { entered.resolve(); await release.promise }
    })
    const flow = await seed(service)
    const harness = gateExecutor()
    const execute = vi.spyOn(harness.executor, 'execute')
    service.registerExecutor(harness.executor)
    const deleting = service.deleteFlow(flow.id)
    await entered.promise
    const starting = expect(service.start(parent, { flowId: flow.id, input: 'go', signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'agent-flow/not-found' })
    release.resolve()
    await deleting
    await starting
    expect(execute).not.toHaveBeenCalled()
    expect(await service.listRuns()).toEqual([])
  })

  it('keeps live snapshot templates referenced until a terminal write commits', async () => {
    const { service, pool } = await setup()
    const original = await service.saveTemplate({ name: 'original' })
    const replacement = await service.saveTemplate({ name: 'replacement' })
    const flow = await service.saveFlow(linearDraft(original.id))
    const harness = gateExecutor()
    service.registerExecutor(harness.executor)
    const run = await service.start(parent, { flowId: flow.id, input: 'go', signal: new AbortController().signal })
    await service.saveFlow({ ...flow, ...linearDraft(replacement.id) })
    await expect(service.deleteTemplate(original.id)).rejects.toMatchObject({ code: 'agent-flow/template-in-use' })
    pool.failNextWrites = 1
    harness.gate.resolve({ stopReason: 'completed' })
    await vi.waitFor(() => { expect(pool.failNextWrites).toBe(0) })
    await expect(service.deleteTemplate(original.id)).resolves.toBeUndefined()
    expect(await service.readRun(run.id)).toMatchObject({ status: 'completed' })
  })

  it('admits later mutations after a durable write rejects', async () => {
    const { service, pool } = await setup()
    pool.failNextWrites = 1
    await expect(service.saveTemplate({ name: 'failed' })).rejects.toThrow('injected write failure')
    expect(await service.saveTemplate({ name: 'saved' })).toMatchObject({ name: 'saved' })
    expect((await service.listTemplates()).map(template => template.name)).toEqual(['saved'])
  })
})

describe('AgentFlowService runs', () => {
  it('rejects a start without a registered executor or with an empty input', async () => {
    const { service } = await setup()
    const flow = await seed(service)
    const signal = () => new AbortController().signal

    await expect(service.start(parent, { flowId: flow.id, input: 'x', signal: signal() }))
      .rejects.toMatchObject({ code: 'agent-flow/executor-missing' })

    const unregister = service.registerExecutor(gateExecutor().executor)
    await unregister()
    await expect(service.start(parent, { flowId: flow.id, input: 'x', signal: signal() }))
      .rejects.toMatchObject({ code: 'agent-flow/executor-missing' })

    const dispose = service.registerExecutor(gateExecutor().executor)
    await expect(service.start(parent, { flowId: flow.id, input: '  ', signal: signal() }))
      .rejects.toMatchObject({ code: 'agent-flow/invalid', details: { problems: [{ code: 'empty-input' }] } })
    await dispose()
  })

  it('persists a running run, drives node-run updates, and settles it once', async () => {
    const { service } = await setup()
    const flow = await seed(service)
    const harness = gateExecutor()
    service.registerExecutor(harness.executor)

    const run = await service.start(parent, { flowId: flow.id, input: 'the request', signal: new AbortController().signal })
    expect(run).toMatchObject({ status: 'running', parentSessionId: 'parent-session', input: 'the request' })
    expect(run.snapshot.id).toBe(flow.id)
    expect(run.nodeRuns.map(entry => entry.nodeId)).toEqual(['start', 'a1', 'c', 'a2', 'j', 'end'])
    expect(run.nodeRuns.every(entry => entry.iteration === 0 && entry.status === 'pending')).toBe(true)
    expect(await service.readRun(run.id)).toMatchObject({ status: 'running' })

    const started = await harness.captured().updateNodeRun('a1', { status: 'running', startedAt: '2026-09-24T00:00:01.000Z' })
    expect(started.nodeRuns.find(entry => entry.nodeId === 'a1')).toMatchObject({ status: 'running' })

    await expect(harness.captured().updateNodeRun('ghost', { status: 'running' })).rejects.toMatchObject({
      code: 'agent-flow/invalid',
      details: { problems: [{ code: 'unknown-node' }] },
    })
    await expect(harness.captured().startNodeIteration('ghost')).rejects.toMatchObject({
      code: 'agent-flow/invalid',
      details: { problems: [{ code: 'unknown-node' }] },
    })

    const updated = await harness.captured().updateNodeRun('a1', {
      status: 'succeeded',
      handoff: 'classified\n\nResult: direct',
      result: 'direct',
      dir: '/workspace/.dsh/flows/run/00-a1',
      files: ['/workspace/.dsh/flows/run/00-a1/report.md'],
      agentSessionId: SessionId('child-session'),
      startedAt: '2026-09-24T00:00:01.000Z',
      endedAt: '2026-09-24T00:00:02.000Z',
    })
    expect(updated.nodeRuns.find(entry => entry.nodeId === 'a1')).toMatchObject({
      status: 'succeeded',
      result: 'direct',
      agentSessionId: 'child-session',
      endedAt: '2026-09-24T00:00:02.000Z',
    })
    const bound = await harness.captured().updateNodeRun('a2', { inputs: [{ nodeId: 'a1', iteration: 0 }], userInput: true })
    expect(bound.nodeRuns.find(entry => entry.nodeId === 'a2')).toMatchObject({ inputs: [{ nodeId: 'a1', iteration: 0 }], userInput: true })
    const failed = await harness.captured().updateNodeRun('a2', { status: 'failed', error: 'agent refused', inputs: [], userInput: false })
    expect(failed.nodeRuns.find(entry => entry.nodeId === 'a2')).toMatchObject({ status: 'failed', error: 'agent refused', inputs: [], userInput: false })
    const noted = await harness.captured().updateNodeRun('j', { handoff: 'still waiting' })
    expect(noted.nodeRuns.find(entry => entry.nodeId === 'j')).toMatchObject({ status: 'pending', handoff: 'still waiting' })
    expect(harness.captured().run.nodeRuns.find(entry => entry.nodeId === 'a1')).toMatchObject({ status: 'pending' })

    harness.gate.resolve({ stopReason: 'completed' })
    const settled = await waitForSettled(service, run.id, 'completed')
    expect(settled.endedAt).toBeTruthy()
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'a1')).toMatchObject({ status: 'succeeded' })

    await expect(harness.captured().updateNodeRun('a1', { status: 'running' })).rejects.toMatchObject({
      code: 'agent-flow/run-not-active',
    })
    await expect(harness.captured().startNodeIteration('a1')).rejects.toMatchObject({
      code: 'agent-flow/run-not-active',
    })
  })

  it('appends one entry per re-iteration and patches only the latest', async () => {
    const { service } = await setup()
    const flow = await seed(service)
    const harness = gateExecutor()
    service.registerExecutor(harness.executor)
    const run = await service.start(parent, { flowId: flow.id, input: 't', signal: new AbortController().signal })

    await harness.captured().updateNodeRun('a1', { status: 'succeeded', handoff: 'first', result: 'fallback' })
    const second = await harness.captured().startNodeIteration('a1')
    const entries = second.nodeRuns.filter(entry => entry.nodeId === 'a1')
    expect(entries).toHaveLength(2)
    expect(entries[1]).toMatchObject({ iteration: 1, status: 'running' })

    await harness.captured().updateNodeRun('a1', { status: 'succeeded', handoff: 'second', result: 'direct' })
    const third = await harness.captured().startNodeIteration('a1')
    expect(third.nodeRuns.filter(entry => entry.nodeId === 'a1')).toHaveLength(3)

    const stored = await service.readRun(run.id)
    const storedEntries = stored.nodeRuns.filter(entry => entry.nodeId === 'a1')
    expect(storedEntries[0]).toMatchObject({ iteration: 0, status: 'succeeded', handoff: 'first' })
    expect(storedEntries[1]).toMatchObject({ iteration: 1, status: 'succeeded', handoff: 'second' })
    expect(storedEntries[2]).toMatchObject({ iteration: 2, status: 'running' })

    harness.gate.resolve({ stopReason: 'completed' })
    await waitForSettled(service, run.id, 'completed')
  })

  it('keeps concurrent node-run updates from overwriting each other', async () => {
    const { service } = await setup()
    const flow = await seed(service)
    const harness = gateExecutor()
    service.registerExecutor(harness.executor)
    const run = await service.start(parent, { flowId: flow.id, input: 't', signal: new AbortController().signal })

    await Promise.all([
      harness.captured().updateNodeRun('a1', { status: 'succeeded', handoff: 'first' }),
      harness.captured().updateNodeRun('a2', { status: 'succeeded', handoff: 'second' }),
      harness.captured().updateNodeRun('j', { status: 'succeeded' }),
    ])

    const stored = await service.readRun(run.id)
    expect(stored.nodeRuns.find(entry => entry.nodeId === 'a1')).toMatchObject({ status: 'succeeded', handoff: 'first' })
    expect(stored.nodeRuns.find(entry => entry.nodeId === 'a2')).toMatchObject({ status: 'succeeded', handoff: 'second' })
    expect(stored.nodeRuns.find(entry => entry.nodeId === 'j')).toMatchObject({ status: 'succeeded' })

    harness.gate.resolve({ stopReason: 'completed' })
    await waitForSettled(service, run.id, 'completed')
  })

  it('exposes the browser start and cancel remotes through the same run authority', async () => {
    const { service } = await setup()
    const flow = await seed(service)
    const harness = gateExecutor()
    service.registerExecutor(harness.executor)

    const run = await service.startForClient(parent, { flowId: flow.id, input: 't' }, new AbortController().signal)
    expect(run).toMatchObject({ status: 'running', parentSessionId: 'parent-session' })
    expect(run.snapshot.id).toBe(flow.id)

    await expect(service.cancelForClient({ session: { id: SessionId('other') } } as Agent, run.id))
      .rejects.toMatchObject({ code: 'agent-flow/not-found' })
    await service.cancelForClient(parent, run.id)
    expect(harness.executor.cancel).toHaveBeenCalledWith(run.id)

    harness.gate.resolve({ stopReason: 'cancelled' })
    await waitForSettled(service, run.id, 'cancelled')
  })

  it('rejects a start whose signal is already aborted', async () => {
    const { service } = await setup()
    const flow = await seed(service)
    const abort = new AbortController()
    abort.abort()
    await expect(service.start(parent, { flowId: flow.id, input: 'x', signal: abort.signal }))
      .rejects.toMatchObject({
        code: 'agent-flow/invalid',
        details: { problems: [{ code: 'aborted' }] },
      })
  })

  it('orders runs by id when start timestamps collide', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const pin = () => vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const { service } = await setup()
    const flow = await seed(service)
    const harness = gateExecutor()
    service.registerExecutor(harness.executor)
    pin()
    const first = await service.start(parent, { flowId: flow.id, input: 'a', signal: new AbortController().signal })
    pin()
    const second = await service.start(parent, { flowId: flow.id, input: 'b', signal: new AbortController().signal })

    harness.gate.resolve({ stopReason: 'completed' })
    await waitForSettled(service, first.id, 'completed')
    await waitForSettled(service, second.id, 'completed')

    const ids = (await service.listRuns()).map(run => String(run.id))
    expect(ids).toEqual(ids.slice().sort((a, b) => a.localeCompare(b)))
  })

  it('settles a failed executor and a rejected one without leaving a running record', async () => {
    const { service } = await setup()
    const flow = await seed(service)

    const failing = gateExecutor()
    const disposeGate = service.registerExecutor(failing.executor)
    const failedRun = await service.start(parent, { flowId: flow.id, input: 't', signal: new AbortController().signal })
    failing.gate.resolve({ stopReason: 'failed', error: 'agent refused' })
    await expect(waitForSettled(service, failedRun.id, 'failed')).resolves.toMatchObject({ error: 'agent refused' })
    await disposeGate()

    const rejecting = deferred<never>()
    service.registerExecutor({
      name: 'graph',
      execute: async () => await rejecting.promise,
      cancel: vi.fn<() => void>(),
      concludeConversation: vi.fn<() => boolean>(() => false),
    })
    const rejectedRun = await service.start(parent, { flowId: flow.id, input: 't', signal: new AbortController().signal })
    rejecting.reject(new Error('infrastructure fault'))
    await expect(waitForSettled(service, rejectedRun.id, 'failed')).resolves.toMatchObject({ error: 'infrastructure fault' })
  })

  it('settles a run whose executor rejects a non-Error value', async () => {
    const { service } = await setup()
    const flow = await seed(service)
    const rejecting = deferred<never>()
    service.registerExecutor({
      name: 'graph',
      execute: async () => await rejecting.promise,
      cancel: vi.fn<() => void>(),
      concludeConversation: vi.fn<() => boolean>(() => false),
    })
    const run = await service.start(parent, { flowId: flow.id, input: 't', signal: new AbortController().signal })
    rejecting.reject('plain failure')
    await expect(waitForSettled(service, run.id, 'failed')).resolves.toMatchObject({ error: 'plain failure' })
  })

  it('cancels an in-flight run through its executor and rejects foreign or settled cancels', async () => {
    const { service } = await setup()
    const flow = await seed(service)
    const harness = gateExecutor()
    service.registerExecutor(harness.executor)
    const run = await service.start(parent, { flowId: flow.id, input: 't', signal: new AbortController().signal })

    await expect(service.cancel({ session: { id: SessionId('other') } } as Agent, run.id)).rejects.toMatchObject({
      code: 'agent-flow/not-found',
    })
    await service.cancel(parent, run.id)
    expect(harness.executor.cancel).toHaveBeenCalledWith(run.id)
    expect(harness.captured().signal.aborted).toBe(true)
    harness.gate.resolve({ stopReason: 'cancelled' })
    await waitForSettled(service, run.id, 'cancelled')

    await expect(service.cancel(parent, run.id)).rejects.toMatchObject({ code: 'agent-flow/run-not-active' })
    await expect(service.cancel(parent, FlowRunId('ghost'))).rejects.toMatchObject({ code: 'agent-flow/not-found' })
  })

  it('concludes an in-flight conversation through its executor and rejects a run with none', async () => {
    const { service } = await setup()
    const flow = await seed(service)
    const harness = gateExecutor()
    service.registerExecutor(harness.executor)
    const run = await service.start(parent, { flowId: flow.id, input: 't', signal: new AbortController().signal })

    await expect(service.concludeConversation({ session: { id: SessionId('other') } } as Agent, run.id))
      .rejects.toMatchObject({ code: 'agent-flow/not-found' })
    /* The engine reports no conversation, so the caller learns there is nothing to end. */
    await expect(service.concludeConversation(parent, run.id))
      .rejects.toMatchObject({ code: 'agent-flow/not-conversing', details: { id: String(run.id) } })
    expect(harness.executor.concludeConversation).toHaveBeenCalledWith(run.id)

    harness.executor.concludeConversation.mockReturnValue(true)
    await expect(service.concludeConversationForClient({ session: { id: SessionId('other') } } as Agent, run.id))
      .rejects.toMatchObject({ code: 'agent-flow/not-found' })
    await expect(service.concludeConversationForClient(parent, run.id)).resolves.toBe(undefined)

    harness.gate.resolve({ stopReason: 'completed' })
    await waitForSettled(service, run.id, 'completed')
    await expect(service.concludeConversation(parent, run.id)).rejects.toMatchObject({ code: 'agent-flow/run-not-active' })
    await expect(service.concludeConversation(parent, FlowRunId('ghost'))).rejects.toMatchObject({ code: 'agent-flow/not-found' })
  })

  it('refuses deleting a flow with an in-flight run', async () => {
    const { service } = await setup()
    const flow = await seed(service)
    const harness = gateExecutor()
    service.registerExecutor(harness.executor)
    const run = await service.start(parent, { flowId: flow.id, input: 't', signal: new AbortController().signal })

    await expect(service.deleteFlow(flow.id)).rejects.toMatchObject({
      code: 'agent-flow/flow-in-use',
      details: { runs: [String(run.id)] },
    })

    harness.gate.resolve({ stopReason: 'completed' })
    await waitForSettled(service, run.id, 'completed')
    await expect(service.deleteFlow(flow.id)).resolves.toBe(undefined)
  })

  it('keeps only the configured number of settled runs', async () => {
    const { service } = await setup({ maxRuns: 1 })
    const flow = await seed(service)
    const harness = gateExecutor()
    service.registerExecutor(harness.executor)

    for (let index = 0; index < 2; index++) {
      const run = await service.start(parent, {
        flowId: flow.id,
        input: String(index),
        signal: new AbortController().signal,
      })
      harness.gate.resolve({ stopReason: 'completed' })
      await waitForSettled(service, run.id, 'completed')
    }

    const runs = await service.listRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.input).toBe('1')
  })

  it.each(['read', 'list', 'delete-flow'] as const)('retries a failed terminal write through %s', async (operation) => {
    const { service, pool } = await setup()
    const flow = await seed(service)
    const harness = gateExecutor()
    service.registerExecutor(harness.executor)
    const run = await service.start(parent, { flowId: flow.id, input: 'go', signal: new AbortController().signal })
    pool.failNextWrites = 1
    harness.gate.resolve({ stopReason: 'completed' })
    await vi.waitFor(() => { expect(pool.failNextWrites).toBe(0) })
    if (operation === 'read') expect(await service.readRun(run.id)).toMatchObject({ status: 'completed' })
    if (operation === 'list') expect(await service.listRuns()).toMatchObject([{ id: run.id, status: 'completed' }])
    if (operation === 'delete-flow') {
      await service.deleteFlow(flow.id)
      expect(await service.listFlows()).toEqual([])
      expect(await service.readRun(run.id)).toMatchObject({ status: 'completed' })
    }
  })

  it('marks ownerless running records failed on reopen without executing them', async () => {
    const pool = new MemoryMediaPool()
    const first = await setup({}, pool)
    const flow = await seed(first.service)
    const harness = gateExecutor()
    first.service.registerExecutor(harness.executor)
    const run = await first.service.start(parent, { flowId: flow.id, input: 'go', signal: new AbortController().signal })
    harness.gate.resolve({ stopReason: 'completed' })
    const completed = await waitForSettled(first.service, run.id, 'completed')
    await first.fiber.dispose()
    const records = pool.media.get('agent_flow')?.tables.get('runs')
    if (records === undefined) throw new Error('run medium was not created')
    records.set(String(run.id), {
      ...completed,
      status: 'running',
      endedAt: undefined,
      nodeRuns: completed.nodeRuns.map(node => ({
        ...node,
        status: node.nodeId === 'start' ? 'succeeded' : node.nodeId === 'a1' ? 'running' : node.nodeId === 'a2' ? 'conversing' : 'pending',
      })),
    })

    pool.failNextWrites = 1
    await expect(setup({}, pool)).rejects.toThrow('injected write failure')
    expect(records.get(String(run.id))).toMatchObject({ status: 'running' })
    const fresh = await setup({}, pool)
    const reopened = await fresh.service.readRun(run.id)
    expect(reopened.status).toBe('failed')
    expect(reopened.error).toContain('no live executor')
    expect(reopened.endedAt).toBeTypeOf('string')
    expect(reopened.nodeRuns.find(node => node.nodeId === 'start')).toMatchObject({ status: 'succeeded' })
    expect(reopened.nodeRuns.find(node => node.nodeId === 'a1')).toMatchObject({ status: 'failed', error: reopened.error })
    expect(reopened.nodeRuns.find(node => node.nodeId === 'a2')).toMatchObject({ status: 'failed', error: reopened.error })
    expect(reopened.nodeRuns.find(node => node.nodeId === 'end')).toMatchObject({ status: 'skipped' })
    await expect(fresh.service.deleteFlow(flow.id)).resolves.toBeUndefined()
  })

  it('retries a completed outcome during unload before closing its domain', async () => {
    const pool = new MemoryMediaPool()
    const { service, fiber } = await setup({}, pool)
    const flow = await seed(service)
    const harness = gateExecutor()
    service.registerExecutor(harness.executor)
    const run = await service.start(parent, { flowId: flow.id, input: 'go', signal: new AbortController().signal })
    pool.failNextWrites = 1
    harness.gate.resolve({ stopReason: 'completed' })
    await vi.waitFor(() => { expect(pool.failNextWrites).toBe(0) })
    await fiber.dispose()
    const fresh = await setup({}, pool)
    expect(await fresh.service.readRun(run.id)).toMatchObject({ status: 'completed' })
    expect(harness.executor.cancel).not.toHaveBeenCalled()
  })

  it('closes its domain after persistent terminal write failures and reconciles on remount', async () => {
    const attempted = barrier()
    let unavailable = false
    const { service, fiber, ctx } = await setup({}, new MemoryMediaPool(), async (table, _key, value) => {
      if (table === 'runs' && typeof value === 'object' && value !== null && 'status' in value && value.status !== 'running' && unavailable) {
        attempted.resolve()
        throw new Error('terminal storage unavailable')
      }
    })
    const report = vi.spyOn(ctx.logger, 'error')
    const flow = await seed(service)
    const harness = gateExecutor()
    service.registerExecutor(harness.executor)
    const run = await service.start(parent, { flowId: flow.id, input: 'go', signal: new AbortController().signal })
    unavailable = true
    harness.gate.resolve({ stopReason: 'completed' })
    await attempted.promise
    await fiber.dispose()
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: 'agent flow service shutdown failed' }))

    unavailable = false
    await ctx.plugin(AgentFlowService)
    const interrupted = await ctx.agentFlows.readRun(run.id)
    expect(interrupted.status).toBe('failed')
    expect(interrupted.error).toContain('no live executor')
  })

  it('drains an accepted start before disposing its execution and domain', async () => {
    const entered = barrier()
    const release = barrier()
    const pool = new MemoryMediaPool()
    const { service, fiber } = await setup({}, pool, async (table, _key, value) => {
      if (table === 'runs' && typeof value === 'object' && value !== null && 'status' in value && value.status === 'running') {
        entered.resolve()
        await release.promise
      }
    })
    const flow = await seed(service)
    const harness = gateExecutor()
    service.registerExecutor(harness.executor)
    const starting = service.start(parent, { flowId: flow.id, input: 'go', signal: new AbortController().signal })
    await entered.promise
    const stopping = fiber.dispose()
    release.resolve()
    const run = await starting
    await vi.waitFor(() => { expect(harness.captured().signal.aborted).toBe(true) })
    harness.gate.resolve({ stopReason: 'cancelled' })
    await stopping
    await expect(service.saveTemplate({ name: 'late' })).rejects.toThrow('service is stopping')
    const fresh = await setup({}, pool)
    expect(await fresh.service.readRun(run.id)).toMatchObject({ status: 'cancelled' })
  })

  it('aborts the run signal even when the executor cancellation callback throws', async () => {
    const { service } = await setup()
    const flow = await seed(service)
    const harness = gateExecutor()
    harness.executor.cancel.mockImplementation(() => { throw new Error('cancel callback failed') })
    service.registerExecutor(harness.executor)
    const run = await service.start(parent, { flowId: flow.id, input: 'go', signal: new AbortController().signal })
    await expect(service.cancel(parent, run.id)).rejects.toThrow('cancel callback failed')
    expect(harness.captured().signal.aborted).toBe(true)
    harness.gate.resolve({ stopReason: 'cancelled' })
    await waitForSettled(service, run.id, 'cancelled')
  })

  it('settles in-flight runs and frees the domain when the service fiber is disposed', async () => {
    const pool = new MemoryMediaPool()
    const { service, fiber } = await setup({}, pool)
    const flow = await seed(service)
    let observedAbort = false
    service.registerExecutor({
      name: 'graph',
      async execute(controller) {
        await new Promise<void>((resolve) => {
          if (controller.signal.aborted) { observedAbort = true; resolve(); return }
          controller.signal.addEventListener('abort', () => { observedAbort = true; resolve() }, { once: true })
        })
        return { stopReason: 'cancelled' }
      },
      cancel: vi.fn<() => void>(),
      concludeConversation: vi.fn<() => boolean>(() => false),
    })
    const run = await service.start(parent, { flowId: flow.id, input: 't', signal: new AbortController().signal })
    expect(run.status).toBe('running')

    await fiber.dispose()
    expect(observedAbort).toBe(true)

    const fresh = await setup({}, pool)
    expect((await fresh.service.listFlows()).map(flow => flow.name)).toEqual(['demo'])
    const settled = (await fresh.service.listRuns())[0]
    expect(settled?.status).toBe('cancelled')
  })
})

describe('AgentFlowService session usage', () => {
  it('occupies the parent session as soon as a run is admitted', async () => {
    const { ctx, service } = await setup()
    const flow = await seed(service)
    const harness = gateExecutor()
    service.registerExecutor(harness.executor)
    const usage = ctx.get('sessionUsage')
    if (usage === undefined) throw new Error('sessionUsage seam was not provided')
    expect(usage.isOccupied(parent.session.id)).toBe(false)
    const notified: string[] = []
    const stop = usage.subscribe?.(sessionId => notified.push(String(sessionId)))

    const run = await service.start(parent, { flowId: flow.id, input: 'go', signal: new AbortController().signal })

    expect(usage.isOccupied(parent.session.id)).toBe(true)
    expect(usage.isOccupied(SessionId('foreign-session'))).toBe(false)
    expect(notified).toEqual([String(parent.session.id)])
    harness.gate.resolve({ stopReason: 'completed' })
    await waitForSettled(service, run.id, 'completed')
    expect(usage.isOccupied(parent.session.id)).toBe(true)

    // A second admitted run for the same Session adds no new occupation report.
    const again = await service.start(parent, { flowId: flow.id, input: 'more', signal: new AbortController().signal })
    harness.gate.resolve({ stopReason: 'completed' })
    await waitForSettled(service, again.id, 'completed')
    expect(notified).toEqual([String(parent.session.id)])
    stop?.()
  })

  it('leaves the session unoccupied when the start is refused before admission', async () => {
    const { ctx, service } = await setup()
    const flow = await seed(service)
    const usage = ctx.get('sessionUsage')
    if (usage === undefined) throw new Error('sessionUsage seam was not provided')
    const notified: string[] = []
    usage.subscribe?.(sessionId => notified.push(String(sessionId)))

    await expect(service.start(parent, { flowId: flow.id, input: '  ', signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'agent-flow/invalid' })
    await expect(service.start(parent, { flowId: flow.id, input: 'x', signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'agent-flow/executor-missing' })
    await expect(service.start(parent, { flowId: FlowId('ghost'), input: 'x', signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'agent-flow/not-found' })

    expect(usage.isOccupied(parent.session.id)).toBe(false)
    expect(notified).toEqual([])
  })

  it('rebuilds occupation over a restart from durable usage records', async () => {
    const pool = new MemoryMediaPool()
    const first = await setup({}, pool)
    const flow = await seed(first.service)
    const harness = gateExecutor()
    first.service.registerExecutor(harness.executor)
    const run = await first.service.start(parent, { flowId: flow.id, input: 'go', signal: new AbortController().signal })
    harness.gate.resolve({ stopReason: 'completed' })
    await waitForSettled(first.service, run.id, 'completed')
    await first.fiber.dispose()

    const fresh = await setup({}, pool)
    const usage = fresh.ctx.get('sessionUsage')
    if (usage === undefined) throw new Error('sessionUsage seam was not provided')
    expect(usage.isOccupied(parent.session.id)).toBe(true)
    expect(usage.isOccupied(SessionId('foreign-session'))).toBe(false)
  })

  it('backfills occupation from a persisted run when the usage record is absent', async () => {
    const pool = new MemoryMediaPool()
    const first = await setup({}, pool)
    const flow = await seed(first.service)
    const harness = gateExecutor()
    first.service.registerExecutor(harness.executor)
    const run = await first.service.start(parent, { flowId: flow.id, input: 'go', signal: new AbortController().signal })
    harness.gate.resolve({ stopReason: 'completed' })
    await waitForSettled(first.service, run.id, 'completed')
    await first.fiber.dispose()
    const usageRecords = pool.media.get('agent_flow')?.tables.get('usage')
    if (usageRecords === undefined) throw new Error('usage medium was not created')
    usageRecords.delete(String(parent.session.id))

    const fresh = await setup({}, pool)
    expect(fresh.ctx.get('sessionUsage')?.isOccupied(parent.session.id)).toBe(true)
    // The backfill rewrote the durable row, not only the in-memory roster.
    expect(usageRecords.has(String(parent.session.id))).toBe(true)
  })

  it('persists backfilled usage so it outlives the run record', async () => {
    const pool = new MemoryMediaPool()
    const first = await setup({ maxRuns: 1 }, pool)
    const flow = await seed(first.service)
    const harness = gateExecutor()
    first.service.registerExecutor(harness.executor)
    const run = await first.service.start(parent, { flowId: flow.id, input: 'go', signal: new AbortController().signal })
    harness.gate.resolve({ stopReason: 'completed' })
    await waitForSettled(first.service, run.id, 'completed')
    await first.fiber.dispose()
    // A pre-upgrade store kept runs without usage rows.
    const usageRecords = pool.media.get('agent_flow')?.tables.get('usage')
    if (usageRecords === undefined) throw new Error('usage medium was not created')
    usageRecords.delete(String(parent.session.id))

    const next = await setup({ maxRuns: 1 }, pool)
    expect(next.ctx.get('sessionUsage')?.isOccupied(parent.session.id)).toBe(true)
    const otherParent = { session: { id: SessionId('other-session') } } as Agent
    const nextHarness = gateExecutor()
    next.service.registerExecutor(nextHarness.executor)
    const newer = await next.service.start(otherParent, { flowId: flow.id, input: 'two', signal: new AbortController().signal })
    nextHarness.gate.resolve({ stopReason: 'completed' })
    await waitForSettled(next.service, newer.id, 'completed')
    await vi.waitFor(async () => {
      await expect(next.service.readRun(run.id)).rejects.toMatchObject({ code: 'agent-flow/not-found' })
    }, { timeout: 2000, interval: 10 })
    await next.fiber.dispose()

    const fresh = await setup({ maxRuns: 1 }, pool)
    expect(fresh.ctx.get('sessionUsage')?.isOccupied(parent.session.id)).toBe(true)
  })

  it('keeps the last proving run when usage cannot be persisted, then recovers', async () => {
    const pool = new MemoryMediaPool()
    const failingUsage = async (table: string, _key: string, value?: unknown): Promise<void> => {
      if (table === 'usage' && value !== undefined) throw new Error('usage storage unavailable')
    }
    const first = await setup({ maxRuns: 1 }, pool, failingUsage)
    const flow = await seed(first.service)
    const harness = gateExecutor()
    first.service.registerExecutor(harness.executor)
    const original = await first.service.start(parent, { flowId: flow.id, input: 'one', signal: new AbortController().signal })
    harness.gate.resolve({ stopReason: 'completed' })
    await waitForSettled(first.service, original.id, 'completed')
    await first.fiber.dispose()

    // Reloading under the same fault cannot backfill the usage row, so the run
    // stays the only proof and retention must keep it.
    const second = await setup({ maxRuns: 1 }, pool, failingUsage)
    const warn = vi.spyOn(second.ctx.logger, 'warn')
    expect(second.ctx.get('sessionUsage')?.isOccupied(parent.session.id)).toBe(true)
    const otherParent = { session: { id: SessionId('other-session') } } as Agent
    const nextHarness = gateExecutor()
    second.service.registerExecutor(nextHarness.executor)
    const newer = await second.service.start(otherParent, { flowId: flow.id, input: 'two', signal: new AbortController().signal })
    nextHarness.gate.resolve({ stopReason: 'completed' })
    await waitForSettled(second.service, newer.id, 'completed')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('agent flow usage record for session "parent-session" failed'))
    await expect(second.service.readRun(original.id)).resolves.toMatchObject({ status: 'completed' })
    expect(await second.service.listRuns()).toHaveLength(2)
    await second.fiber.dispose()

    // A recovered store backfills both usage rows; eviction may now drop runs.
    const third = await setup({ maxRuns: 1 }, pool)
    expect(third.ctx.get('sessionUsage')?.isOccupied(parent.session.id)).toBe(true)
    const thirdParent = { session: { id: SessionId('third-session') } } as Agent
    const thirdHarness = gateExecutor()
    third.service.registerExecutor(thirdHarness.executor)
    const thirdRun = await third.service.start(thirdParent, { flowId: flow.id, input: 'three', signal: new AbortController().signal })
    thirdHarness.gate.resolve({ stopReason: 'completed' })
    await waitForSettled(third.service, thirdRun.id, 'completed')
    await vi.waitFor(async () => {
      await expect(third.service.readRun(original.id)).rejects.toMatchObject({ code: 'agent-flow/not-found' })
    }, { timeout: 2000, interval: 10 })
    await third.fiber.dispose()

    const fresh = await setup({ maxRuns: 1 }, pool)
    expect(fresh.ctx.get('sessionUsage')?.isOccupied(parent.session.id)).toBe(true)
    expect(fresh.ctx.get('sessionUsage')?.isOccupied(otherParent.session.id)).toBe(true)
  })

  it('keeps an evicted run’s session occupied', async () => {
    const otherParent = { session: { id: SessionId('other-session') } } as Agent
    const { ctx, service } = await setup({ maxRuns: 1 })
    const flow = await seed(service)
    const harness = gateExecutor()
    service.registerExecutor(harness.executor)
    const first = await service.start(parent, { flowId: flow.id, input: 'a', signal: new AbortController().signal })
    harness.gate.resolve({ stopReason: 'completed' })
    await waitForSettled(service, first.id, 'completed')
    const second = await service.start(otherParent, { flowId: flow.id, input: 'b', signal: new AbortController().signal })
    harness.gate.resolve({ stopReason: 'completed' })
    await waitForSettled(service, second.id, 'completed')

    await vi.waitFor(async () => {
      await expect(service.readRun(first.id)).rejects.toMatchObject({ code: 'agent-flow/not-found' })
    }, { timeout: 2000, interval: 10 })
    const usage = ctx.get('sessionUsage')
    if (usage === undefined) throw new Error('sessionUsage seam was not provided')
    expect(usage.isOccupied(parent.session.id)).toBe(true)
    expect(usage.isOccupied(otherParent.session.id)).toBe(true)
  })

  it('occupies in-process and logs when the durable usage write fails', async () => {
    const { ctx, service } = await setup({}, new MemoryMediaPool(), async (table, _key, value) => {
      if (table === 'usage' && value !== undefined) throw new Error('usage storage unavailable')
    })
    const warn = vi.spyOn(ctx.logger, 'warn')
    const flow = await seed(service)
    const harness = gateExecutor()
    service.registerExecutor(harness.executor)

    const run = await service.start(parent, { flowId: flow.id, input: 'go', signal: new AbortController().signal })

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('agent flow usage record for session "parent-session" failed'))
    expect(ctx.get('sessionUsage')?.isOccupied(parent.session.id)).toBe(true)
    harness.gate.resolve({ stopReason: 'completed' })
    await waitForSettled(service, run.id, 'completed')
  })
})
