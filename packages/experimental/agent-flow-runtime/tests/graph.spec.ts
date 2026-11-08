import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SubagentService from '@deepseek-ai/dsh-subagent'
import AgentFlowService, { FlowId, FlowRunId } from '@deepseek-ai/dsh-experimental-agent-flow'
import type {
  AgentTemplateId,
  FlowDocument,
  FlowDraft,
  FlowEdge,
  FlowNode,
  FlowNodeRun,
  FlowRun,
} from '@deepseek-ai/dsh-experimental-agent-flow'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as AgentFlowRuntime from '../src/index.ts'
import { GraphExecutor } from '../src/executor.ts'
import { StubAgentRegistry, type StubRootAgent } from './root-agents.ts'
import { StubProvider, type StubScripts } from './stub-provider.ts'

const contexts: Context[] = []
const workspaces: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const dir of workspaces.splice(0)) await rm(dir, { recursive: true, force: true })
})

interface Harness {
  ctx: Context
  service: AgentFlowService
  stub: StubProvider
  roots: StubAgentRegistry
  pool: MemoryMediaPool
  parent: Agent
  workspace: string
  /** Sessions the runtime attached to the parent's workspace. */
  attached: SessionId[]
  /** Titles the runtime renamed, in order. */
  titled: string[]
}

/** Boot the real storage, subagent, Agent Flow, and runtime composition over scripted providers. */
async function setup(options: {
  scripts?: StubScripts
  plugin?: Record<string, unknown>
  service?: Record<string, unknown>
  defaults?: boolean
  /** Omit the optional workspace and title services an interactive node publishes through. */
  bare?: boolean
  /** Reject root-Session creation, as an unavailable agent factory would. */
  rejectCreate?: string
  /** Load the shipped runtime plugin; false leaves executor registration to the test. */
  runtime?: boolean
  /** Reject selected storage writes before the backend sees them. */
  beforeWrite?: (table: string, key: string, value: unknown) => Promise<void>
} = {}): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  const pool = new MemoryMediaPool()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(pool)
  if (options.beforeWrite !== undefined) {
    const beforeWrite = options.beforeWrite
    const open = backend.kv.open.bind(backend.kv)
    backend.kv.open = async (descriptor) => {
      const unit = await open(descriptor)
      const put = unit.putRecord.bind(unit)
      unit.putRecord = async (table, key, value) => {
        await beforeWrite(table, key, value)
        await put(table, key, value)
      }
      return unit
    }
  }
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await mountWorkingDirectoryFixture(ctx)
  if (ctx.get('sessionProjections') === undefined) await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentService)
  const stub = new StubProvider('stub', options.scripts ?? {})
  ctx.subagents.registerProvider(stub)
  const roots = new StubAgentRegistry(ctx)
  if (options.rejectCreate !== undefined) roots.rejectCreate = options.rejectCreate
  ctx.provide('agents', roots)
  ctx.provide('agentDefaultModel', {
    currentSelection: (): ModelSelection => ({
      provider: 'default-route',
      model: 'default-model',
      reasoningEffort: ReasoningEffortId('default-effort'),
    }),
  })
  const attached: SessionId[] = []
  const titled: string[] = []
  if (options.bare !== true) {
    ctx.provide('workspaceRegistry', {
      list: (): { sessionIds: readonly SessionId[]; attachSession(id: SessionId): Promise<void> }[] => [{
        sessionIds: [SessionId('parent-session')],
        attachSession: async (id: SessionId): Promise<void> => { attached.push(id) },
      }],
    })
    ctx.provide('sessionTitle', { rename: (_session: unknown, title: string): void => { titled.push(title) } })
    ctx.provide('agentPresets', { composeFrom: (): string => 'parent-preset' })
  }
  await ctx.plugin(AgentFlowService, options.service ?? {})
  if (options.runtime !== false) {
    if (options.defaults === true) await ctx.plugin(AgentFlowRuntime)
    else await ctx.plugin(AgentFlowRuntime, { provider: 'stub', ...options.plugin })
  }
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-flow-runtime-'))
  workspaces.push(workspace)
  const parent = { id: SessionId('parent-session'), session: { id: SessionId('parent-session'), header: { cwd: workspace }, requestHeader: () => undefined }, ctx } as Agent
  roots.adopt(parent)
  return { ctx, service: ctx.agentFlows, stub, roots, pool, parent, workspace, attached, titled }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((res) => { resolve = res })
  return { promise, resolve }
}

const start = (): FlowNode => ({ kind: 'start', id: 'start' })
const end = (): FlowNode => ({ kind: 'end', id: 'end' })
const agent = (
  id: string,
  templateId: AgentTemplateId,
  instruction: string,
  extras: { title?: string; interactive?: boolean } = {},
): FlowNode => ({
  kind: 'agent',
  id,
  templateId,
  instruction,
  ...extras.title === undefined ? {} : { title: extras.title },
  ...extras.interactive === undefined ? {} : { interactive: extras.interactive },
})
const joinNode = (id: string, mode: 'all'): FlowNode => ({ kind: 'join', id, mode })
const condition = (id: string): FlowNode => ({ kind: 'condition', id })

async function waitForSettled(service: AgentFlowService, id: FlowRunId, status: FlowRun['status']): Promise<FlowRun> {
  return await vi.waitFor(async () => {
    const run = await service.readRun(id)
    expect(run.status).toBe(status)
    return run
  }, { timeout: 2000, interval: 10 })
}

/** Wait until one node's latest run entry reaches a status. */
async function waitForNode(
  service: AgentFlowService,
  id: FlowRunId,
  nodeId: string,
  status: FlowNodeRun['status'],
): Promise<FlowRun> {
  return await vi.waitFor(async () => {
    const run = await service.readRun(id)
    expect(run.nodeRuns.findLast(entry => entry.nodeId === nodeId)?.status).toBe(status)
    return run
  }, { timeout: 2000, interval: 10 })
}

/** Wait for the one root Session an interactive node materializes. */
async function waitForRoot(roots: StubAgentRegistry): Promise<StubRootAgent> {
  await vi.waitFor(() => { expect(roots.created).toHaveLength(1) }, { timeout: 2000, interval: 10 })
  const root = roots.created[0]
  if (root === undefined) throw new Error('no root session was created')
  return root
}

/** Persist one template and one flow, returning the stored document. */
async function seed(
  service: AgentFlowService,
  build: (templateId: AgentTemplateId) => { nodes: FlowNode[]; edges: FlowEdge[]; maxIterations?: number },
): Promise<FlowDocument> {
  const template = await service.saveTemplate({ name: 'Node agent', persona: 'You are precise.' })
  const { nodes, edges, maxIterations } = build(template.id)
  return await service.saveFlow({ name: 'demo', nodes, edges, ...maxIterations === undefined ? {} : { maxIterations } } satisfies FlowDraft)
}

/** Start one run against the harness parent. */
function startRun(harness: Harness, flow: FlowDocument, input = 'write about bugs'): Promise<FlowRun> {
  return harness.service.start(harness.parent, { flowId: flow.id, input, signal: new AbortController().signal })
}

/** The text of one recorded prompt. */
function promptText(request: { prompt: readonly { type: string; text?: string }[] }): string {
  return request.prompt.flatMap(block => block.type === 'text' ? [block.text ?? ''] : []).join('')
}

describe('Agent Flow graph runtime', () => {
  it('runs a linear pipeline with file handoffs and records each node outcome', async () => {
    const harness = await setup({
      scripts: {
        a1: { text: 'first handoff', writes: { 'report.md': '# Report', 'nested/notes.txt': 'notes' } },
        a2: { text: 'final answer' },
      },
    })
    const { service, stub, roots, workspace } = harness
    const flow = await seed(service, templateId => ({
      nodes: [start(), agent('a1', templateId, 'classify the topic'), agent('a2', templateId, 'summarize the classification'), end()],
      edges: [
        { kind: 'execution', from: 'start', to: 'a1' },
        { kind: 'input', from: 'start', to: 'a1' },
        { kind: 'execution', from: 'a1', to: 'a2' },
        { kind: 'execution', from: 'a2', to: 'end' },
      ],
    }))

    const run = await startRun(harness, flow)
    const settled = await waitForSettled(service, run.id, 'completed')

    expect(settled.nodeRuns.map(entry => [entry.nodeId, entry.status])).toEqual([
      ['start', 'succeeded'],
      ['a1', 'succeeded'],
      ['a2', 'succeeded'],
      ['end', 'succeeded'],
    ])
    const dir1 = join(workspace, '.dsh', 'flows', String(run.id), '00-a1')
    const dir2 = join(workspace, '.dsh', 'flows', String(run.id), '00-a2')
    // Each worker's iteration directory is the header cwd of its carrier, which
    // the child inherits as its sandbox root; upstream files stay read-only.
    expect(stub.requests.map(request => request.cwd)).toEqual([dir1, dir2])
    expect(roots.created.map(root => root.options.meta)).toEqual([
      { cwd: dir1, parentSession: 'parent-session', origin: 'subagent', delegationDepth: 0 },
      { cwd: dir2, parentSession: 'parent-session', origin: 'subagent', delegationDepth: 0 },
    ])
    const first = settled.nodeRuns.find(entry => entry.nodeId === 'a1')
    expect(first).toMatchObject({
      iteration: 0,
      handoff: 'first handoff',
      agentSessionId: 'child-1',
      dir: dir1,
      files: [join(dir1, 'nested', 'notes.txt'), join(dir1, 'report.md')],
    })
    expect(first?.startedAt).toBeTruthy()
    expect(first?.endedAt).toBeTruthy()
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'a2')).toMatchObject({
      handoff: 'final answer',
      agentSessionId: 'child-2',
      dir: dir2,
      files: [],
    })

    expect(stub.requests).toHaveLength(2)
    expect(stub.requests[0]).toMatchObject({ label: 'a1' })
    expect(promptText(stub.requests[0]!)).toBe([
      '## Your role\nYou are precise.',
      'classify the topic',
      '## User request\nwrite about bugs',
      `## Your workspace directory\nWrite every document you produce into this directory and nowhere else:\n${dir1}`,
    ].join('\n\n'))
    // a2 has no start edge, so the user request stays out of its prompt.
    expect(promptText(stub.requests[1]!)).toBe([
      '## Your role\nYou are precise.',
      'summarize the classification',
      `## Handoff from a1\nfirst handoff\n\nFiles:\n- ${join(dir1, 'nested', 'notes.txt')}\n- ${join(dir1, 'report.md')}`,
      `## Your workspace directory\nWrite every document you produce into this directory and nowhere else:\n${dir2}`,
    ].join('\n\n'))
    expect(stub.disposed).toEqual(['child-1', 'child-2'])
  })

  it('sends only the subagent options a template actually declares', async () => {
    const harness = await setup({ scripts: { a1: { text: 'ok' } } })
    const { service, stub } = harness
    const template = await service.saveTemplate({ name: 'Bare agent' })
    const flow = await service.saveFlow({
      name: 'bare',
      nodes: [start(), agent('a1', template.id, 'run'), end()],
      edges: [{ kind: 'execution', from: 'start', to: 'a1' }, { kind: 'execution', from: 'a1', to: 'end' }],
    } satisfies FlowDraft)

    const run = await startRun(harness, flow, 'go')
    await waitForSettled(service, run.id, 'completed')

    const request = stub.requests[0] ?? {}
    expect('persona' in request).toBe(false)
    expect('agentOptions' in request).toBe(false)
  })

  it('puts declared personas in the prompt and forwards route overrides, labeling nodes by title', async () => {
    const harness = await setup({ scripts: { 'First step': { text: 'one' }, a2: { text: 'two' }, a3: { text: 'three' } } })
    const { service, stub } = harness
    const routed = await service.saveTemplate({ name: 'Routed', persona: 'You classify.', provider: 'costly-provider', model: 'small-model' })
    const modelOnly = await service.saveTemplate({ name: 'Model only', model: 'draft-model' })
    const providerOnly = await service.saveTemplate({ name: 'Provider only', provider: 'cheap-provider' })
    const flow = await service.saveFlow({
      name: 'routes',
      nodes: [
        start(),
        agent('a1', routed.id, 'one', { title: 'First step' }),
        agent('a2', modelOnly.id, 'two'),
        agent('a3', providerOnly.id, 'three'),
        end(),
      ],
      edges: [
        { kind: 'execution', from: 'start', to: 'a1' },
        { kind: 'execution', from: 'a1', to: 'a2' },
        { kind: 'execution', from: 'a2', to: 'a3' },
        { kind: 'execution', from: 'a3', to: 'end' },
      ],
    } satisfies FlowDraft)

    const run = await startRun(harness, flow, 'go')
    await waitForSettled(service, run.id, 'completed')

    expect(stub.requests[0]).toMatchObject({
      label: 'First step',
      agentOptions: { provider: 'costly-provider', model: 'small-model' },
    })
    expect(promptText(stub.requests[0]!)).toContain('## Your role\nYou classify.')
    expect(stub.requests[1]).toMatchObject({ label: 'a2', agentOptions: { model: 'draft-model' } })
    expect('persona' in (stub.requests[1] ?? {})).toBe(false)
    expect(stub.requests[2]?.agentOptions).toEqual({ provider: 'cheap-provider' })
  })

  it('routes on the Result line through a condition node and skips the untaken path', async () => {
    const harness = await setup({ scripts: { a1: { text: 'took the direct route\nResult: direct' }, a2: { text: 'fallback' } } })
    const { service, stub } = harness
    const flow = await seed(service, templateId => ({
      nodes: [start(), agent('a1', templateId, 'classify'), condition('c'), agent('a2', templateId, 'fallback'), end()],
      edges: [
        { kind: 'execution', from: 'start', to: 'a1' },
        { kind: 'execution', from: 'a1', to: 'c' },
        { kind: 'execution', from: 'c', to: 'end', result: 'direct' },
        { kind: 'execution', from: 'c', to: 'a2', result: 'fallback' },
        { kind: 'execution', from: 'a2', to: 'end' },
      ],
    }))

    const run = await startRun(harness, flow, 'go')
    const settled = await waitForSettled(service, run.id, 'completed')

    expect(settled.nodeRuns.find(entry => entry.nodeId === 'a1')).toMatchObject({ status: 'succeeded', result: 'direct' })
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'c')).toMatchObject({ status: 'succeeded', result: 'direct' })
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'a2')).toMatchObject({ status: 'skipped' })
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'end')).toMatchObject({ status: 'succeeded' })
    expect(stub.requests.map(request => request.label)).toEqual(['a1'])
    expect(promptText(stub.requests[0]!)).toContain('## Routing\nEnd your final message with one line `Result: <word>` where <word> is exactly one of: "direct", "fallback".')
  })

  it('fails loudly when the Result line is missing or out of vocabulary', async () => {
    const harness = await setup({ scripts: { a1: [{ text: 'no line here' }, { text: 'done\nResult: sideways' }] } })
    const { service } = harness
    const build = (templateId: AgentTemplateId): { nodes: FlowNode[]; edges: FlowEdge[] } => ({
      nodes: [start(), agent('a1', templateId, 'classify'), condition('c'), agent('a2', templateId, 'fallback'), end()],
      edges: [
        { kind: 'execution', from: 'start', to: 'a1' },
        { kind: 'execution', from: 'a1', to: 'c' },
        { kind: 'execution', from: 'c', to: 'end', result: 'direct' },
        { kind: 'execution', from: 'c', to: 'a2', result: 'fallback' },
        { kind: 'execution', from: 'a2', to: 'end' },
      ],
    })
    const first = await seed(service, build)
    const second = await seed(service, build)

    const missingRun = await startRun(harness, first, 'go')
    const missing = await waitForSettled(service, missingRun.id, 'failed')
    const expected = 'node "a1" must end its final message with `Result: <word>` using one of: "direct", "fallback"'
    expect(missing.error).toBe(`node "a1" failed: ${expected}`)
    expect(missing.nodeRuns.find(entry => entry.nodeId === 'a1')).toMatchObject({ status: 'failed', error: expected })

    const strayRun = await startRun(harness, second, 'go')
    const stray = await waitForSettled(service, strayRun.id, 'failed')
    expect(stray.error).toBe(`node "a1" failed: ${expected}`)
  })

  it('settles an interactive node on the Result word of its conversation', async () => {
    const harness = await setup({ scripts: { a2: { text: 'implemented' } } })
    const { ctx, service, stub, roots, attached, titled, workspace } = harness
    const flow = await seed(service, templateId => ({
      nodes: [
        start(),
        agent('a1', templateId, 'clarify the request', { title: 'Senior engineer', interactive: true }),
        agent('a2', templateId, 'implement the design'),
        end(),
      ],
      edges: [{ kind: 'execution', from: 'start', to: 'a1' }, { kind: 'input', from: 'start', to: 'a1' }, { kind: 'execution', from: 'a1', to: 'a2' }, { kind: 'execution', from: 'a2', to: 'end' }],
    }))

    const run = await startRun(harness, flow, 'write a sorter')
    const root = await waitForRoot(roots)
    // A node directory cannot be a workspace member, so nothing is attached.
    expect(attached).toEqual([])
    expect(titled).toEqual(['Senior engineer'])
    // The conversation's header cwd is its own iteration directory on every
    // host, which makes it the sandbox root that keeps upstream files read-only.
    const nodeDir = join(workspace, '.dsh', 'flows', String(run.id), '00-a1')
    expect(root.options.meta).toEqual({ cwd: nodeDir })
    expect(ctx.workingDirectory.get(root.agent.session)).toBe(nodeDir)
    expect(root.options.agentOptions).toMatchObject({ provider: 'default-route', model: 'default-model' })
    expect(root.prompts).toHaveLength(2)
    const opening = root.prompts[0] ?? ''
    expect(opening).toContain('## Your role\nYou are precise.')
    expect(opening).not.toContain('## User request')
    expect(opening).toContain('## Conversation\nYou talk with the user directly in this session.')
    expect(opening).toContain('End your final message with one line `Result: <word>` where <word> is exactly one of: "done".')
    expect(root.prompts[1]).toBe('write a sorter')
    expect(root.messages.map(message => message.source.kind)).toEqual(['agent-flow', 'user'])

    // A turn that closes without a Result line leaves the node waiting for the user.
    root.reply('Which language should this be?')
    await waitForNode(service, run.id, 'a1', 'conversing')

    const dir = join(workspace, '.dsh', 'flows', String(run.id), '00-a1')
    await writeFile(join(dir, 'design.md'), '# Design')
    root.reply('design written\nResult: done')
    const settled = await waitForSettled(service, run.id, 'completed')

    expect(settled.nodeRuns.findLast(entry => entry.nodeId === 'a1')).toMatchObject({
      status: 'succeeded',
      result: 'done',
      handoff: 'design written\nResult: done',
      agentSessionId: root.sessionId,
      dir,
      files: [join(dir, 'design.md')],
    })
    // The conversation's outcome reaches the next node as an ordinary handoff.
    expect(promptText(stub.requests[0]!)).toContain('## Handoff from Senior engineer\ndesign written\nResult: done\n\nFiles:\n- ' + join(dir, 'design.md'))
    expect(stub.disposed).toEqual(['child-1'])
  })

  it('runs an interactive node in a composition without workspace, title, or preset services', async () => {
    const harness = await setup({ bare: true })
    const { service, roots, attached, titled } = harness
    const flow = await seed(service, templateId => ({
      nodes: [start(), agent('a1', templateId, 'clarify', { interactive: true }), end()],
      edges: [{ kind: 'execution', from: 'start', to: 'a1' }, { kind: 'execution', from: 'a1', to: 'end' }],
    }))

    const run = await startRun(harness, flow, 'go')
    const root = await waitForRoot(roots)
    root.reply('settled\nResult: done')

    await waitForSettled(service, run.id, 'completed')
    expect(attached).toEqual([])
    expect(titled).toEqual([])
  })

  it('treats a turn that produced no assistant output as an unfinished conversation', async () => {
    const harness = await setup()
    const { service, roots } = harness
    const flow = await seed(service, templateId => ({
      nodes: [start(), agent('a1', templateId, 'clarify', { interactive: true }), end()],
      edges: [{ kind: 'execution', from: 'start', to: 'a1' }, { kind: 'execution', from: 'a1', to: 'end' }],
    }))

    const run = await startRun(harness, flow, 'go')
    const root = await waitForRoot(roots)
    root.closeSilently()
    await waitForNode(service, run.id, 'a1', 'conversing')
    root.reply('settled\nResult: done')

    const settled = await waitForSettled(service, run.id, 'completed')
    expect(settled.nodeRuns.findLast(entry => entry.nodeId === 'a1')).toMatchObject({ status: 'succeeded', handoff: 'settled\nResult: done' })
  })

  it('fails the run when an interactive node uses its conversation budget', async () => {
    const harness = await setup({ plugin: { maxConversationTurns: 2 } })
    const { service, roots } = harness
    const flow = await seed(service, templateId => ({
      nodes: [start(), agent('a1', templateId, 'clarify', { interactive: true }), end()],
      edges: [{ kind: 'execution', from: 'start', to: 'a1' }, { kind: 'execution', from: 'a1', to: 'end' }],
    }))

    const run = await startRun(harness, flow, 'go')
    const root = await waitForRoot(roots)
    root.reply('question one')
    await waitForNode(service, run.id, 'a1', 'conversing')
    root.reply('question two')

    const settled = await waitForSettled(service, run.id, 'failed')
    expect(settled.error).toBe('node "a1" failed: node "a1" used its 2-turn conversation budget without a Result line — raise maxConversationTurns if the clarification is intentionally this long')
  })

  it('fails the run when an interactive turn reports a model failure', async () => {
    const harness = await setup()
    const { service, roots } = harness
    const flow = await seed(service, templateId => ({
      nodes: [start(), agent('a1', templateId, 'clarify', { interactive: true }), end()],
      edges: [{ kind: 'execution', from: 'start', to: 'a1' }, { kind: 'execution', from: 'a1', to: 'end' }],
    }))

    const run = await startRun(harness, flow, 'go')
    const root = await waitForRoot(roots)
    root.fail('provider unavailable')

    const settled = await waitForSettled(service, run.id, 'failed')
    expect(settled.error).toBe('node "a1" failed: the conversation turn failed: provider unavailable')
  })

  it('rejects a Result word outside the vocabulary of the condition node an interactive node feeds', async () => {
    const harness = await setup()
    const { service, roots } = harness
    const flow = await seed(service, templateId => ({
      nodes: [start(), agent('a1', templateId, 'clarify', { interactive: true }), condition('c'), end()],
      edges: [
        { kind: 'execution', from: 'start', to: 'a1' },
        { kind: 'execution', from: 'a1', to: 'c' },
        { kind: 'execution', from: 'c', to: 'end', result: 'settled' },
      ],
    }))

    const run = await startRun(harness, flow, 'go')
    const root = await waitForRoot(roots)
    expect(root.prompts[0]).toContain('exactly one of: "settled".')
    root.reply('handing over\nResult: sideways')

    const settled = await waitForSettled(service, run.id, 'failed')
    expect(settled.error).toBe('node "a1" failed: node "a1" must end its final message with `Result: <word>` using one of: "settled"')
  })

  it('fails the run when the interactive Session cannot be created', async () => {
    const harness = await setup({ rejectCreate: 'no agent factory registered' })
    const { service } = harness
    const flow = await seed(service, templateId => ({
      nodes: [start(), agent('a1', templateId, 'clarify', { interactive: true }), end()],
      edges: [{ kind: 'execution', from: 'start', to: 'a1' }, { kind: 'execution', from: 'a1', to: 'end' }],
    }))

    const run = await startRun(harness, flow, 'go')
    const settled = await waitForSettled(service, run.id, 'failed')
    expect(settled.error).toBe('node "a1" failed: no agent factory registered')
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'a1')).toMatchObject({ status: 'failed', error: 'no agent factory registered' })
  })

  it('names a node by its id when its title carries no text', async () => {
    const harness = await setup({ scripts: { build: { text: 'built' } } })
    const { service, stub, roots, titled } = harness
    const template = await service.saveTemplate({ name: 'Node agent' })
    const flow = await service.saveFlow({
      name: 'blank titles',
      nodes: [
        start(),
        agent('clarify', template.id, 'ask what to build', { title: '   ', interactive: true }),
        agent('build', template.id, 'build it', { title: '' }),
        end(),
      ],
      edges: [{ kind: 'execution', from: 'start', to: 'clarify' }, { kind: 'execution', from: 'clarify', to: 'build' }, { kind: 'execution', from: 'build', to: 'end' }],
    } satisfies FlowDraft)

    const run = await startRun(harness, flow, 'go')
    const root = await waitForRoot(roots)
    root.reply('settled\nResult: done')
    await waitForSettled(service, run.id, 'completed')

    expect(titled).toEqual(['clarify'])
    expect(stub.requests.map(request => request.label)).toEqual(['build'])
    expect(promptText(stub.requests[0]!)).toContain('## Handoff from clarify\n')
  })

  it('ends a clarification on request and settles on the Result word the agent then states', async () => {
    const harness = await setup()
    const { service, roots } = harness
    const flow = await seed(service, templateId => ({
      nodes: [start(), agent('a1', templateId, 'clarify', { interactive: true }), end()],
      edges: [{ kind: 'execution', from: 'start', to: 'a1' }, { kind: 'execution', from: 'a1', to: 'end' }],
    }))

    const run = await startRun(harness, flow, 'go')
    const root = await waitForRoot(roots)
    root.reply('one more question?')
    await waitForNode(service, run.id, 'a1', 'conversing')

    await service.concludeConversation(harness.parent, run.id)
    expect(root.prompts).toHaveLength(3)
    expect(root.prompts[1]).toContain('go')
    expect(root.prompts[2]).toContain('The user ended the clarification')
    /* The request is consumed, so a repeat reports no open conversation. */
    await expect(service.concludeConversation(harness.parent, run.id))
      .rejects.toMatchObject({ code: 'agent-flow/not-conversing' })

    root.reply('design written\nResult: done')
    const settled = await waitForSettled(service, run.id, 'completed')
    expect(settled.nodeRuns.findLast(entry => entry.nodeId === 'a1')).toMatchObject({ status: 'succeeded', result: 'done' })
  })

  it('cancels the live conversation when the run is cancelled', async () => {
    const harness = await setup()
    const { service, roots } = harness
    const flow = await seed(service, templateId => ({
      nodes: [start(), agent('a1', templateId, 'clarify', { interactive: true }), agent('a2', templateId, 'build'), end()],
      edges: [{ kind: 'execution', from: 'start', to: 'a1' }, { kind: 'execution', from: 'a1', to: 'a2' }, { kind: 'execution', from: 'a2', to: 'end' }],
    }))

    const run = await startRun(harness, flow, 'go')
    const root = await waitForRoot(roots)
    root.reply('still clarifying')
    await waitForNode(service, run.id, 'a1', 'conversing')

    await service.cancel(harness.parent, run.id)
    const settled = await waitForSettled(service, run.id, 'cancelled')
    expect(root.cancels).toEqual([{ kind: 'user' }])
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'a1')).toMatchObject({ status: 'failed', error: 'run cancelled' })
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'a2')).toMatchObject({ status: 'skipped' })
  })

  it('commits run cancellation only after the interactive agent reaches quiescence', async () => {
    const harness = await setup()
    const { service, roots } = harness
    const idle = deferred()
    roots.idleGate = idle.promise
    const flow = await seed(service, templateId => ({
      nodes: [start(), agent('a1', templateId, 'clarify', { interactive: true }), end()],
      edges: [{ kind: 'execution', from: 'start', to: 'a1' }, { kind: 'execution', from: 'a1', to: 'end' }],
    }))

    const run = await startRun(harness, flow, 'go')
    const root = await waitForRoot(roots)
    root.reply('still clarifying')
    await waitForNode(service, run.id, 'a1', 'conversing')

    await service.cancel(harness.parent, run.id)
    expect(root.cancels).toEqual([{ kind: 'user' }])
    expect((await service.readRun(run.id)).status).toBe('running')

    idle.resolve()
    const settled = await waitForSettled(service, run.id, 'cancelled')
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'a1')).toMatchObject({ status: 'failed', error: 'run cancelled' })
  })

  it('re-executes loop nodes with incrementing iterations until a Result routes out', async () => {
    const harness = await setup({
      scripts: {
        eng: [{ text: 'draft one' }, { text: 'draft two' }],
        rev: [{ text: 'please revise\nResult: rejected' }, { text: 'looks good\nResult: approved' }],
      },
    })
    const { service, stub, workspace } = harness
    const flow = await seed(service, templateId => ({
      nodes: [start(), agent('eng', templateId, 'draft the answer'), agent('rev', templateId, 'review the draft'), condition('verdict'), end()],
      edges: [
        { kind: 'execution', from: 'start', to: 'eng' },
        { kind: 'execution', from: 'eng', to: 'rev' },
        { kind: 'execution', from: 'rev', to: 'verdict' },
        { kind: 'execution', from: 'verdict', to: 'eng', result: 'rejected' },
        { kind: 'execution', from: 'verdict', to: 'end', result: 'approved' },
      ],
    }))

    const run = await startRun(harness, flow, 'write a letter')
    const settled = await waitForSettled(service, run.id, 'completed')

    expect(stub.requests.map(request => request.label)).toEqual(['eng', 'rev', 'eng', 'rev'])
    expect(stub.maxConcurrent).toBe(1)
    const engEntries = settled.nodeRuns.filter(entry => entry.nodeId === 'eng')
    expect(engEntries.map(entry => entry.iteration)).toEqual([0, 1])
    expect(engEntries.map(entry => entry.handoff)).toEqual(['draft one', 'draft two'])
    expect(engEntries.map(entry => entry.dir)).toEqual([
      join(workspace, '.dsh', 'flows', String(run.id), '00-eng'),
      join(workspace, '.dsh', 'flows', String(run.id), '01-eng'),
    ])
    const revEntries = settled.nodeRuns.filter(entry => entry.nodeId === 'rev')
    expect(revEntries.map(entry => [entry.iteration, entry.result])).toEqual([[0, 'rejected'], [1, 'approved']])
    const verdicts = settled.nodeRuns.filter(entry => entry.nodeId === 'verdict')
    expect(verdicts.map(entry => [entry.iteration, entry.result])).toEqual([[0, 'rejected'], [1, 'approved']])
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'end')).toMatchObject({ status: 'succeeded' })

    // The condition node forwards the reviewer's handoff, so the loop head
    // still reads the verdict that sent it back.
    const secondEng = stub.requests[2]
    expect(promptText(secondEng!)).toContain('## Handoff from rev\nplease revise\nResult: rejected\n\nFiles:\nNo files.')
  })

  it('re-executes a twice-rejected loop and settles on the third approval', async () => {
    const harness = await setup({
      scripts: {
        eng: [{ text: 'draft one' }, { text: 'draft two' }, { text: 'draft three' }],
        rev: [
          { text: 'revise once\nResult: rejected' },
          { text: 'revise twice\nResult: rejected' },
          { text: 'accept\nResult: approved' },
        ],
      },
    })
    const { service, stub, workspace } = harness
    const flow = await seed(service, templateId => ({
      nodes: [start(), agent('eng', templateId, 'draft the answer'), agent('rev', templateId, 'review the draft'), condition('verdict'), end()],
      edges: [
        { kind: 'execution', from: 'start', to: 'eng' },
        { kind: 'execution', from: 'eng', to: 'rev' },
        { kind: 'execution', from: 'rev', to: 'verdict' },
        { kind: 'execution', from: 'verdict', to: 'eng', result: 'rejected' },
        { kind: 'execution', from: 'verdict', to: 'end', result: 'approved' },
      ],
    }))

    const run = await startRun(harness, flow, 'write a letter')
    const settled = await waitForSettled(service, run.id, 'completed')

    // Three writer/reviewer rounds: rejected, rejected, approved.
    expect(stub.requests.map(request => request.label)).toEqual(['eng', 'rev', 'eng', 'rev', 'eng', 'rev'])
    expect(stub.requests).toHaveLength(6)
    const engEntries = settled.nodeRuns.filter(entry => entry.nodeId === 'eng')
    expect(engEntries.map(entry => [entry.iteration, entry.handoff])).toEqual([
      [0, 'draft one'],
      [1, 'draft two'],
      [2, 'draft three'],
    ])
    expect(engEntries.map(entry => entry.dir)).toEqual([
      join(workspace, '.dsh', 'flows', String(run.id), '00-eng'),
      join(workspace, '.dsh', 'flows', String(run.id), '01-eng'),
      join(workspace, '.dsh', 'flows', String(run.id), '02-eng'),
    ])
    expect(settled.nodeRuns.filter(entry => entry.nodeId === 'rev').map(entry => [entry.iteration, entry.result]))
      .toEqual([[0, 'rejected'], [1, 'rejected'], [2, 'approved']])
    // The third writer reads the latest rejection, and the third reviewer reads
    // the writer's third draft.
    expect(promptText(stub.requests[4]!)).toContain('## Handoff from rev\nrevise twice\nResult: rejected')
    expect(promptText(stub.requests[5]!)).toContain('## Handoff from eng\ndraft three')
    expect(settled.nodeRuns.filter(entry => entry.nodeId === 'end'))
      .toMatchObject([{ iteration: 0, status: 'succeeded' }])
  })

  it('runs two serial review blocks in sequence', async () => {
    const harness = await setup({ scripts: {
      a: [{ text: 'draft one' }, { text: 'draft two' }],
      b: [{ text: 'retry a\nResult: retry' }, { text: 'a done\nResult: next' }],
      c: [{ text: 'impl one' }, { text: 'impl two' }],
      d: [{ text: 'retry c\nResult: retry' }, { text: 'c done\nResult: next' }],
    } })
    const flow = await seed(harness.service, templateId => ({
      nodes: [
        start(),
        agent('a', templateId, 'first block work'),
        agent('b', templateId, 'first block review'),
        condition('v1'),
        agent('c', templateId, 'second block work'),
        agent('d', templateId, 'second block review'),
        condition('v2'),
        end(),
      ],
      edges: [
        { kind: 'execution', from: 'start', to: 'a' },
        { kind: 'execution', from: 'a', to: 'b' },
        { kind: 'execution', from: 'b', to: 'v1' },
        { kind: 'execution', from: 'v1', to: 'a', result: 'retry' },
        { kind: 'execution', from: 'v1', to: 'c', result: 'next' },
        { kind: 'execution', from: 'c', to: 'd' },
        { kind: 'execution', from: 'd', to: 'v2' },
        { kind: 'execution', from: 'v2', to: 'c', result: 'retry' },
        { kind: 'execution', from: 'v2', to: 'end', result: 'next' },
      ],
    }))

    const run = await startRun(harness, flow)
    const settled = await waitForSettled(harness.service, run.id, 'completed')

    expect(harness.stub.requests.map(request => request.label)).toEqual(['a', 'b', 'a', 'b', 'c', 'd', 'c', 'd'])
    expect(settled.nodeRuns.filter(entry => entry.nodeId === 'a').map(entry => entry.iteration)).toEqual([0, 1])
    expect(settled.nodeRuns.filter(entry => entry.nodeId === 'c').map(entry => entry.iteration)).toEqual([0, 1])
    const cEntries = harness.stub.requests.filter(request => request.label === 'c')
    expect(promptText(cEntries[0]!)).toContain('## Handoff from b\na done\nResult: next')
    expect(promptText(cEntries[0]!)).not.toContain('## Handoff from a')
    expect(promptText(cEntries[1]!)).toContain('## Handoff from d\nretry c\nResult: retry')
  })

  it('stops a runaway loop at the document iteration cap', async () => {
    const harness = await setup({ scripts: { eng: { text: 'draft' }, rev: { text: 'again\nResult: rejected' } } })
    const { service, stub } = harness
    const flow = await seed(service, templateId => ({
      maxIterations: 2,
      nodes: [start(), agent('eng', templateId, 'draft'), agent('rev', templateId, 'review'), condition('verdict'), end()],
      edges: [
        { kind: 'execution', from: 'start', to: 'eng' },
        { kind: 'execution', from: 'eng', to: 'rev' },
        { kind: 'execution', from: 'rev', to: 'verdict' },
        { kind: 'execution', from: 'verdict', to: 'eng', result: 'rejected' },
        { kind: 'execution', from: 'verdict', to: 'end', result: 'approved' },
      ],
    }))

    const run = await startRun(harness, flow, 'go')
    const settled = await waitForSettled(service, run.id, 'failed')

    expect(settled.error).toBe('run reached its iteration cap (2) — raise maxIterations if the loop is intentionally this long')
    expect(stub.requests.map(request => request.label)).toEqual(['eng', 'rev'])
    expect(settled.nodeRuns.filter(entry => entry.nodeId === 'eng')).toHaveLength(1)
    for (const id of ['eng', 'rev', 'verdict']) {
      expect(settled.nodeRuns.filter(entry => entry.nodeId === id)).toEqual([
        expect.objectContaining({ iteration: 0, status: 'succeeded' }),
      ])
    }
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'end')).toMatchObject({ status: 'skipped' })
  })

  it('keeps earlier loop records when the next iteration cannot be appended', async () => {
    const harness = await setup({ runtime: false, scripts: {
      eng: [{ text: 'draft one' }],
      rev: [{ text: 'again\nResult: retry' }],
    } })
    const executor = new GraphExecutor(harness.ctx, {
      executor: 'graph',
      provider: 'stub',
      maxConcurrentAgents: 4,
      maxConversationTurns: 16,
    })
    harness.ctx.agentFlows.registerExecutor({
      name: 'graph',
      cancel: (id) => { executor.cancel(id) },
      concludeConversation: id => executor.concludeConversation(id),
      async execute(controller) {
        return await executor.execute({
          ...controller,
          startNodeIteration: async (nodeId) => {
            if (nodeId === 'eng') throw new Error('injected iteration append failure for eng')
            return await controller.startNodeIteration(nodeId)
          },
        })
      },
    })
    const flow = await seed(harness.service, templateId => ({
      maxIterations: 4,
      nodes: [start(), agent('eng', templateId, 'draft'), agent('rev', templateId, 'review'), condition('verdict'), end()],
      edges: [
        { kind: 'execution', from: 'start', to: 'eng' },
        { kind: 'execution', from: 'eng', to: 'rev' },
        { kind: 'execution', from: 'rev', to: 'verdict' },
        { kind: 'execution', from: 'verdict', to: 'eng', result: 'retry' },
        { kind: 'execution', from: 'verdict', to: 'end', result: 'done' },
      ],
    }))

    const run = await startRun(harness, flow)
    const settled = await waitForSettled(harness.service, run.id, 'failed')
    expect(settled.error).toBe('node "eng" could not start iteration 1: injected iteration append failure for eng')
    expect(settled.nodeRuns.filter(entry => entry.nodeId === 'eng')).toEqual([
      expect.objectContaining({ iteration: 0, status: 'succeeded', handoff: 'draft one' }),
    ])
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'rev')).toMatchObject({ status: 'succeeded' })
  })

  it('closes unselected nodes even when their skip write failed once', async () => {
    let rejected = false
    const storedRun = (value: unknown): { status?: string; nodeRuns?: readonly { nodeId: string; status: string }[] } | undefined =>
      typeof value === 'object' && value !== null ? value : undefined
    const harness = await setup({
      scripts: { choose: { text: 'direct\nResult: direct' }, left: { text: 'left' }, right: { text: 'right' } },
      beforeWrite: async (table, _key, value) => {
        const run = table === 'runs' ? storedRun(value) : undefined
        if (!rejected && run?.status === 'running' && run.nodeRuns?.some(node => node.nodeId === 'right' && node.status === 'skipped')) {
          rejected = true
          throw new Error('skip write unavailable')
        }
      },
    })
    const flow = await seed(harness.service, templateId => ({
      nodes: [start(), agent('choose', templateId, 'choose'), condition('route'), agent('left', templateId, 'left'), agent('right', templateId, 'right'), end()],
      edges: [
        { kind: 'execution', from: 'start', to: 'choose' },
        { kind: 'execution', from: 'choose', to: 'route' },
        { kind: 'execution', from: 'route', to: 'left', result: 'direct' },
        { kind: 'execution', from: 'route', to: 'right', result: 'other' },
        { kind: 'execution', from: 'left', to: 'end' },
        { kind: 'execution', from: 'right', to: 'end' },
      ],
    }))

    const run = await startRun(harness, flow)
    const settled = await waitForSettled(harness.service, run.id, 'completed')
    expect(rejected).toBe(true)
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'right')).toMatchObject({ status: 'skipped' })
    expect(settled.nodeRuns.every(entry => !['pending', 'running', 'conversing'].includes(entry.status))).toBe(true)
  })

  it('injects the original request into the entry node only', async () => {
    const harness = await setup({ scripts: { a1: { text: 'design' }, a2: { text: 'implementation' }, review: { text: 'approved' } } })
    const flow = await seed(harness.service, templateId => ({
      nodes: [start(), agent('a1', templateId, 'design'), agent('a2', templateId, 'implement'), agent('review', templateId, 'review'), end()],
      edges: [
        { kind: 'execution', from: 'start', to: 'a1' },
        { kind: 'execution', from: 'a1', to: 'a2' },
        { kind: 'execution', from: 'a2', to: 'review' },
        { kind: 'execution', from: 'review', to: 'end' },
      ],
    }))
    const run = await startRun(harness, flow, 'raw request must stay private')
    const settled = await waitForSettled(harness.service, run.id, 'completed')
    // The Start successor reads the run request by default; later nodes do not.
    expect(promptText(harness.stub.requests[0]!)).toContain('## User request\nraw request must stay private')
    for (const request of harness.stub.requests.slice(1)) expect(promptText(request)).not.toContain('## User request')
    const review = promptText(harness.stub.requests[2]!)
    expect(review).toContain('## Handoff from a2\nimplementation')
    expect(review).not.toContain('## Handoff from a1')
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'a1')?.userInput).toBe(true)
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'review')?.inputs).toEqual([{ nodeId: 'a2', iteration: 0 }])
  })

  it('reads an explicitly connected request without letting the input line schedule work', async () => {
    const gate = deferred()
    const harness = await setup({ scripts: { a1: { gate: gate.promise, text: 'first' }, a2: { text: 'final' } } })
    const flow = await seed(harness.service, templateId => ({
      nodes: [start(), agent('a1', templateId, 'prepare'), agent('a2', templateId, 'finish up'), end()],
      edges: [
        { kind: 'execution', from: 'start', to: 'a1' },
        { kind: 'input', from: 'start', to: 'a2' },
        { kind: 'execution', from: 'a1', to: 'a2' },
        { kind: 'execution', from: 'a2', to: 'end' },
      ],
    }))
    const run = await startRun(harness, flow, 'go')
    await vi.waitFor(() => { expect(harness.stub.requests.map(request => request.label)).toEqual(['a1']) })
    expect((await harness.service.readRun(run.id)).nodeRuns.find(entry => entry.nodeId === 'a2')?.status).toBe('pending')
    gate.resolve()
    const settled = await waitForSettled(harness.service, run.id, 'completed')
    expect(promptText(harness.stub.requests[1]!)).toContain('## User request\ngo')
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'a2')?.userInput).toBe(true)
  })

  it('hands the selected branch through an all join and keeps an explicit extra input', async () => {
    const harness = await setup({ scripts: {
      a: { text: 'A_RESULT\nResult: indirect' },
      b: { text: 'B_RESULT' },
      target: { text: 'TARGET_RESULT' },
    } })
    const flow = await seed(harness.service, templateId => ({
      nodes: [start(), agent('a', templateId, 'a'), condition('choice'), agent('b', templateId, 'b'), joinNode('j', 'all'), agent('target', templateId, 'target'), end()],
      edges: [
        { kind: 'execution', from: 'start', to: 'a' },
        { kind: 'execution', from: 'a', to: 'choice' },
        { kind: 'execution', from: 'choice', to: 'j', result: 'direct' },
        { kind: 'execution', from: 'choice', to: 'b', result: 'indirect' },
        { kind: 'execution', from: 'b', to: 'j' },
        { kind: 'execution', from: 'j', to: 'target' },
        { kind: 'execution', from: 'target', to: 'end' },
        { kind: 'input', from: 'a', to: 'target' },
      ],
    }))
    const run = await startRun(harness, flow)
    const settled = await waitForSettled(harness.service, run.id, 'completed')
    const target = harness.stub.requests.find(request => request.label === 'target')
    if (target === undefined) throw new Error('target did not run')
    expect(promptText(target)).toContain('## Handoff from b\nB_RESULT')
    expect(promptText(target)).toContain('## Handoff from a\nA_RESULT')
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'target')?.inputs).toEqual([
      { nodeId: 'b', iteration: 0 },
      { nodeId: 'a', iteration: 0 },
    ])
  })

  it('fails a target before model work when its stored input source never ran', async () => {
    const harness = await setup({ runtime: false, scripts: {
      a: { text: 'left branch\nResult: left' },
      b: { text: 'left result' },
    } })
    const template = await harness.service.saveTemplate({ name: 'Worker' })
    const snapshot: FlowDocument = {
      id: FlowId('stored'),
      name: 'stored snapshot',
      maxIterations: 16,
      nodes: [
        start(),
        agent('a', template.id, 'choose'),
        condition('choice'),
        agent('b', template.id, 'left work'),
        agent('c', template.id, 'right work'),
        agent('target', template.id, 'target'),
        end(),
      ],
      edges: [
        { kind: 'execution', from: 'start', to: 'a' },
        { kind: 'execution', from: 'a', to: 'choice' },
        { kind: 'execution', from: 'choice', to: 'b', result: 'left' },
        { kind: 'execution', from: 'choice', to: 'c', result: 'right' },
        { kind: 'execution', from: 'b', to: 'target' },
        { kind: 'execution', from: 'c', to: 'target' },
        { kind: 'execution', from: 'target', to: 'end' },
        { kind: 'input', from: 'c', to: 'target' },
      ],
      createdAt: 'a',
      updatedAt: 'a',
    }
    let stored: FlowRun = {
      id: FlowRunId('run'),
      flowId: snapshot.id,
      snapshot,
      parentSessionId: harness.parent.session.id,
      status: 'running',
      input: 'go',
      nodeRuns: snapshot.nodes.map(node => ({ nodeId: node.id, iteration: 0, status: 'pending' as const })),
      startedAt: 'a',
    }
    const executor = new GraphExecutor(harness.ctx, {
      executor: 'graph',
      provider: 'stub',
      maxConcurrentAgents: 4,
      maxConversationTurns: 16,
    })
    const result = await executor.execute({
      run: stored,
      parent: harness.parent,
      signal: new AbortController().signal,
      updateNodeRun: async (nodeId, patch) => {
        const latest = stored.nodeRuns.findLastIndex(entry => entry.nodeId === nodeId)
        stored = {
          ...stored,
          nodeRuns: stored.nodeRuns.map((entry, index) => index === latest
            ? { ...entry, ...patch, status: patch.status ?? entry.status }
            : entry),
        }
        return stored
      },
      startNodeIteration: async () => { throw new Error('this snapshot is acyclic') },
    })

    expect(result.stopReason).toBe('failed')
    if (result.stopReason !== 'failed') throw new Error('expected the stored snapshot to fail')
    expect(result.error).toContain('required input "c" is unavailable for node "target"')
    expect(harness.stub.requests.map(request => request.label)).toEqual(['a', 'b'])
    expect(stored.nodeRuns.find(entry => entry.nodeId === 'target')).toMatchObject({ status: 'failed' })
  })

  it('waits for all direct execution predecessors and consumes their results once', async () => {
    const gate = deferred()
    const harness = await setup({ scripts: { fast: { text: 'first' }, slow: { gate: gate.promise, text: 'second' }, merge: { text: 'merged' } } })
    const flow = await seed(harness.service, templateId => ({
      nodes: [start(), agent('fast', templateId, 'fast'), agent('slow', templateId, 'slow'), agent('merge', templateId, 'merge'), end()],
      edges: [
        { kind: 'execution', from: 'start', to: 'fast' },
        { kind: 'execution', from: 'start', to: 'slow' },
        { kind: 'execution', from: 'fast', to: 'merge' },
        { kind: 'execution', from: 'slow', to: 'merge' },
        { kind: 'execution', from: 'merge', to: 'end' },
      ],
    }))
    const run = await startRun(harness, flow)
    await waitForNode(harness.service, run.id, 'fast', 'succeeded')
    expect(harness.stub.requests.filter(request => request.label === 'merge')).toHaveLength(0)
    gate.resolve()
    const settled = await waitForSettled(harness.service, run.id, 'completed')
    const merges = harness.stub.requests.filter(request => request.label === 'merge')
    expect(merges).toHaveLength(1)
    expect(promptText(merges[0]!)).toContain('## Handoff from fast\nfirst')
    expect(promptText(merges[0]!)).toContain('## Handoff from slow\nsecond')
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'merge')?.inputs).toEqual([{ nodeId: 'fast', iteration: 0 }, { nodeId: 'slow', iteration: 0 }])
  })

  // E15: the deliverable "meeting" graph is an expanded DAG, not a loop.
  // Three roles hand off to summary 1, the second round reads that summary,
  // and summary 2 waits for all three second-round results and starts once.
  it('expands a fixed second round after summary 1 and joins both rounds once', async () => {
    const product = deferred()
    const engineer = deferred()
    const qa = deferred()
    const summary1 = deferred()
    const product2 = deferred()
    const engineer2 = deferred()
    const qa2 = deferred()
    const harness = await setup({ scripts: {
      product: { gate: product.promise, text: 'product round 1' },
      engineer: { gate: engineer.promise, text: 'engineer round 1' },
      qa: { gate: qa.promise, text: 'qa round 1' },
      summary1: { gate: summary1.promise, text: 'summary round 1' },
      product2: { gate: product2.promise, text: 'product round 2' },
      engineer2: { gate: engineer2.promise, text: 'engineer round 2' },
      qa2: { gate: qa2.promise, text: 'qa round 2' },
      summary2: { text: 'summary round 2' },
    } })
    const flow = await seed(harness.service, templateId => ({
      maxIterations: 32,
      nodes: [
        start(),
        agent('product', templateId, 'product'),
        agent('engineer', templateId, 'engineer'),
        agent('qa', templateId, 'qa'),
        agent('summary1', templateId, 'summary1'),
        agent('product2', templateId, 'product2'),
        agent('engineer2', templateId, 'engineer2'),
        agent('qa2', templateId, 'qa2'),
        agent('summary2', templateId, 'summary2'),
        end(),
      ],
      edges: [
        { kind: 'execution', from: 'start', to: 'product' },
        { kind: 'execution', from: 'start', to: 'engineer' },
        { kind: 'execution', from: 'start', to: 'qa' },
        { kind: 'execution', from: 'product', to: 'summary1' },
        { kind: 'execution', from: 'engineer', to: 'summary1' },
        { kind: 'execution', from: 'qa', to: 'summary1' },
        { kind: 'execution', from: 'summary1', to: 'product2' },
        { kind: 'execution', from: 'summary1', to: 'engineer2' },
        { kind: 'execution', from: 'summary1', to: 'qa2' },
        { kind: 'execution', from: 'product2', to: 'summary2' },
        { kind: 'execution', from: 'engineer2', to: 'summary2' },
        { kind: 'execution', from: 'qa2', to: 'summary2' },
        { kind: 'execution', from: 'summary2', to: 'end' },
      ],
    }))
    const run = await startRun(harness, flow)
    const labels = (): string[] => harness.stub.requests.map(request => request.label ?? '')
    const count = (label: string): number => harness.stub.requests.filter(request => request.label === label).length
    const requestFor = (label: string) => harness.stub.requests.find(request => request.label === label)!

    // Every round-1 role starts before any of them completes. With two roles
    // already recorded as succeeded and the third still blocked, the join
    // issues no summary request; releasing the last role starts it exactly once.
    await vi.waitFor(() => { expect(labels()).toHaveLength(3) })
    expect(labels().sort()).toEqual(['engineer', 'product', 'qa'])
    product.resolve()
    engineer.resolve()
    await waitForNode(harness.service, run.id, 'product', 'succeeded')
    await waitForNode(harness.service, run.id, 'engineer', 'succeeded')
    expect(count('summary1')).toBe(0)
    expect(labels()).toHaveLength(3)
    qa.resolve()
    await vi.waitFor(() => { expect(count('summary1')).toBe(1) })
    expect(promptText(requestFor('summary1'))).toContain('## Handoff from product\nproduct round 1')
    expect(promptText(requestFor('summary1'))).toContain('## Handoff from engineer\nengineer round 1')
    expect(promptText(requestFor('summary1'))).toContain('## Handoff from qa\nqa round 1')

    // The second round is gated on summary 1, and every role reads it.
    expect(count('product2')).toBe(0)
    summary1.resolve()
    await vi.waitFor(() => { expect(labels()).toHaveLength(7) })
    for (const label of ['product2', 'engineer2', 'qa2']) {
      expect(promptText(requestFor(label))).toContain('## Handoff from summary1\nsummary round 1')
    }

    // Summary 2 starts once, after all three second-round roles settle.
    product2.resolve()
    engineer2.resolve()
    await waitForNode(harness.service, run.id, 'product2', 'succeeded')
    await waitForNode(harness.service, run.id, 'engineer2', 'succeeded')
    expect(count('summary2')).toBe(0)
    qa2.resolve()
    const settled = await waitForSettled(harness.service, run.id, 'completed')
    expect(count('summary2')).toBe(1)
    expect(count('summary1')).toBe(1)
    const secondSummary = promptText(requestFor('summary2'))
    expect(secondSummary).toContain('## Handoff from product2\nproduct round 2')
    expect(secondSummary).toContain('## Handoff from engineer2\nengineer round 2')
    expect(secondSummary).toContain('## Handoff from qa2\nqa round 2')
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'summary2')?.inputs).toEqual([
      { nodeId: 'product2', iteration: 0 },
      { nodeId: 'engineer2', iteration: 0 },
      { nodeId: 'qa2', iteration: 0 },
    ])
  })

  it('lets a join in all mode settle once its only live path arrives', async () => {
    const harness = await setup({
      scripts: { a1: { text: 'picked\nResult: left' }, left: { text: 'left' }, right: { text: 'right' } },
    })
    const { service, stub } = harness
    const flow = await seed(service, templateId => ({
      nodes: [start(), agent('a1', templateId, 'classify'), condition('c'), agent('left', templateId, 'left'), agent('right', templateId, 'right'), joinNode('j', 'all'), end()],
      edges: [
        { kind: 'execution', from: 'start', to: 'a1' },
        { kind: 'execution', from: 'a1', to: 'c' },
        { kind: 'execution', from: 'c', to: 'left', result: 'left' },
        { kind: 'execution', from: 'c', to: 'right', result: 'right' },
        { kind: 'execution', from: 'left', to: 'j' },
        { kind: 'execution', from: 'right', to: 'j' },
        { kind: 'execution', from: 'j', to: 'end' },
      ],
    }))

    const run = await startRun(harness, flow, 'go')
    const settled = await waitForSettled(service, run.id, 'completed')

    expect(settled.nodeRuns.find(entry => entry.nodeId === 'j')).toMatchObject({ status: 'succeeded' })
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'right')).toMatchObject({ status: 'skipped' })
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'left')).toMatchObject({ status: 'succeeded', handoff: 'left' })
    expect(stub.requests.map(request => request.label)).toEqual(['a1', 'left'])
  })

  it('passes all branch results through an explicit join', async () => {
    const harness = await setup({ scripts: { left: { text: 'left output' }, right: { text: 'right output' }, merge: { text: 'merged' } } })
    const flow = await seed(harness.service, templateId => ({
      nodes: [start(), agent('left', templateId, 'left'), agent('right', templateId, 'right'), joinNode('j', 'all'), agent('merge', templateId, 'merge'), end()],
      edges: [
        { kind: 'execution', from: 'start', to: 'left' },
        { kind: 'execution', from: 'start', to: 'right' },
        { kind: 'execution', from: 'left', to: 'j' },
        { kind: 'execution', from: 'right', to: 'j' },
        { kind: 'execution', from: 'j', to: 'merge' },
        { kind: 'execution', from: 'merge', to: 'end' },
      ],
    }))
    const run = await startRun(harness, flow)
    await waitForSettled(harness.service, run.id, 'completed')
    const prompt = promptText(harness.stub.requests.find(request => request.label === 'merge')!)
    expect(prompt).toContain('## Handoff from left\nleft output')
    expect(prompt).toContain('## Handoff from right\nright output')
  })

  it('reuses the external design while each review reads the current implementation', async () => {
    const harness = await setup({ scripts: {
      design: { text: 'stable design' },
      eng: [{ text: 'implementation one' }, { text: 'implementation two' }],
      review: [{ text: 'repair this\nResult: retry' }, { text: 'approved\nResult: done' }],
    } })
    const flow = await seed(harness.service, templateId => ({
      nodes: [start(), agent('design', templateId, 'design'), agent('eng', templateId, 'implement'), agent('review', templateId, 'review'), condition('route'), end()],
      edges: [
        { kind: 'execution', from: 'start', to: 'design' },
        { kind: 'execution', from: 'design', to: 'eng' },
        { kind: 'execution', from: 'eng', to: 'review' },
        { kind: 'input', from: 'design', to: 'review' },
        { kind: 'execution', from: 'review', to: 'route' },
        { kind: 'execution', from: 'route', to: 'eng', result: 'retry' },
        { kind: 'execution', from: 'route', to: 'end', result: 'done' },
      ],
    }))
    const run = await startRun(harness, flow)
    const settled = await waitForSettled(harness.service, run.id, 'completed')
    expect(harness.stub.requests.map(request => request.label)).toEqual(['design', 'eng', 'review', 'eng', 'review'])
    const retry = promptText(harness.stub.requests[3]!)
    expect(retry).toContain('## Handoff from design\nstable design')
    expect(retry).toContain('## Handoff from review\nrepair this')
    const secondReview = promptText(harness.stub.requests[4]!)
    expect(secondReview).toContain('## Handoff from eng\nimplementation two')
    expect(secondReview).not.toContain('implementation one')
    expect(secondReview).toContain('## Handoff from design\nstable design')
    expect(settled.nodeRuns.filter(entry => entry.nodeId === 'review').map(entry => entry.inputs)).toEqual([
      [{ nodeId: 'eng', iteration: 0 }, { nodeId: 'design', iteration: 0 }],
      [{ nodeId: 'eng', iteration: 1 }, { nodeId: 'design', iteration: 0 }],
    ])
  })

  it('holds an external all until a concurrent loop branch settles', async () => {
    const gate = deferred()
    const harness = await setup({ scripts: {
      eng: [{ text: 'draft one' }, { gate: gate.promise, text: 'draft two' }],
      rev: [{ text: 'repair this\nResult: retry' }, { text: 'approved\nResult: done' }],
      side: { text: 'side result' },
      merge: { text: 'merged' },
    } })
    const flow = await seed(harness.service, templateId => ({
      nodes: [start(), agent('eng', templateId, 'implement'), agent('rev', templateId, 'review'), condition('route'), agent('side', templateId, 'side work'), agent('merge', templateId, 'merge'), end()],
      edges: [
        { kind: 'execution', from: 'start', to: 'eng' },
        { kind: 'execution', from: 'start', to: 'side' },
        { kind: 'execution', from: 'eng', to: 'rev' },
        { kind: 'execution', from: 'rev', to: 'route' },
        { kind: 'execution', from: 'route', to: 'eng', result: 'retry' },
        { kind: 'execution', from: 'route', to: 'merge', result: 'done' },
        { kind: 'execution', from: 'side', to: 'merge' },
        { kind: 'execution', from: 'merge', to: 'end' },
      ],
    }))

    const run = await startRun(harness, flow)
    await vi.waitFor(() => { expect(harness.stub.requests.filter(request => request.label === 'eng')).toHaveLength(2) })
    await waitForNode(harness.service, run.id, 'side', 'succeeded')
    expect(harness.stub.requests.filter(request => request.label === 'merge')).toHaveLength(0)

    gate.resolve()
    const settled = await waitForSettled(harness.service, run.id, 'completed')
    const merges = harness.stub.requests.filter(request => request.label === 'merge')
    expect(merges).toHaveLength(1)
    expect(promptText(merges[0]!)).toContain('## Handoff from rev\napproved\nResult: done')
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'merge')?.inputs).toEqual([
      { nodeId: 'rev', iteration: 1 },
      { nodeId: 'side', iteration: 0 },
    ])
  })

  it('preserves earlier loop entries when a later pass exits before its tail', async () => {
    const harness = await setup({ scripts: {
      head: [{ text: 'continue\nResult: proceed' }, { text: 'stop now\nResult: stop' }],
      tail: { text: 'again\nResult: retry' },
      merge: { text: 'merged' },
    } })
    const flow = await seed(harness.service, templateId => ({
      nodes: [start(), agent('head', templateId, 'head'), condition('early'), agent('tail', templateId, 'tail'), condition('last'), agent('merge', templateId, 'merge'), end()],
      edges: [
        { kind: 'execution', from: 'start', to: 'head' },
        { kind: 'execution', from: 'head', to: 'early' },
        { kind: 'execution', from: 'early', to: 'tail', result: 'proceed' },
        { kind: 'execution', from: 'early', to: 'merge', result: 'stop' },
        { kind: 'execution', from: 'tail', to: 'last' },
        { kind: 'execution', from: 'last', to: 'head', result: 'retry' },
        { kind: 'execution', from: 'last', to: 'merge', result: 'done' },
        { kind: 'execution', from: 'merge', to: 'end' },
      ],
    }))

    const run = await startRun(harness, flow)
    const settled = await waitForSettled(harness.service, run.id, 'completed')

    expect(harness.stub.requests.map(request => request.label)).toEqual(['head', 'tail', 'head', 'merge'])
    expect(settled.nodeRuns.filter(entry => entry.nodeId === 'tail')).toEqual([
      expect.objectContaining({ iteration: 0, status: 'succeeded', handoff: 'again\nResult: retry' }),
    ])
    expect(settled.nodeRuns.filter(entry => entry.nodeId === 'last')).toEqual([
      expect.objectContaining({ iteration: 0, status: 'succeeded', result: 'retry' }),
    ])
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'merge')).toMatchObject({ status: 'succeeded' })
  })

  it('skips a whole unselected loop without blocking its external all', async () => {
    const harness = await setup({ scripts: {
      choose: { text: 'bypass\nResult: bypass' },
      head: { text: 'head' },
      review: { text: 'approved\nResult: done' },
      side: { text: 'side' },
      merge: { text: 'merged' },
    } })
    const flow = await seed(harness.service, templateId => ({
      nodes: [start(), agent('choose', templateId, 'choose'), condition('outer'), agent('head', templateId, 'head'), agent('review', templateId, 'review'), condition('route'), agent('side', templateId, 'side'), agent('merge', templateId, 'merge'), end()],
      edges: [
        { kind: 'execution', from: 'start', to: 'choose' },
        { kind: 'execution', from: 'choose', to: 'outer' },
        { kind: 'execution', from: 'outer', to: 'head', result: 'loop' },
        { kind: 'execution', from: 'outer', to: 'side', result: 'bypass' },
        { kind: 'execution', from: 'head', to: 'review' },
        { kind: 'execution', from: 'review', to: 'route' },
        { kind: 'execution', from: 'route', to: 'head', result: 'retry' },
        { kind: 'execution', from: 'route', to: 'merge', result: 'done' },
        { kind: 'execution', from: 'side', to: 'merge' },
        { kind: 'execution', from: 'merge', to: 'end' },
      ],
    }))

    const run = await startRun(harness, flow)
    const settled = await waitForSettled(harness.service, run.id, 'completed')

    expect(harness.stub.requests.map(request => request.label)).toEqual(['choose', 'side', 'merge'])
    expect(settled.nodeRuns.filter(entry => ['head', 'review', 'route'].includes(entry.nodeId)).map(entry => entry.status))
      .toEqual(['skipped', 'skipped', 'skipped'])
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'merge')?.inputs).toEqual([{ nodeId: 'side', iteration: 0 }])
  })

  it('fails the run on a node failure, aborts its siblings, and skips what never ran', async () => {
    const gate = deferred()
    const failGate = deferred()
    const harness = await setup({
      scripts: { failing: { gate: failGate.promise, stopReason: 'refusal', diagnostic: 'declined the task' }, sibling: { gate: gate.promise, text: 'never' } },
    })
    const { service, stub } = harness
    const flow = await seed(service, templateId => ({
      nodes: [start(), agent('a1', templateId, 'go'), agent('failing', templateId, 'fail'), agent('sibling', templateId, 'sibling'), agent('later', templateId, 'later'), end()],
      edges: [
        { kind: 'execution', from: 'start', to: 'a1' },
        { kind: 'execution', from: 'a1', to: 'failing' },
        { kind: 'execution', from: 'a1', to: 'sibling' },
        { kind: 'execution', from: 'failing', to: 'later' },
        { kind: 'execution', from: 'sibling', to: 'end' },
        { kind: 'execution', from: 'later', to: 'end' },
      ],
    }))

    const run = await startRun(harness, flow, 'go')
    // Both branches start before the refusal aborts the sibling.
    await vi.waitFor(() => { expect(stub.requests.map(request => request.label).sort()).toEqual(['a1', 'failing', 'sibling']) }, { timeout: 2000, interval: 10 })
    failGate.resolve()
    const settled = await waitForSettled(service, run.id, 'failed')

    expect(settled.error).toBe('node "failing" failed: declined the task')
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'failing')).toMatchObject({ status: 'failed', error: 'declined the task' })
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'sibling')).toMatchObject({ status: 'failed', error: 'run cancelled' })
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'later')).toMatchObject({ status: 'skipped' })
    expect(stub.requests[0]?.label).toBe('a1')
    expect(stub.requests.slice(1).map(request => request.label).sort()).toEqual(['failing', 'sibling'])
    expect(stub.aborted).toEqual([settled.nodeRuns.find(entry => entry.nodeId === 'sibling')?.agentSessionId])
    expect(stub.disposed[0]).toBe('child-1')
    expect(stub.disposed.slice(1).sort()).toEqual(['child-2', 'child-3'])
  })

  it('fails the node when the provider rejects the start call', async () => {
    const harness = await setup({ scripts: { a1: { rejectStart: 'provider unavailable' } } })
    const { service } = harness
    const flow = await seed(service, templateId => ({
      nodes: [start(), agent('a1', templateId, 'run'), end()],
      edges: [{ kind: 'execution', from: 'start', to: 'a1' }, { kind: 'execution', from: 'a1', to: 'end' }],
    }))

    const run = await startRun(harness, flow, 'go')
    const settled = await waitForSettled(service, run.id, 'failed')
    expect(settled.error).toBe('node "a1" failed: provider unavailable')
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'a1')).toMatchObject({ status: 'failed', error: 'provider unavailable' })
  })

  it('reports a non-Error start rejection through its string form', async () => {
    const harness = await setup({ scripts: { a1: { rejectStartValue: 'plain boom' } } })
    const { service } = harness
    const flow = await seed(service, templateId => ({
      nodes: [start(), agent('a1', templateId, 'run'), end()],
      edges: [{ kind: 'execution', from: 'start', to: 'a1' }, { kind: 'execution', from: 'a1', to: 'end' }],
    }))

    const run = await startRun(harness, flow, 'go')
    const settled = await waitForSettled(service, run.id, 'failed')
    expect(settled.error).toBe('node "a1" failed: plain boom')
  })

  it('fails the run when the parent session has no workspace directory', async () => {
    const harness = await setup({ scripts: { a1: { text: 'ok' } } })
    const { service, stub } = harness
    const homeless = { session: { id: SessionId('parent-session'), header: {} } } as Agent
    const flow = await seed(service, templateId => ({
      nodes: [start(), agent('a1', templateId, 'run'), end()],
      edges: [{ kind: 'execution', from: 'start', to: 'a1' }, { kind: 'execution', from: 'a1', to: 'end' }],
    }))

    const run = await service.start(homeless, { flowId: flow.id, input: 'go', signal: new AbortController().signal })
    const settled = await waitForSettled(service, run.id, 'failed')
    expect(settled.error).toBe('the parent session has no workspace directory')
    expect(stub.requests).toHaveLength(0)
  })

  it('bounds parallel node agents by the configured concurrency', async () => {
    const build = (templateId: AgentTemplateId): { nodes: FlowNode[]; edges: FlowEdge[] } => ({
      nodes: [start(), agent('a1', templateId, 'go'), agent('b1', templateId, 'b1'), agent('b2', templateId, 'b2'), end()],
      edges: [
        { kind: 'execution', from: 'start', to: 'a1' },
        { kind: 'execution', from: 'a1', to: 'b1' },
        { kind: 'execution', from: 'a1', to: 'b2' },
        { kind: 'execution', from: 'b1', to: 'end' },
        { kind: 'execution', from: 'b2', to: 'end' },
      ],
    })

    const serial = await setup({
      scripts: { a1: { text: 'go' }, b1: { delayMs: 20, text: 'b1' }, b2: { delayMs: 20, text: 'b2' } },
      plugin: { maxConcurrentAgents: 1 },
    })
    const serialFlow = await seed(serial.service, build)
    const serialRun = await startRun(serial, serialFlow, 'go')
    await waitForSettled(serial.service, serialRun.id, 'completed')
    expect(serial.stub.maxConcurrent).toBe(1)

    const parallel = await setup({
      scripts: { a1: { text: 'go' }, b1: { delayMs: 20, text: 'b1' }, b2: { delayMs: 20, text: 'b2' } },
      plugin: { maxConcurrentAgents: 2 },
    })
    const parallelFlow = await seed(parallel.service, build)
    const parallelRun = await startRun(parallel, parallelFlow, 'go')
    await waitForSettled(parallel.service, parallelRun.id, 'completed')
    expect(parallel.stub.maxConcurrent).toBe(2)
  })

  it('settles a cancelled run, records the interrupted node, and skips the rest', async () => {
    const gate = deferred()
    const harness = await setup({ scripts: { a1: { gate: gate.promise, text: 'never' } } })
    const { service, stub } = harness
    const flow = await seed(service, templateId => ({
      nodes: [start(), agent('a1', templateId, 'one'), agent('a2', templateId, 'two'), end()],
      edges: [{ kind: 'execution', from: 'start', to: 'a1' }, { kind: 'execution', from: 'a1', to: 'a2' }, { kind: 'execution', from: 'a2', to: 'end' }],
    }))

    const run = await startRun(harness, flow, 'go')
    await vi.waitFor(async () => {
      expect((await service.readRun(run.id)).nodeRuns.find(entry => entry.nodeId === 'a1')?.status).toBe('running')
    }, { timeout: 2000, interval: 10 })

    await service.cancel(harness.parent, run.id)
    const settled = await waitForSettled(service, run.id, 'cancelled')
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'a1')).toMatchObject({ status: 'failed', error: 'run cancelled' })
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'a2')).toMatchObject({ status: 'skipped' })
    expect(stub.aborted).toEqual(['child-1'])
    expect(stub.disposed).toEqual(['child-1'])
  })

  it('stops the run when the caller aborts its request signal', async () => {
    const gate = deferred()
    const abort = new AbortController()
    const harness = await setup({ scripts: { a1: { gate: gate.promise, text: 'never' } } })
    const { service } = harness
    const flow = await seed(service, templateId => ({
      nodes: [start(), agent('a1', templateId, 'one'), end()],
      edges: [{ kind: 'execution', from: 'start', to: 'a1' }, { kind: 'execution', from: 'a1', to: 'end' }],
    }))

    const run = await service.start(harness.parent, { flowId: flow.id, input: 'go', signal: abort.signal })
    await vi.waitFor(async () => {
      expect((await service.readRun(run.id)).nodeRuns.find(entry => entry.nodeId === 'a1')?.status).toBe('running')
    }, { timeout: 2000, interval: 10 })

    abort.abort()
    await waitForSettled(service, run.id, 'cancelled')
  })

  it('cancels a node that is still waiting for a concurrency slot', async () => {
    const gate = deferred()
    const harness = await setup({
      scripts: { a1: { gate: gate.promise, text: 'one' } },
      plugin: { maxConcurrentAgents: 1 },
    })
    const { service } = harness
    const flow = await seed(service, templateId => ({
      nodes: [start(), agent('a1', templateId, 'one'), agent('a2', templateId, 'two'), end()],
      edges: [
        { kind: 'execution', from: 'start', to: 'a1' },
        { kind: 'execution', from: 'start', to: 'a2' },
        { kind: 'execution', from: 'a1', to: 'end' },
        { kind: 'execution', from: 'a2', to: 'end' },
      ],
    }))

    const run = await startRun(harness, flow, 'go')
    await vi.waitFor(async () => {
      expect((await service.readRun(run.id)).nodeRuns.find(entry => entry.nodeId === 'a1')?.status).toBe('running')
    }, { timeout: 2000, interval: 10 })

    await service.cancel(harness.parent, run.id)
    const settled = await waitForSettled(service, run.id, 'cancelled')
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'a1')).toMatchObject({ status: 'failed', error: 'run cancelled' })
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'a2')).toMatchObject({ status: 'failed', error: 'run cancelled' })
  })

  it('reads a template at node start, so an edit applies to nodes that have not begun', async () => {
    const gate = deferred()
    const harness = await setup({ scripts: { a1: { gate: gate.promise, text: 'one' }, a2: { text: 'two' } } })
    const { service, stub } = harness
    const template = await service.saveTemplate({ name: 'Node agent', persona: 'first persona' })
    const flow = await service.saveFlow({
      name: 'demo',
      nodes: [start(), agent('a1', template.id, 'one'), agent('a2', template.id, 'two'), end()],
      edges: [{ kind: 'execution', from: 'start', to: 'a1' }, { kind: 'execution', from: 'a1', to: 'a2' }, { kind: 'execution', from: 'a2', to: 'end' }],
    } satisfies FlowDraft)

    const run = await startRun(harness, flow, 'go')
    // The recorded request proves a1 already read its template; its gate then
    // holds it until the edit below, while a2 has not started.
    await vi.waitFor(() => { expect(stub.requests.map(request => request.label)).toEqual(['a1']) }, { timeout: 2000, interval: 10 })

    await service.saveTemplate({ id: template.id, name: 'Node agent', persona: 'second persona' })
    gate.resolve()
    await waitForSettled(service, run.id, 'completed')

    expect(stub.requests.map(request => promptText(request))).toEqual([
      expect.stringContaining('## Your role\nfirst persona'),
      expect.stringContaining('## Your role\nsecond persona'),
    ])
  })

  it('joins only the text blocks of a mixed assistant output', async () => {
    const harness = await setup({
      scripts: {
        a1: { blocks: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'answer' }] },
      },
    })
    const { service } = harness
    const flow = await seed(service, templateId => ({
      nodes: [start(), agent('a1', templateId, 'run'), end()],
      edges: [{ kind: 'execution', from: 'start', to: 'a1' }, { kind: 'execution', from: 'a1', to: 'end' }],
    }))

    const run = await startRun(harness, flow, 'go')
    const settled = await waitForSettled(service, run.id, 'completed')
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'a1')).toMatchObject({ handoff: 'answer' })
  })

  it('contains a failing child disposal to a warning', async () => {
    const harness = await setup({ scripts: { a1: { text: 'ok', failDispose: true } } })
    const { ctx, service } = harness
    const warn = vi.spyOn(ctx.logger, 'warn')
    const flow = await seed(service, templateId => ({
      nodes: [start(), agent('a1', templateId, 'run'), end()],
      edges: [{ kind: 'execution', from: 'start', to: 'a1' }, { kind: 'execution', from: 'a1', to: 'end' }],
    }))

    const run = await startRun(harness, flow, 'go')
    await waitForSettled(service, run.id, 'completed')
    expect(warn.mock.calls.some(call => String(call[0]).includes('disposal failed'))).toBe(true)
  })

  it('fails the run when node record writes fail, without corrupting settled state', async () => {
    const gate = deferred()
    const harness = await setup({ scripts: { a1: { gate: gate.promise, text: 'ok' } } })
    const { ctx, service, pool } = harness
    const warn = vi.spyOn(ctx.logger, 'warn')
    const flow = await seed(service, templateId => ({
      nodes: [start(), agent('a1', templateId, 'run'), end()],
      edges: [{ kind: 'execution', from: 'start', to: 'a1' }, { kind: 'execution', from: 'a1', to: 'end' }],
    }))

    const run = await startRun(harness, flow, 'go')
    await vi.waitFor(async () => {
      expect((await service.readRun(run.id)).nodeRuns.find(entry => entry.nodeId === 'a1')?.status).toBe('running')
    }, { timeout: 2000, interval: 10 })

    pool.failNextWrites = 3
    gate.resolve()
    const settled = await waitForSettled(service, run.id, 'failed')
    expect(settled.error).toBe('node "a1" failed: injected write failure')
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'a1')).toMatchObject({ status: 'failed' })
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'end')).toMatchObject({ status: 'skipped' })
    expect(warn.mock.calls.some(call => String(call[0]).includes('failure record rejected'))).toBe(true)
    expect(warn.mock.calls.some(call => String(call[0]).includes('skip record rejected'))).toBe(true)
  })

  it('rejects a run whose flow has no registered executor name', async () => {
    const harness = await setup({ plugin: { executor: 'other' } })
    const { service } = harness
    const flow = await seed(service, templateId => ({
      nodes: [start(), agent('a1', templateId, 'run'), end()],
      edges: [{ kind: 'execution', from: 'start', to: 'a1' }, { kind: 'execution', from: 'a1', to: 'end' }],
    }))

    await expect(service.start(harness.parent, { flowId: flow.id, input: 'go', signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'agent-flow/executor-missing', details: { registered: ['other'] } })
  })

  it('applies its defaults when mounted without configuration', async () => {
    const harness = await setup({ defaults: true })
    const { service } = harness
    const flow = await seed(service, templateId => ({
      nodes: [start(), agent('a1', templateId, 'run'), end()],
      edges: [{ kind: 'execution', from: 'start', to: 'a1' }, { kind: 'execution', from: 'a1', to: 'end' }],
    }))

    const run = await startRun(harness, flow, 'go')
    const settled = await waitForSettled(service, run.id, 'failed')
    expect(settled.error).toBe('node "a1" failed: no subagent provider registered for "spawn"')
  })

  it('rejects a blank executor or provider name at load', async () => {
    await expect(setup({ plugin: { executor: '   ' } })).rejects.toThrow('executor must not be an empty name')
    await expect(setup({ plugin: { provider: '   ' } })).rejects.toThrow('provider must not be an empty name')
  })

  it('starts every parallel role before any completes and joins their three results once', async () => {
    const gate = deferred()
    const harness = await setup({
      scripts: {
        product: { gate: gate.promise, text: 'product view' },
        engineer: { gate: gate.promise, text: 'engineer view' },
        qa: { gate: gate.promise, text: 'qa view' },
        summary: { text: 'summary' },
      },
      plugin: { maxConcurrentAgents: 3 },
    })
    const { service, stub } = harness
    const flow = await seed(service, templateId => ({
      nodes: [
        start(),
        agent('product', templateId, 'assess value'),
        agent('engineer', templateId, 'assess plan'),
        agent('qa', templateId, 'assess risk'),
        agent('summary', templateId, 'summarize'),
        end(),
      ],
      edges: [
        { kind: 'execution', from: 'start', to: 'product' },
        { kind: 'execution', from: 'start', to: 'engineer' },
        { kind: 'execution', from: 'start', to: 'qa' },
        { kind: 'execution', from: 'product', to: 'summary' },
        { kind: 'execution', from: 'engineer', to: 'summary' },
        { kind: 'execution', from: 'qa', to: 'summary' },
        { kind: 'execution', from: 'summary', to: 'end' },
      ],
    }))

    const run = await startRun(harness, flow, 'go')
    await vi.waitFor(() => { expect(stub.maxConcurrent).toBe(3) }, { timeout: 2000, interval: 10 })
    expect(stub.requests.map(request => request.label).sort()).toEqual(['engineer', 'product', 'qa'])
    expect(stub.requests.filter(request => request.label === 'summary')).toHaveLength(0)

    gate.resolve()
    const settled = await waitForSettled(service, run.id, 'completed')
    const summaries = stub.requests.filter(request => request.label === 'summary')
    expect(summaries).toHaveLength(1)
    expect(promptText(summaries[0]!)).toContain('## Handoff from product\nproduct view')
    expect(promptText(summaries[0]!)).toContain('## Handoff from engineer\nengineer view')
    expect(promptText(summaries[0]!)).toContain('## Handoff from qa\nqa view')
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'summary')?.inputs).toEqual([
      { nodeId: 'product', iteration: 0 },
      { nodeId: 'engineer', iteration: 0 },
      { nodeId: 'qa', iteration: 0 },
    ])
  })

  it('applies the concurrency limit per run, so two runs may run one node each at once', async () => {
    const gateA = deferred()
    const gateB = deferred()
    const harness = await setup({
      scripts: { a1: [{ gate: gateA.promise, text: 'one' }, { gate: gateB.promise, text: 'two' }] },
      plugin: { maxConcurrentAgents: 1 },
    })
    const { service, stub } = harness
    const flow = await seed(service, templateId => ({
      nodes: [start(), agent('a1', templateId, 'work'), end()],
      edges: [{ kind: 'execution', from: 'start', to: 'a1' }, { kind: 'execution', from: 'a1', to: 'end' }],
    }))

    const first = await startRun(harness, flow, 'run one')
    const second = await startRun(harness, flow, 'run two')
    await vi.waitFor(() => { expect(stub.maxConcurrent).toBe(2) }, { timeout: 2000, interval: 10 })
    expect(stub.requests).toHaveLength(2)

    gateA.resolve()
    gateB.resolve()
    await waitForSettled(service, first.id, 'completed')
    await waitForSettled(service, second.id, 'completed')
    expect(stub.maxConcurrent).toBe(2)
  })

  it('cancels a run while its join still waits, without starting the joined target', async () => {
    const gate = deferred()
    const harness = await setup({
      scripts: { a1: { text: 'ready' }, a2: { gate: gate.promise, text: 'never' }, merge: { text: 'merge' } },
    })
    const { service, stub } = harness
    const flow = await seed(service, templateId => ({
      nodes: [start(), agent('a1', templateId, 'one'), agent('a2', templateId, 'two'), agent('merge', templateId, 'merge'), end()],
      edges: [
        { kind: 'execution', from: 'start', to: 'a1' },
        { kind: 'execution', from: 'start', to: 'a2' },
        { kind: 'execution', from: 'a1', to: 'merge' },
        { kind: 'execution', from: 'a2', to: 'merge' },
        { kind: 'execution', from: 'merge', to: 'end' },
      ],
    }))

    const run = await startRun(harness, flow, 'go')
    await vi.waitFor(async () => {
      expect((await service.readRun(run.id)).nodeRuns.find(entry => entry.nodeId === 'a1')?.status).toBe('succeeded')
    }, { timeout: 2000, interval: 10 })
    await service.cancel(harness.parent, run.id)
    const settled = await waitForSettled(service, run.id, 'cancelled')
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'a2')).toMatchObject({ status: 'failed', error: 'run cancelled' })
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'merge')).toMatchObject({ status: 'skipped' })
    expect(stub.requests.filter(request => request.label === 'merge')).toHaveLength(0)
  })

  it('does not cancel an interactive Agent that is no longer live', async () => {
    const harness = await setup({ scripts: { a1: { text: 'still talking' } } })
    const { service, roots } = harness
    const flow = await seed(service, templateId => ({
      nodes: [start(), agent('a1', templateId, 'clarify', { interactive: true }), end()],
      edges: [{ kind: 'execution', from: 'start', to: 'a1' }, { kind: 'execution', from: 'a1', to: 'end' }],
    }))

    const run = await startRun(harness, flow, 'go')
    const root = await waitForRoot(roots)
    // A closed turn without a Result leaves the node waiting for the user.
    root.reply('still talking')
    await waitForNode(service, run.id, 'a1', 'conversing')
    // Disposal unregisters the Agent before its loop projections unwind; a run
    // cancellation arriving afterwards must not touch that released inbox.
    roots.disposeAgent(root.sessionId)
    await service.cancel(harness.parent, run.id)
    const settled = await waitForSettled(service, run.id, 'cancelled')
    expect(root.cancels).toEqual([])
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'a1')?.status).toBe('failed')
  })

  it('rejects a start for an unknown flow without starting any child', async () => {
    const harness = await setup()
    const { service, stub } = harness
    await expect(service.start(harness.parent, { flowId: FlowId('missing'), input: 'go', signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'agent-flow/not-found' })
    expect(stub.requests).toHaveLength(0)
  })
})
