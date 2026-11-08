import { startTestActivation } from './local-activation.ts'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'

async function fixture(options: { sandboxPolicy?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-child-sandbox-'))
  const origin = join(root, 'origin')
  const node = join(origin, 'node')
  await mkdir(node, { recursive: true })
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(TestSessionQuery)
  if (options.sandboxPolicy !== false) await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write' })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(Fork, { providerName: 'fork' })
  const adapter = new MockAdapter([textResponse('child'), textResponse('child')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const { agent: parent } = await ctx.agents.create({
    sessionId: SessionId('sandbox-parent'),
    meta: { cwd: origin },
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  return { ctx, parent, origin, node }
}

describe('subagent sandbox roots', () => {
  it.each(['spawn', 'fork'])('%s confines the child to the requested root while keeping its origin header', async (provider) => {
    const { ctx, parent, origin, node } = await fixture()
    const run = await startTestActivation(ctx, provider, {
      parent, cwd: node, sandboxRoot: node,
      prompt: [{ type: 'text', text: 'child' }], signal: new AbortController().signal,
    })
    await run.result

    const child = run.localAgent
    expect(child.session.header.cwd).toBe(origin)
    expect(ctx.sandboxPolicy.resolve({ session: child.session })).toMatchObject({
      mode: 'workspace-write',
      workspaceRoot: node,
    })
    expect(child.session.snapshotEvents().filter(event => event.type === 'sandbox/root'))
      .toMatchObject([{ data: { root: node } }])
  })

  it('seeds the parent override into a delegated child so it cannot widen its scope', async () => {
    const { ctx, parent, node } = await fixture()
    ctx.sandboxPolicy.setRoot(parent.session, node)
    const run = await startTestActivation(ctx, 'spawn', {
      parent, prompt: [{ type: 'text', text: 'child' }], signal: new AbortController().signal,
    })
    await run.result

    expect(run.localAgent.session.snapshotEvents().filter(event => event.type === 'sandbox/root'))
      .toMatchObject([{ data: { root: node, source: 'delegation' } }])
    expect(ctx.sandboxPolicy.resolve({ session: run.localAgent.session }).workspaceRoot).toBe(node)
  })

  it('refuses a backend that cannot honor the requested root', async () => {
    const { ctx, parent, node } = await fixture()
    const name = `opaque-${randomUUID()}`
    const unregister = ctx.subagents.registerProvider({
      name,
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
      inheritsParentContext: false,
      prepareContinuable: () => Promise.resolve({}),
    })
    try {
      await expect(ctx.subagents.startActivation({
        provider: name,
        label: 'opaque',
        request: { parent, sandboxRoot: node, prompt: [{ type: 'text', text: 'child' }] },
        signal: new AbortController().signal,
        delivery: 'caller',
      })).rejects.toThrow('does not support the "sandboxRoot" capability')
      expect(ctx.agents.list().map(agent => agent.id)).toEqual([parent.id])
    } finally {
      unregister()
    }
  })

  it('fails loud when the composition cannot enforce a requested root', async () => {
    const { ctx, parent, node } = await fixture({ sandboxPolicy: false })
    await expect(startTestActivation(ctx, 'spawn', {
      parent, cwd: node, sandboxRoot: node,
      prompt: [{ type: 'text', text: 'child' }], signal: new AbortController().signal,
    })).rejects.toThrow('require the sandbox-policy service')
  })
})
