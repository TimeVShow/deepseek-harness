import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AgentTemplate, AgentTemplateId, FlowDocument, FlowDraft, FlowId, FlowRun, FlowRunId } from '@deepseek-ai/dsh-experimental-agent-flow/types'
import type {} from '@deepseek-ai/dsh-experimental-agent-flow/remote'
import { AgentFlowController, type FlowLockReason } from '../src/client/controller.ts'

const SESSION = 'session-1' as SessionId
const FLOW = 'flow-1' as FlowId
const RUN = 'run-1' as FlowRunId
const TEMPLATE = 'template-1' as AgentTemplateId

function flowDocument(name = 'demo'): FlowDocument {
  return {
    id: FLOW,
    name,
    maxIterations: 16,
    nodes: [{ kind: 'start', id: 'start' }, { kind: 'end', id: 'end' }],
    edges: [{ kind: 'execution', from: 'start', to: 'end' }],
    createdAt: '2026-09-24T00:00:00.000Z',
    updatedAt: '2026-09-24T00:00:00.000Z',
  }
}

function template(): AgentTemplate {
  return {
    id: TEMPLATE,
    name: 'Node agent',
    createdAt: '2026-09-24T00:00:00.000Z',
    updatedAt: '2026-09-24T00:00:00.000Z',
  }
}

function run(status: FlowRun['status']): FlowRun {
  return {
    id: RUN,
    flowId: FLOW,
    snapshot: flowDocument(),
    parentSessionId: SESSION,
    status,
    input: 'write about bugs',
    nodeRuns: [{ nodeId: 'start', iteration: 0, status: 'succeeded' }],
    startedAt: '2026-09-24T00:00:00.000Z',
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

/** One controllable Agent Flow namespace double plus the session list remote. */
function bench(overrides: { agentFlows?: Partial<ReturnType<typeof defaults>> } = {}) {
  const ctx = new Context()
  const calls: string[] = []
  const ok = <T>(value: T) => Promise.resolve({ ok: true as const, value })
  function defaults() {
    return {
      listFlows: () => { calls.push('listFlows'); return ok([flowDocument()]) },
      listTemplates: () => { calls.push('listTemplates'); return ok([template()]) },
      listRuns: () => { calls.push('listRuns'); return ok([run('completed')]) },
      saveFlow: (draft: unknown) => { calls.push(`saveFlow:${JSON.stringify(draft)}`); return ok(flowDocument('saved')) },
      deleteFlow: (id: FlowId) => { calls.push(`deleteFlow:${String(id)}`); return ok(undefined) },
      saveTemplate: (draft: unknown) => { calls.push(`saveTemplate:${JSON.stringify(draft)}`); return ok(template()) },
      deleteTemplate: (id: AgentTemplateId) => { calls.push(`deleteTemplate:${String(id)}`); return ok(undefined) },
      cancel: (sessionId: SessionId, id: FlowRunId) => { calls.push(`cancel:${String(sessionId)}:${String(id)}`); return ok(undefined) },
      concludeConversation: (sessionId: SessionId, id: FlowRunId) => {
        calls.push(`concludeConversation:${String(sessionId)}:${String(id)}`)
        return ok(undefined)
      },
    }
  }
  const agentFlows = { ...defaults(), ...overrides.agentFlows }
  const failure = { ok: false as const, error: { code: 'agent-flow/not-found', message: 'gone' } }
  ctx.provide('remote', {
    agentFlows,
    session: {
      list: () => {
        calls.push('sessionList')
        return ok({ items: [{ sessionId: SESSION, agentAvailable: true, updatedAt: 1, running: false, blank: false, cwd: '/workspace' }] })
      },
      modelCatalog: () => {
        calls.push('modelCatalog')
        return ok({
          default: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
          routableProviders: ['deepseek'],
          groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'chat', name: 'Chat' }] }],
          failures: [],
        })
      },
    },
  } as never)
  const navigated: SessionId[] = []
  const locked: { sessionId: SessionId; reason: FlowLockReason }[] = []
  const controller = new AgentFlowController(
    ctx.remote,
    (sessionId) => { navigated.push(sessionId) },
    (sessionId, reason) => { locked.push({ sessionId, reason }) },
  )
  return { ctx, controller, calls, agentFlows, failure, navigated, locked }
}

/** The session a conversational node materializes. */
const CONVERSATION = 'flow-session' as SessionId

/**
 * One run whose snapshot carries a conversational entry node.
 * @param status - run status to report.
 * @param session - conversational node's session, absent before it materializes.
 * @returns the run record.
 */
function conversationalRun(status: FlowRun['status'], session?: SessionId): FlowRun {
  return {
    id: RUN,
    flowId: FLOW,
    snapshot: {
      ...flowDocument(),
      nodes: [
        { kind: 'start', id: 'start' },
        { kind: 'agent', id: 'clarify', templateId: TEMPLATE, instruction: 'ask what to build', interactive: true },
        { kind: 'end', id: 'end' },
      ],
      edges: [{ kind: 'execution', from: 'start', to: 'clarify' }, { kind: 'execution', from: 'clarify', to: 'end' }],
    },
    parentSessionId: SESSION,
    status,
    input: 'write about bugs',
    nodeRuns: [
      { nodeId: 'start', iteration: 0, status: 'succeeded' },
      session === undefined
        ? { nodeId: 'clarify', iteration: 0, status: 'pending' }
        : {
          nodeId: 'clarify',
          iteration: 0,
          /* A settled run leaves its conversational node settled too. */
          status: status === 'running' ? 'conversing' : 'succeeded',
          agentSessionId: session,
        },
    ],
    startedAt: '2026-09-24T00:00:00.000Z',
  }
}

const contexts: Context[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const ctx of contexts.splice(0)) void ctx.fiber.dispose()
})

describe('Agent Flow panel controller', () => {
  it('loads every list plus the session roster and the model catalog', async () => {
    const { ctx, controller, calls } = bench()
    contexts.push(ctx)
    await controller.load()
    const snapshot = controller.state.getSnapshot()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.flows.map(flow => flow.name)).toEqual(['demo'])
    expect(snapshot.templates).toHaveLength(1)
    expect(snapshot.runs).toHaveLength(1)
    expect(snapshot.sessions).toEqual([{ id: SESSION, live: true, cwd: '/workspace' }])
    expect(snapshot.modelGroups).toEqual([{
      provider: 'deepseek',
      providerLabel: 'DeepSeek',
      models: [{ provider: 'deepseek', model: 'chat', label: 'Chat' }],
    }])
    expect(calls).toEqual(['listFlows', 'listTemplates', 'listRuns', 'sessionList', 'modelCatalog'])
  })

  it('records a load failure and keeps the last good lists', async () => {
    const { ctx, controller } = bench()
    contexts.push(ctx)
    await controller.load()
    const broken = controller.state
    const failing = bench()
    contexts.push(failing.ctx)
    vi.spyOn(failing.agentFlows, 'listFlows').mockRejectedValue(new Error('offline'))
    await failing.controller.load()
    expect(failing.controller.state.getSnapshot()).toMatchObject({ status: 'error', error: 'offline' })
    expect(broken.getSnapshot().status).toBe('ready')
  })

  it('carries a non-Error rejection through its string form', async () => {
    const failing = bench()
    contexts.push(failing.ctx)
    vi.spyOn(failing.agentFlows, 'listTemplates').mockRejectedValue('plain')
    await failing.controller.load()
    expect(failing.controller.state.getSnapshot().error).toBe('plain')
  })

  it('opens a flow, edits its draft, and clears the selection', async () => {
    const { ctx, controller } = bench()
    contexts.push(ctx)
    await controller.load()
    controller.selectFlow(FLOW)
    expect(controller.state.getSnapshot().draft?.name).toBe('demo')
    controller.updateDraft((draft) => { draft.name = 'renamed' })
    expect(controller.state.getSnapshot().draft?.name).toBe('renamed')
    controller.selectFlow('missing' as FlowId)
    expect(controller.state.getSnapshot().draft).toBeUndefined()
    controller.updateDraft((draft) => { draft.name = 'ignored' })
    controller.setView('runs')
    expect(controller.state.getSnapshot().view).toBe('runs')
  })

  it('creates a starter flow with a neutral entry agent and selects it', async () => {
    const { ctx, controller, calls } = bench()
    contexts.push(ctx)
    await controller.load()
    await controller.createFlow()
    expect(calls.some(call => call.startsWith('saveTemplate:'))).toBe(true)
    expect(calls.some(call => call.startsWith('saveFlow:'))).toBe(true)
    expect(controller.state.getSnapshot().selectedFlowId).toBe(FLOW)
  })

  it('saves, deletes, and clears a deleted selection', async () => {
    const { ctx, controller, calls } = bench()
    contexts.push(ctx)
    await controller.load()
    controller.selectFlow(FLOW)
    await controller.saveFlow(flowDocument('edited'))
    expect(calls.some(call => call.startsWith('saveFlow:'))).toBe(true)
    await controller.saveTemplate({ name: 'T' })
    await controller.deleteTemplate(TEMPLATE)
    await controller.deleteFlow(FLOW)
    expect(controller.state.getSnapshot().selectedFlowId).toBeUndefined()
    expect(calls).toContain(`deleteFlow:${FLOW}`)
  })

  it('selects a run, resolves its workspace root, and cancels by parent session', async () => {
    const { ctx, controller, calls } = bench()
    contexts.push(ctx)
    await controller.load()
    controller.selectRun(RUN)
    expect(controller.state.getSnapshot().selectedRunId).toBe(RUN)
    expect(controller.cwdOf(SESSION)).toBe('/workspace')
    expect(controller.cwdOf('missing' as SessionId)).toBeUndefined()
    await controller.cancelRun(SESSION, RUN)
    expect(calls).toContain(`cancel:${SESSION}:${RUN}`)
    controller.selectRun(undefined)
    expect(controller.state.getSnapshot().selectedRunId).toBeUndefined()
  })

  it('associates a node session with the run that opened inside it', async () => {
    const { ctx, controller, agentFlows } = bench()
    contexts.push(ctx)
    const nodeSession = 'flow-node' as SessionId
    const otherParent = 'session-2' as SessionId
    const parented = { ...run('completed'), id: 'run-2' as FlowRunId }
    const nodeRun: FlowRun = {
      ...run('running'),
      id: 'run-3' as FlowRunId,
      parentSessionId: otherParent,
      nodeRuns: [{ nodeId: 'implement', iteration: 0, status: 'running', agentSessionId: nodeSession }],
    }
    vi.spyOn(agentFlows, 'listRuns').mockResolvedValue({ ok: true, value: [nodeRun, parented] })
    await controller.load()
    /* The parent session and the node session each address their run; an
       unrelated session addresses none. */
    expect(controller.runsForSession(SESSION).map(entry => entry.id)).toEqual(['run-2'])
    expect(controller.runsForSession(nodeSession).map(entry => entry.id)).toEqual(['run-3'])
    expect(controller.runsForSession(otherParent).map(entry => entry.id)).toEqual(['run-3'])
    expect(controller.runsForSession('missing' as SessionId)).toEqual([])
  })

  it('puts the live runs of a session first and orders the rest newest first', async () => {
    const { ctx, controller, agentFlows } = bench()
    contexts.push(ctx)
    const older = { ...run('completed'), id: 'run-2' as FlowRunId, startedAt: '2026-09-23T00:00:00.000Z' }
    const live = { ...run('running'), id: 'run-3' as FlowRunId, startedAt: '2026-09-22T00:00:00.000Z' }
    vi.spyOn(agentFlows, 'listRuns').mockResolvedValue({ ok: true, value: [older, live] })
    await controller.load()
    expect(controller.runsForSession(SESSION).map(entry => entry.id)).toEqual(['run-3', 'run-2'])
  })

  it('stamps each successful read and marks failed reads as interrupted', async () => {
    const { ctx, controller, agentFlows } = bench()
    contexts.push(ctx)
    await controller.load()
    const first = controller.state.getSnapshot().lastSyncedAt
    expect(first).toBeTypeOf('number')
    expect(controller.state.getSnapshot().syncError).toBeUndefined()

    vi.spyOn(agentFlows, 'listRuns').mockRejectedValue(new Error('offline'))
    await controller.load()
    expect(controller.state.getSnapshot()).toMatchObject({ status: 'error', syncError: 'offline' })
    /* The last good lists stay published for the last-known display. */
    expect(controller.state.getSnapshot().runs).toHaveLength(1)

    vi.spyOn(agentFlows, 'listRuns').mockResolvedValue({ ok: true, value: [] })
    await controller.load()
    const recovered = controller.state.getSnapshot()
    expect(recovered.status).toBe('ready')
    expect(recovered.syncError).toBeUndefined()
    expect(recovered.lastSyncedAt).toBeGreaterThanOrEqual(first ?? 0)
  })

  it('ends a clarification through the run authority and reloads', async () => {
    const { ctx, controller, calls } = bench()
    contexts.push(ctx)
    await controller.load()
    const settled = calls.length
    await controller.concludeConversation(SESSION, RUN)
    expect(calls[settled]).toBe(`concludeConversation:${SESSION}:${RUN}`)
    /* The reload folds the node's next state in without waiting for a poll. */
    expect(calls.slice(settled + 1)).toEqual(['listFlows', 'listTemplates', 'listRuns', 'sessionList', 'modelCatalog'])
  })

  it('folds a freshly started run into the store and arms the poll right away', async () => {
    vi.useFakeTimers()
    const { ctx, controller, calls } = bench()
    contexts.push(ctx)
    await controller.load()
    const settled = calls.length
    await vi.advanceTimersByTimeAsync(3000)
    expect(calls.length).toBe(settled)

    const fresh = { ...run('running'), id: 'run-2' as FlowRunId }
    controller.noteStarted(fresh)
    expect(controller.state.getSnapshot().runs.map(candidate => candidate.status)).toEqual(['running', 'completed'])
    await vi.advanceTimersByTimeAsync(3000)
    expect(calls.length).toBeGreaterThan(settled)
    controller.noteStarted({ ...fresh, input: 'restated' })
    expect(controller.state.getSnapshot().runs.map(candidate => candidate.input)).toEqual(['restated', 'write about bugs'])
    controller.dispose()
  })

  it('keeps a run started while a refresh is in flight and keeps polling it', async () => {
    vi.useFakeTimers()
    const gate = deferred<undefined>()
    const reached = deferred<undefined>()
    const { ctx, controller, calls } = bench({
      agentFlows: {
        listRuns: async () => {
          reached.resolve(undefined)
          await gate.promise
          return { ok: true as const, value: [] }
        },
      },
    })
    contexts.push(ctx)
    const loading = controller.load()
    await reached.promise
    const fresh = { ...run('running'), id: 'run-2' as FlowRunId, input: 'fresh' }
    controller.noteStarted(fresh)
    gate.resolve(undefined)
    await loading

    expect(controller.state.getSnapshot().runs.map(candidate => candidate.id)).toEqual(['run-2'])
    const beforePoll = calls.length
    await vi.advanceTimersByTimeAsync(1600)
    expect(calls.length).toBeGreaterThan(beforePoll)
    controller.dispose()
  })

  it('ignores an older refresh that arrives after a newer terminal state', async () => {
    const older = deferred<undefined>()
    const olderReached = deferred<undefined>()
    let reads = 0
    const { ctx, controller } = bench({
      agentFlows: {
        listRuns: async () => {
          reads += 1
          if (reads === 1) {
            olderReached.resolve(undefined)
            await older.promise
            return { ok: true as const, value: [run('running')] }
          }
          return { ok: true as const, value: [run('completed')] }
        },
      },
    })
    contexts.push(ctx)
    const stale = controller.load()
    await olderReached.promise
    await controller.load()
    expect(controller.state.getSnapshot().runs.map(candidate => candidate.status)).toEqual(['completed'])
    older.resolve(undefined)
    await stale
    expect(controller.state.getSnapshot().runs.map(candidate => candidate.status)).toEqual(['completed'])
  })

  it('keeps a saved rename when an older refresh finishes later', async () => {
    let saved = flowDocument('Original')
    let reads = 0
    const gate = deferred<undefined>()
    const reached = deferred<undefined>()
    const { ctx, controller } = bench({
      agentFlows: {
        listFlows: async () => {
          reads += 1
          if (reads === 2) {
            reached.resolve(undefined)
            await gate.promise
            return { ok: true as const, value: [flowDocument('Original')] }
          }
          return { ok: true as const, value: [{ ...saved }] }
        },
        saveFlow: async (draft) => {
          const next = draft as FlowDraft
          saved = { ...saved, ...next, id: FLOW, maxIterations: next.maxIterations ?? saved.maxIterations, updatedAt: 'b' }
          return { ok: true as const, value: { ...saved } }
        },
      },
    })
    contexts.push(ctx)
    await controller.load()
    controller.selectFlow(FLOW)
    const stale = controller.load()
    await reached.promise
    const draft = controller.state.getSnapshot().draft
    if (draft === undefined) throw new Error('no selected draft')
    await controller.saveFlow({ ...draft, name: 'Renamed' })
    expect(controller.state.getSnapshot().draft?.name).toBe('Renamed')
    gate.resolve(undefined)
    await stale
    expect(controller.state.getSnapshot().flows.map(flow => flow.name)).toEqual(['Renamed'])
    const renamed = controller.state.getSnapshot().draft
    if (renamed === undefined) throw new Error('no selected draft')
    await controller.saveFlow(renamed)
    expect(saved.name).toBe('Renamed')
  })

  it('does not resurrect a deleted flow from an older refresh', async () => {
    let saved = [flowDocument()]
    let reads = 0
    const gate = deferred<undefined>()
    const reached = deferred<undefined>()
    const { ctx, controller } = bench({
      agentFlows: {
        listFlows: async () => {
          reads += 1
          if (reads === 2) {
            reached.resolve(undefined)
            await gate.promise
            return { ok: true as const, value: [flowDocument()] }
          }
          return { ok: true as const, value: saved.map(flow => ({ ...flow })) }
        },
        deleteFlow: async () => {
          saved = []
          return { ok: true as const, value: undefined }
        },
      },
    })
    contexts.push(ctx)
    await controller.load()
    const stale = controller.load()
    await reached.promise
    await controller.deleteFlow(FLOW)
    gate.resolve(undefined)
    await stale
    expect(controller.state.getSnapshot().flows).toEqual([])
  })

  it('lets a refresh slower than the poll interval commit instead of starving', async () => {
    vi.useFakeTimers()
    let status: FlowRun['status'] = 'running'
    const gates: Deferred<undefined>[] = []
    const { ctx, controller } = bench({
      agentFlows: {
        listRuns: async () => {
          const gate = deferred<undefined>()
          gates.push(gate)
          await gate.promise
          return { ok: true as const, value: [run(status)] }
        },
      },
    })
    contexts.push(ctx)
    try {
      controller.noteStarted(run('running'))
      await vi.advanceTimersByTimeAsync(1600)
      expect(gates).toHaveLength(1)
      status = 'completed'
      await vi.advanceTimersByTimeAsync(1600)
      expect(gates).toHaveLength(1)

      const first = gates[0]
      if (first === undefined) throw new Error('no refresh gate was reached')
      first.resolve(undefined)
      await vi.advanceTimersByTimeAsync(0)
      expect(controller.state.getSnapshot().runs.map(candidate => candidate.status)).toEqual(['completed'])
    } finally {
      for (const gate of gates) gate.resolve(undefined)
      controller.dispose()
    }
  })

  it('keeps the poll gate occupied while a manual refresh overlaps the poll', async () => {
    vi.useFakeTimers()
    let status: FlowRun['status'] = 'running'
    const gates: Deferred<undefined>[] = []
    const { ctx, controller } = bench({
      agentFlows: {
        listRuns: async () => {
          const gate = deferred<undefined>()
          gates.push(gate)
          await gate.promise
          return { ok: true as const, value: [run(status)] }
        },
      },
    })
    contexts.push(ctx)
    try {
      controller.noteStarted(run('running'))
      await vi.advanceTimersByTimeAsync(1600)
      expect(gates).toHaveLength(1)

      const manual = controller.load()
      await vi.advanceTimersByTimeAsync(0)
      expect(gates).toHaveLength(2)

      status = 'completed'
      const poll = gates[0]
      if (poll === undefined) throw new Error('poll refresh gate missing')
      poll.resolve(undefined)
      await vi.advanceTimersByTimeAsync(1600)
      /* The manual refresh is still in flight, so the tick coalesces; an older
         poll finishing must not release the gate on its own. */
      expect(gates).toHaveLength(2)

      const overlapping = gates[1]
      if (overlapping === undefined) throw new Error('manual refresh gate missing')
      overlapping.resolve(undefined)
      await manual
      await vi.advanceTimersByTimeAsync(0)
      expect(controller.state.getSnapshot().runs.map(candidate => candidate.status)).toEqual(['completed'])
    } finally {
      for (const gate of gates) gate.resolve(undefined)
      controller.dispose()
    }
  })

  it('follows a run it started into the conversational node, exactly once', async () => {
    vi.useFakeTimers()
    const { ctx, controller, agentFlows, navigated } = bench()
    contexts.push(ctx)
    vi.spyOn(agentFlows, 'listRuns')
      .mockResolvedValueOnce({ ok: true, value: [conversationalRun('running')] })
      .mockResolvedValue({ ok: true, value: [conversationalRun('running', CONVERSATION)] })
    controller.noteStarted(conversationalRun('running'))
    // The node has materialized no session yet, so the first poll waits.
    await controller.load()
    expect(navigated).toEqual([])
    await controller.load()
    expect(navigated).toEqual([CONVERSATION])
    await controller.load()
    expect(navigated).toEqual([CONVERSATION])
    controller.dispose()
  })

  it('never follows a run this client did not start', async () => {
    const { ctx, controller, agentFlows, navigated } = bench()
    contexts.push(ctx)
    vi.spyOn(agentFlows, 'listRuns').mockResolvedValue({ ok: true, value: [conversationalRun('running', CONVERSATION)] })
    await controller.load()
    expect(navigated).toEqual([])
  })

  it('drops the navigation intent when the run settles before its node opens', async () => {
    const { ctx, controller, agentFlows, navigated } = bench()
    contexts.push(ctx)
    await controller.load()
    controller.noteStarted(conversationalRun('running'))
    vi.spyOn(agentFlows, 'listRuns').mockResolvedValue({ ok: true, value: [conversationalRun('failed', CONVERSATION)] })
    await controller.load()
    expect(navigated).toEqual([])
  })

  it('drops the navigation intent for a started run with no conversational node', async () => {
    const { ctx, controller, navigated } = bench()
    contexts.push(ctx)
    await controller.load()
    controller.noteStarted(run('running'))
    await controller.load()
    expect(navigated).toEqual([])
  })

  it('locks the composer of every concluded conversation in the roster', async () => {
    const { ctx, controller, agentFlows, locked } = bench()
    contexts.push(ctx)
    /* A node still conversing keeps its composer writable. */
    const listRuns = vi.spyOn(agentFlows, 'listRuns')
      .mockResolvedValue({ ok: true, value: [conversationalRun('running', CONVERSATION)] })
    await controller.load()
    expect(locked).toEqual([])

    /* Once the run settles, the conversation is concluded and its composer blocks. */
    listRuns.mockResolvedValue({ ok: true, value: [conversationalRun('completed', CONVERSATION)] })
    await controller.load()
    expect(locked).toEqual([{ sessionId: CONVERSATION, reason: { successors: [], runStatus: 'completed' } }])
    /* A later poll repeats the request; the registry owns deduplication. */
    await controller.load()
    expect(locked).toEqual([
      { sessionId: CONVERSATION, reason: { successors: [], runStatus: 'completed' } },
      { sessionId: CONVERSATION, reason: { successors: [], runStatus: 'completed' } },
    ])
  })

  it('names the live execution successors in a concluded conversation block', async () => {
    const { ctx, controller, agentFlows, locked } = bench()
    contexts.push(ctx)
    const implementing: FlowRun = {
      ...conversationalRun('running', CONVERSATION),
      snapshot: {
        ...conversationalRun('running').snapshot,
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
    vi.spyOn(agentFlows, 'listRuns').mockResolvedValue({ ok: true, value: [implementing] })
    await controller.load()
    expect(locked).toEqual([{
      sessionId: CONVERSATION,
      reason: { successors: [{ name: 'Node agent', live: true }], runStatus: 'running' },
    }])
  })

  it('names an unnamed structural successor by its id and a conversing one as live', async () => {
    const { ctx, controller, agentFlows, locked } = bench()
    contexts.push(ctx)
    const review: FlowRun = {
      ...conversationalRun('running', CONVERSATION),
      snapshot: {
        ...conversationalRun('running').snapshot,
        nodes: [
          { kind: 'start', id: 'start' },
          { kind: 'agent', id: 'clarify', templateId: TEMPLATE, instruction: 'ask', interactive: true },
          { kind: 'join', id: 'merge', mode: 'all' },
          { kind: 'agent', id: 'review', templateId: TEMPLATE, instruction: 'review' },
          { kind: 'end', id: 'end' },
        ],
        edges: [
          { kind: 'execution', from: 'start', to: 'clarify' },
          { kind: 'execution', from: 'clarify', to: 'merge' },
          { kind: 'execution', from: 'clarify', to: 'review' },
          { kind: 'execution', from: 'review', to: 'end' },
        ],
      },
      nodeRuns: [
        { nodeId: 'start', iteration: 0, status: 'succeeded' },
        { nodeId: 'clarify', iteration: 0, status: 'succeeded', agentSessionId: CONVERSATION },
        { nodeId: 'merge', iteration: 0, status: 'pending' },
        { nodeId: 'review', iteration: 0, status: 'conversing', agentSessionId: 'reviewer' as SessionId },
      ],
    }
    vi.spyOn(agentFlows, 'listRuns').mockResolvedValue({ ok: true, value: [review] })
    await controller.load()
    expect(locked).toEqual([{
      sessionId: CONVERSATION,
      reason: {
        /* A join carries no title of its own, so its id stands in. */
        successors: [{ name: 'merge', live: false }, { name: 'Node agent', live: true }],
        runStatus: 'running',
      },
    }])
  })

  it('drops observations no run can address any more', async () => {
    const { ctx, controller, agentFlows } = bench()
    contexts.push(ctx)
    const nodeSession = 'flow-node' as SessionId
    vi.spyOn(agentFlows, 'listRuns').mockResolvedValue({
      ok: true,
      value: [{
        ...run('running'),
        nodeRuns: [{ nodeId: 'implement', iteration: 0, status: 'running', agentSessionId: nodeSession }],
      }],
    })
    const observation = {
      stage: 'reasoning' as const,
      tools: [],
      observed: true,
      running: true,
      pendingSubmissions: 0,
      pendingInteraction: false,
      streamFailed: false,
    }
    controller.noteActivity(nodeSession, observation)
    controller.noteActivity('gone' as SessionId, observation)
    await controller.load()
    expect(Object.keys(controller.state.getSnapshot().nodeActivity)).toEqual([String(nodeSession)])
    /* A read that drops nothing leaves the published record untouched. */
    const kept = controller.state.getSnapshot().nodeActivity
    await controller.load()
    expect(controller.state.getSnapshot().nodeActivity).toBe(kept)
  })

  it('keeps a rename typed while the save was in flight', async () => {
    const { ctx, controller, agentFlows } = bench()
    contexts.push(ctx)
    await controller.load()
    controller.selectFlow(FLOW)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(agentFlows, 'saveFlow').mockImplementation(async () => {
      await gate
      return { ok: true, value: { ...flowDocument(), name: 'submitted' } }
    })
    const saving = controller.saveFlow({ ...flowDocument(), name: 'submitted' })
    /* The user renames the draft while the save is still on the wire. */
    controller.updateDraft((draft) => { draft.name = 'typed later' })
    release()
    await saving
    expect(controller.state.getSnapshot().draft?.name).toBe('typed later')
  })

  it('does not move an already settled run back to running on a stale refresh', async () => {
    const { ctx, controller, agentFlows } = bench()
    contexts.push(ctx)
    await controller.load()
    /* Publish the terminal fact first, then answer a later read with the older
       running state: the settled fact must win. */
    controller.noteStarted(run('completed'))
    vi.spyOn(agentFlows, 'listRuns').mockResolvedValue({ ok: true, value: [run('running')] })
    await controller.load()
    expect(controller.state.getSnapshot().runs.map(entry => entry.status)).toEqual(['completed'])
  })

  it('serves one queued refresh after an overlapping load finishes', async () => {
    vi.useFakeTimers()
    const { ctx, controller, agentFlows } = bench()
    contexts.push(ctx)
    /* A running run arms the poll. */
    vi.spyOn(agentFlows, 'listRuns').mockResolvedValue({ ok: true, value: [run('running')] })
    await controller.load()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const listFlows = vi.spyOn(agentFlows, 'listFlows')
      .mockImplementation(async () => { await gate; return { ok: true, value: [flowDocument()] } })
    const pending = controller.load()
    /* The poll tick lands while that load is still on the wire. */
    await vi.advanceTimersByTimeAsync(1600)
    release()
    await pending
    await vi.advanceTimersByTimeAsync(0)
    expect(listFlows.mock.calls.length).toBeGreaterThanOrEqual(2)
    controller.dispose()
  })

  it('drops updates that land after disposal', async () => {
    const { ctx, controller } = bench()
    contexts.push(ctx)
    const pending = controller.load()
    controller.dispose()
    await pending
    expect(controller.state.getSnapshot().status).toBe('loading')
  })

  it('reports a failed Remote result as an error message', async () => {
    const failing = bench()
    contexts.push(failing.ctx)
    vi.spyOn(failing.agentFlows, 'listRuns').mockResolvedValue({
      ok: false,
      error: Object.assign(new Error('too many runs'), { code: 'agent-flow/limit' }),
    } as never)
    await failing.controller.load()
    expect(failing.controller.state.getSnapshot()).toMatchObject({ status: 'error', error: 'too many runs' })
  })

  it('drops a failure that lands after disposal', async () => {
    const failing = bench()
    contexts.push(failing.ctx)
    vi.spyOn(failing.agentFlows, 'listFlows').mockImplementation(async () => {
      failing.controller.dispose()
      throw new Error('late failure')
    })
    await failing.controller.load()
    expect(failing.controller.state.getSnapshot().status).toBe('loading')
  })

  it('clears only a selected flow and stops polling on disposal', async () => {
    vi.useFakeTimers()
    const running = bench()
    contexts.push(running.ctx)
    vi.spyOn(running.agentFlows, 'listRuns').mockResolvedValue({ ok: true, value: [run('running')] })
    await running.controller.load()
    running.controller.selectFlow(FLOW)
    await running.controller.deleteFlow('other' as FlowId)
    expect(running.controller.state.getSnapshot().selectedFlowId).toBe(FLOW)
    await running.controller.deleteFlow(FLOW)
    expect(running.controller.state.getSnapshot().selectedFlowId).toBeUndefined()
    running.controller.dispose()
    running.controller.dispose()
  })

  it('polls while a run is in flight and stops when none is', async () => {
    vi.useFakeTimers()
    const { ctx, controller } = bench()
    contexts.push(ctx)
    vi.spyOn(controller, 'load').mockResolvedValue(undefined)
    vi.spyOn(controller.state, 'update')
    // A running run starts the poll; the next load with a settled run stops it.
    const running = bench()
    contexts.push(running.ctx)
    vi.spyOn(running.agentFlows, 'listRuns').mockResolvedValue({ ok: true, value: [run('running')] })
    await running.controller.load()
    const before = running.calls.length
    await vi.advanceTimersByTimeAsync(3000)
    expect(running.calls.length).toBeGreaterThan(before)
    vi.spyOn(running.agentFlows, 'listRuns').mockResolvedValue({ ok: true, value: [run('completed')] })
    await vi.advanceTimersByTimeAsync(3000)
    const settled = running.calls.length
    await vi.advanceTimersByTimeAsync(3000)
    expect(running.calls.length).toBe(settled)
    running.controller.dispose()
    controller.dispose()
  })
})
