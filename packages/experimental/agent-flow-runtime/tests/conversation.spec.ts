import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelection, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AgentTemplateId, type AgentTemplate } from '@deepseek-ai/dsh-experimental-agent-flow'
import { Conversation, conversationRoute, type ConversationSeat } from '../src/conversation.ts'
import { StubAgentRegistry } from './root-agents.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

const DEFAULTS: ModelSelection = {
  provider: 'deep',
  model: 'large',
  reasoningEffort: ReasoningEffortId('high'),
}

function template(route: { provider?: string; model?: string }): AgentTemplate {
  return {
    id: AgentTemplateId('template-1'),
    name: 'Node agent',
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T00:00:00.000Z',
    ...route.provider === undefined ? {} : { provider: route.provider },
    ...route.model === undefined ? {} : { model: route.model },
  }
}

describe('conversationRoute', () => {
  it('keeps the deployment default when the template declares no route', () => {
    expect(conversationRoute(DEFAULTS, template({}))).toBe(DEFAULTS)
  })

  it('drops the inherited reasoning effort when the template overrides the provider', () => {
    expect(conversationRoute(DEFAULTS, template({ provider: 'cheap' }))).toEqual({ provider: 'cheap', model: 'large' })
  })

  it('drops the inherited reasoning effort when the template overrides the model', () => {
    expect(conversationRoute(DEFAULTS, template({ model: 'small' }))).toEqual({ provider: 'deep', model: 'small' })
  })
})

/** One recording seat: the order a conversation published and withdrew itself. */
function recordingSeat(): { seat: ConversationSeat; log: string[] } {
  const log: string[] = []
  return {
    log,
    seat: {
      publish: () => { log.push('publish') },
      withdraw: () => { log.push('withdraw') },
    },
  }
}

describe('Conversation', () => {
  it('keeps every turn of its own Session, including one that closed before the wait', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const roots = new StubAgentRegistry(ctx)
    ctx.provide('agents', roots)
    const parent = { session: { id: SessionId('parent-session') }, ctx } as Agent
    const controller = new AbortController()
    const published = recordingSeat()
    const request = {
      parent,
      workspace: '/workspace',
      cwd: '/workspace',
      route: DEFAULTS,
      signal: controller.signal,
      seat: published.seat,
    }
    const conversation = new Conversation(ctx, { ...request, title: 'Clarify', prompt: { context: 'ask the user what to build' } })
    await conversation.open()
    const root = roots.created[0]
    if (root === undefined) throw new Error('no root session was created')
    expect(root.prompts).toEqual(['ask the user what to build'])

    root.reply('first answer')
    root.reply('second answer')
    // Both turns closed with no waiter pending; the recorded turn list, not a
    // live promise, is what carries them into the waits that follow.
    expect(await conversation.awaitTurn()).toEqual({
      output: [{ type: 'text', text: 'first answer' }],
      reason: { kind: 'completed' },
    })
    expect(await conversation.awaitTurn()).toEqual({
      output: [{ type: 'text', text: 'second answer' }],
      reason: { kind: 'completed' },
    })

    // A second conversation shares the context; its turns must stay its own.
    const other = new Conversation(ctx, { ...request, title: 'Other', prompt: { context: 'ask something else' } })
    await other.open()
    const otherRoot = roots.created[1]
    if (otherRoot === undefined) throw new Error('no second root session was created')
    otherRoot.reply('elsewhere')
    expect(await other.awaitTurn()).toEqual({
      output: [{ type: 'text', text: 'elsewhere' }],
      reason: { kind: 'completed' },
    })

    conversation.close()
    other.close()
    root.reply('third answer')
    // Observation stopped with both conversations, so only the cancellation ends
    // this wait, and it ends without a turn: neither the late reply of this
    // Session nor the other Session's turn reached the fold.
    controller.abort()
    expect(await conversation.awaitTurn()).toEqual({ output: [], reason: undefined })
    /* Each conversation published once and withdrew once, in close order. */
    expect(published.log).toEqual(['publish', 'publish', 'withdraw', 'withdraw'])
  })

  it('delivers runtime rules as context and the request as a human message', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const roots = new StubAgentRegistry(ctx)
    ctx.provide('agents', roots)
    const parent = { session: { id: SessionId('parent-session') }, ctx } as Agent
    const conversation = new Conversation(ctx, {
      parent,
      title: 'Clarify',
      prompt: { context: 'internal rules', request: 'build a sorter' },
      workspace: '/workspace',
      cwd: '/workspace',
      route: DEFAULTS,
      signal: new AbortController().signal,
      seat: recordingSeat().seat,
    })
    await conversation.open()
    const root = roots.created[0]
    if (root === undefined) throw new Error('no root session was created')
    expect(root.messages.map(message => message.source.kind)).toEqual(['agent-flow', 'user'])
    expect(root.prompts).toEqual(['internal rules', 'build a sorter'])
    conversation.close()
  })

  it('cancels a Session whose creation finished after the run aborted', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const roots = new StubAgentRegistry(ctx)
    ctx.provide('agents', roots)
    let release!: () => void
    roots.createGate = new Promise<void>((resolve) => { release = resolve })
    const parent = { session: { id: SessionId('parent-session') }, ctx } as Agent
    const controller = new AbortController()
    const conversation = new Conversation(ctx, {
      parent,
      title: 'Clarify',
      prompt: { context: 'ask the user what to build' },
      workspace: '/workspace',
      cwd: '/workspace',
      route: DEFAULTS,
      signal: controller.signal,
      seat: recordingSeat().seat,
    })
    const opening = conversation.open()
    controller.abort()
    release()
    await opening
    const root = roots.created[0]
    if (root === undefined) throw new Error('no root session was created')
    /* The abort landed before creation resolved, so no opening prompt may queue. */
    expect(root.messages).toEqual([])
    expect(root.cancels).toEqual([{ kind: 'user' }])
    conversation.close()
  })

  it('refuses human input once closed, while admitting the message the runtime submitted', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const roots = new StubAgentRegistry(ctx)
    ctx.provide('agents', roots)
    const parent = { session: { id: SessionId('parent-session') }, ctx } as Agent
    const conversation = new Conversation(ctx, {
      parent,
      title: 'Clarify',
      prompt: { context: 'ask the user what to build' },
      workspace: '/workspace',
      cwd: '/workspace',
      route: DEFAULTS,
      signal: new AbortController().signal,
      seat: recordingSeat().seat,
    })
    await conversation.open()
    const root = roots.created[0]
    if (root === undefined) throw new Error('no root session was created')

    const human = createUserMessage({ content: [{ type: 'text', text: 'one more thing' }], source: { kind: 'user' } })
    const propose = async (messages: UserMessage[], entered: PreStepDecision): Promise<PreStepDecision> =>
      await agentEvents(ctx, root.agent).waterfall(
        'agent/pre-step',
        { messages, turn: 1, step: 1, signal: new AbortController().signal, modelSelection: { provider: 'mock', model: 'mock' } },
        async () => entered,
      )

    /* While the run drives the conversation, a human reply enters its step. */
    expect(await propose([human], { kind: 'enter', messages: [human] })).toEqual({ kind: 'enter', messages: [human] })
    /* An already-rejected step stays rejected without a second decision. */
    expect(await propose([human], { kind: 'reject' })).toEqual({ kind: 'reject' })

    conversation.close()
    expect(await propose([human], { kind: 'enter', messages: [human] })).toEqual({ kind: 'reject' })
    /* The opening prompt the runtime itself submitted stays admitted. */
    const opening = root.messages[0]
    if (opening === undefined) throw new Error('no opening prompt was submitted')
    expect(await propose([opening], { kind: 'enter', messages: [opening] })).toEqual({ kind: 'enter', messages: [opening] })
  })

  it('does not submit the opening prompt when cancelled during publication', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const roots = new StubAgentRegistry(ctx)
    ctx.provide('agents', roots)
    const parent = { session: { id: SessionId('parent-session') }, ctx } as Agent
    let attachedResolve!: () => void
    const attached = new Promise<void>((resolve) => { attachedResolve = resolve })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    ctx.provide('workspaceRegistry', {
      list: () => [{
        sessionIds: [parent.session.id],
        attachSession: async (): Promise<void> => {
          attachedResolve()
          await gate
        },
      }],
    })
    const controller = new AbortController()
    const conversation = new Conversation(ctx, {
      parent,
      title: 'Clarify',
      prompt: { context: 'ask the user what to build' },
      workspace: '/workspace',
      cwd: '/workspace',
      route: DEFAULTS,
      signal: controller.signal,
      seat: recordingSeat().seat,
    })

    const opening = conversation.open()
    await attached
    controller.abort()
    release()
    await opening
    const root = roots.created[0]
    if (root === undefined) throw new Error('no root session was created')
    expect(root.prompts).toEqual([])
    expect(root.cancels).toEqual([{ kind: 'user' }])
    await conversation.settle()
    conversation.close()
  })

  it('does not queue the human request when inserting the context cancels the run', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const roots = new StubAgentRegistry(ctx)
    ctx.provide('agents', roots)
    const parent = { session: { id: SessionId('parent-session') }, ctx } as Agent
    const controller = new AbortController()
    const conversation = new Conversation(ctx, {
      parent,
      title: 'Clarify',
      prompt: { context: 'internal rules', request: 'build a sorter' },
      workspace: '/workspace',
      cwd: '/workspace',
      route: DEFAULTS,
      signal: controller.signal,
      seat: recordingSeat().seat,
    })
    /* A synchronous listener of the first opening message cancels the run
       before the runtime submits the human request. */
    const off = ctx.on('agent/inbox/inserted', () => { controller.abort() })

    await conversation.open()
    const root = roots.created[0]
    if (root === undefined) throw new Error('no root session was created')
    expect(root.messages.map(message => message.source.kind)).toEqual(['agent-flow'])
    expect(root.cancels).toEqual([{ kind: 'user' }])

    off()
    await conversation.settle()
    conversation.close()
  })
})
