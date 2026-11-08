/**
 * Cancellation ownership across an interactive node's opening messages. A
 * synchronous listener of the messages entering the conversation's inbox may
 * cancel the run from inside the insertion; both opening deliveries must then
 * end in a cancelled run with no model activity, and neither the run nor its
 * conversation may need an outside cancellation to become quiet.
 * @module
 */

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
import AgentFlowService from '@deepseek-ai/dsh-experimental-agent-flow'
import type { FlowNode, FlowRun } from '@deepseek-ai/dsh-experimental-agent-flow'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SubagentService from '@deepseek-ai/dsh-subagent'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as AgentFlowRuntime from '../src/index.ts'
import { StubProvider } from './stub-provider.ts'

const contexts: Context[] = []
const directories: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** One booted composition: the parent session, the adapter, and the events it records. */
interface Bench {
  readonly ctx: Context
  readonly parent: Agent
  readonly adapter: MockAdapter
  readonly sessionEvents: SessionEvent[]
  /**
   * Save an interactive flow and start it with a synchronous listener that
   * cancels the run from inside its first inbox insertion.
   * @param inputEdge - wire the original request to the conversational node.
   * @returns the started run.
   */
  start(inputEdge: boolean): Promise<FlowRun>
}

/**
 * Boot the real service, runtime, AgentLoop, and storage over a MockAdapter
 * with no scripted response: any model activity fails loudly instead of
 * passing silently.
 * @returns the composition and its start operation.
 */
async function bench(): Promise<Bench> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountWorkingDirectoryFixture(ctx)
  if (ctx.get('sessionProjections') === undefined) await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentService)
  await ctx.plugin(Storage)
  const pool = new MemoryMediaPool()
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(AgentFlowService)
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
  const adapter = new MockAdapter([])
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.subagents.registerProvider(new StubProvider('stub', {}))
  await ctx.plugin(AgentFlowRuntime, { provider: 'stub' })

  const dir = await mkdtemp(join(tmpdir(), 'dsh-flow-cancel-'))
  directories.push(dir)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' }, { cwd: dir })
  const template = await ctx.agentFlows.saveTemplate({ name: 'Clarifier' })
  const sessionEvents: SessionEvent[] = []
  ctx.on('session/event', (session, event) => {
    if (String(session.id).startsWith('flow-')) sessionEvents.push(event)
  })

  return {
    ctx,
    parent,
    adapter,
    sessionEvents,
    start: async (inputEdge) => {
      const nodes: FlowNode[] = [
        { kind: 'start', id: 'start' },
        { kind: 'agent', id: 'talk', templateId: template.id, instruction: 'ask', interactive: true },
        { kind: 'end', id: 'end' },
      ]
      const flow = await ctx.agentFlows.saveFlow({
        name: inputEdge ? 'dialogue with request' : 'dialogue',
        nodes,
        edges: [
          { kind: 'execution', from: 'start', to: 'talk' },
          ...inputEdge ? [{ kind: 'input' as const, from: 'start', to: 'talk' }] : [],
          { kind: 'execution', from: 'talk', to: 'end' },
        ],
      })
      const owner = new AbortController()
      /* A legitimate synchronous plugin listener: the run is cancelled from
         inside the insertion of the conversation's own runtime context. */
      ctx.on('agent/inbox/inserted', ({ agent, message }) => {
        if (agent !== parent && message.source.kind === 'agent-flow') owner.abort()
      })
      return await ctx.agentFlows.start(parent, { flowId: flow.id, input: 'build a sorter', signal: owner.signal })
    },
  }
}

/** Wait for the run's own terminal record. */
async function settled(ctx: Context, id: FlowRun['id'], status: FlowRun['status']): Promise<FlowRun> {
  return await vi.waitFor(async () => {
    const run = await ctx.agentFlows.readRun(id)
    expect(run.status).toBe(status)
    return run
  }, { timeout: 5000, interval: 10 })
}

/** The conversation's root Agent, which the run materializes beside its parent. */
function conversationOf(h: Bench): Agent {
  const live = h.ctx.agents.roots().find(agent => agent !== h.parent)
  if (live === undefined) throw new Error('no conversation agent was created')
  return live
}

describe('cancellation during the opening messages', () => {
  it('leaves no model activity when the context insertion cancels the run', async () => {
    const h = await bench()
    const run = await h.start(true)

    const cancelled = await settled(h.ctx, run.id, 'cancelled')
    expect(cancelled.nodeRuns.find(entry => entry.nodeId === 'talk')).toMatchObject({
      status: 'failed',
      error: 'run cancelled',
    })
    /* The listener cancelled on the runtime context, so the human request was
       never queued and no turn began. */
    expect(h.adapter.requests).toEqual([])
    const human = h.sessionEvents.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
    expect(human).toEqual([])
    const live = conversationOf(h)
    await live.whenIdle()
    expect(live.status).toBe('idle')
  })

  it('leaves no model activity when the context-only opening cancels the run', async () => {
    const h = await bench()
    const run = await h.start(false)

    const cancelled = await settled(h.ctx, run.id, 'cancelled')
    expect(cancelled.nodeRuns.find(entry => entry.nodeId === 'talk')?.status).toBe('failed')
    expect(h.adapter.requests).toEqual([])
    const live = conversationOf(h)
    await live.whenIdle()
    expect(live.status).toBe('idle')
  })
})
