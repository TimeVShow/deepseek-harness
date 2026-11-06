/**
 * Deterministic root-agent doubles for Agent Flow runtime tests. The registry
 * mints a real detached Session per `create` and runs the caller's setup over an
 * extended context, as the loop's factory does; the test then closes each turn
 * by appending and publishing the assistant message and `turn/end` a real loop
 * would, so the conversation driver observes the production event feed. Every
 * submission also publishes `agent/inbox/inserted` from inside the call, which
 * is where a real inbox lets a synchronous listener cancel the run.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, CreateAgentOptions, Inbox } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

/** One created root Session, driven turn by turn from the test. */
export interface StubRootAgent {
  /** Identity the runtime minted for the Session. */
  readonly sessionId: SessionId
  /** Creation options the runtime passed to the registry. */
  readonly options: CreateAgentOptions
  /** Text of every prompt submitted through `followup`, in order. */
  readonly prompts: string[]
  /** Every message submitted through `followup`, in order. */
  readonly messages: UserMessage[]
  /** The live agent the double published. */
  readonly agent: Agent
  /** Cancel causes recorded by `cancel`, in order. */
  readonly cancels: unknown[]
  /**
   * Close one turn with `text` as its final assistant message.
   * @param text - the turn's final assistant text.
   */
  reply(text: string): void
  /**
   * Close one turn whose model request failed.
   * @param message - the provider failure the turn reports.
   */
  fail(message: string): void
  /** Close one turn that produced no assistant output at all. */
  closeSilently(): void
}

/** The `ctx.agents` surface the runtime consumes. */
export interface StubAgentRegistryService {
  /**
   * Materialize one detached root Session.
   * @param options - identity, metadata, route, and setup from the caller.
   * @returns the owned handle; the runtime deliberately never disposes it.
   */
  create(options: CreateAgentOptions): Promise<AgentHandle>
}

/** `ctx.agents` double recording every root Session the runtime creates. */
export class StubAgentRegistry implements StubAgentRegistryService {
  /** Created root Sessions, in creation order. */
  readonly created: StubRootAgent[] = []

  private readonly liveAgents = new Map<string, Agent>()

  /** The live Agent for one Session, as the real registry answers while it is mounted. */
  get(id: SessionId): Agent | undefined {
    return this.liveAgents.get(String(id))
  }

  /** Drop one Agent from the registry, as disposal does before its loop scope unwinds. */
  disposeAgent(id: SessionId): void {
    this.liveAgents.delete(String(id))
  }

  /** Reject every `create` with this message, as an unavailable factory would. */
  rejectCreate: string | undefined

  /** Hold every `create` until released, to exercise creation against a racing abort. */
  createGate: Promise<void> | undefined

  /** When set, every created root holds `whenIdle` until this promise resolves. */
  idleGate: Promise<void> | undefined

  /**
   * @param ctx - test root context that owns the extended agent scopes and
   *   publishes the session events the double appends.
   */
  constructor(private readonly ctx: Context) {}

  async create(options: CreateAgentOptions): Promise<AgentHandle> {
    if (this.rejectCreate !== undefined) throw new Error(this.rejectCreate)
    if (this.createGate !== undefined) await this.createGate
    const session = Session.create(options.sessionId)
    const agentCtx = this.ctx.extend()
    const messages: UserMessage[] = []
    const cancels: unknown[] = []
    let turns = 0
    const close = (event: SessionEvent): void => {
      this.ctx.emit('session/event', session, event)
    }
    const nextTurn: UserMessage[] = []
    const nextStep: UserMessage[] = []
    const inbox: Inbox = {
      nextTurn,
      nextStep,
      clear(): void {
        nextTurn.length = 0
        nextStep.length = 0
      },
      append(target, message): void {
        (target === 'next-turn' ? nextTurn : nextStep).push(message)
      },
      prepend(target, message): void {
        (target === 'next-turn' ? nextTurn : nextStep).unshift(message)
      },
      replace(messageId, newMessage): boolean {
        const list = nextTurn.some(message => message.id === messageId) ? nextTurn : nextStep
        const index = list.findIndex(message => message.id === messageId)
        if (index < 0) return false
        list[index] = newMessage
        return true
      },
      remove(messageId): boolean {
        const list = nextTurn.some(message => message.id === messageId) ? nextTurn : nextStep
        const index = list.findIndex(message => message.id === messageId)
        if (index < 0) return false
        list.splice(index, 1)
        return true
      },
      splice(target, start, deleteCount, inserted): UserMessage[] {
        return (target === 'next-turn' ? nextTurn : nextStep).splice(start, deleteCount, ...inserted)
      },
    }
    /** Record one submitted message and publish its insertion as the live inbox does. */
    const inserted = (message: UserMessage): void => {
      messages.push(message)
      this.ctx.emit('agent/inbox/inserted', { agent, message })
    }
    const agent: Agent = {
      id: options.sessionId,
      session,
      ctx: agentCtx,
      options: options.agentOptions ?? {},
      inbox,
      status: 'idle',
      followup(message) {
        inserted(message)
      },
      send(message) {
        inserted(message)
      },
      inject(message) {
        inserted(message)
      },
      steer(message) {
        inserted(message)
      },
      cancel(cause) {
        cancels.push(cause)
      },
      whenIdle: async (): Promise<void> => {
        await this.idleGate
      },
      async runMaintenance(task) {
        return await task(new AbortController().signal)
      },
    }
    const recorded: StubRootAgent = {
      sessionId: options.sessionId,
      options,
      agent,
      messages,
      get prompts(): string[] {
        return messages.map(message => message.content
          .flatMap(block => block.type === 'text' ? [block.text] : [])
          .join(''))
      },
      cancels,
      reply(text: string): void {
        turns += 1
        const message = createAssistantMessage({
          content: [{ type: 'text', text }],
          source: { provider: 'stub-route', model: 'stub-model' },
        })
        close(session.append('assistant/message', { turn: turns, step: 1, message, stream: [] }, { surfaceOp: 'append' }))
        close(session.append('turn/end', { turn: turns, reason: { kind: 'completed' } }))
      },
      fail(message: string): void {
        turns += 1
        close(session.append('turn/end', { turn: turns, reason: { kind: 'error', error: { message, code: 'STUB' } } }))
      },
      closeSilently(): void {
        turns += 1
        close(session.append('turn/end', { turn: turns, reason: { kind: 'completed' } }))
      },
    }
    await options.setup?.(agentCtx, agent)
    this.liveAgents.set(String(options.sessionId), agent)
    this.created.push(recorded)
    return { agent, dispose: async () => {} }
  }
}
