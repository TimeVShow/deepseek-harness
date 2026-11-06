/**
 * Root-session conversation for one interactive node. A worker node stays a
 * one-shot subagent child; the node that talks to the user cannot, because only
 * a runtime root owns a writable composer and may ask the user a question. This
 * module materializes that root: an ordinary Session, published beside the run's
 * parent and titled after its node, which the runtime opens with the assembled
 * prompt and then only observes. Every later turn is the user's own reply, and
 * the node settles when a turn's final message carries its Result word.
 *
 * The created handle is never disposed: like a webhook-created Session, the
 * conversation is an ordinary Session that outlives the run and stays readable.
 * @module @deepseek-ai/dsh-experimental-agent-flow-runtime/src/conversation
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelection, ModelSelectionRef, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, type ContentBlock, type MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-session-title'
import { AssistantOutputFold } from '@deepseek-ai/dsh-subagent'
import type { AgentTemplate } from '@deepseek-ai/dsh-experimental-agent-flow'
import type { ConversationPrompt } from './prompt.ts'
import type {} from '@deepseek-ai/dsh-workspace'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Runtime-owned Agent Flow instructions delivered as model context. */
    'agent-flow': { kind: 'agent-flow' }
  }
}

/** Submits one runtime-owned message into a conversation the run opened. */
export type ConversationSubmit = (text: string) => void

/** Inputs materializing one interactive node's conversation. */
export interface ConversationRequest {
  /** Agent whose composition the conversation joins and whose workspace it enters. */
  readonly parent: Agent
  /** Session-list title, taken from the node. */
  readonly title: string
  /** Runtime context and the optional original request, delivered separately. */
  readonly prompt: ConversationPrompt
  /** Workspace directory the conversation runs in. */
  readonly cwd: string
  /** Provider route and model every request in the conversation uses. */
  readonly route: ModelSelection
  /** Run cancellation: aborting it stops the live turn and ends every wait. */
  readonly signal: AbortSignal
  /** Where the run records the live conversation so a caller can end it early. */
  readonly seat: ConversationSeat
}

/**
 * One run's registration of the conversation it is driving. A run carries at
 * most one conversational node, so one slot suffices.
 */
export interface ConversationSeat {
  /**
   * Record how the run can still address its conversation.
   * @param submit - delivers one runtime-owned message into the Session.
   */
  publish(submit: ConversationSubmit): void
  /** Clear the record; clearing an empty slot is a no-op. */
  withdraw(): void
}

/** One closed turn of the conversation. */
export interface ConversationTurn {
  /** Final assistant output the turn produced; empty when it produced none. */
  readonly output: readonly ContentBlock[]
  /** Why the turn closed, or `undefined` when the wait ended without a turn. */
  readonly reason: TurnEndReason | undefined
}

/**
 * Resolve the route one interactive Session requests with: the deployment
 * default, with a template's provider or model override on top. An override
 * drops the default's reasoning effort so the selected model resolves its own.
 * @param defaults - deployment default selection.
 * @param template - the node's agent template.
 * @returns the complete route for the conversation.
 */
export function conversationRoute(defaults: ModelSelection, template: AgentTemplate): ModelSelection {
  const { provider, model } = template
  if (provider === undefined && model === undefined) return defaults
  const { reasoningEffort: _inheritedEffort, ...route } = defaults
  return {
    ...route,
    ...provider === undefined ? {} : { provider },
    ...model === undefined ? {} : { model },
  }
}

/**
 * One interactive node's conversation. Observation starts at construction and
 * ends at {@link close}; between them every event the Session logs is folded
 * into the canonical final-assistant selection the subagent seam also applies,
 * so a turn that closes before the runtime starts waiting is never lost.
 */
export class Conversation {
  /** Identity of the materialized root Session. */
  readonly sessionId: SessionId

  private readonly fold = new AssistantOutputFold()
  private readonly turns: ConversationTurn[] = []
  /** Identities of the messages this runtime submitted; the lock admits exactly these. */
  private readonly admitted = new Set<MessageId>()
  private readonly stopObserving: () => void
  private live: Agent | undefined
  private stopAbort: (() => void) | undefined
  private consumed = 0
  private locked = false
  private cancelIssued = false
  private wake: (() => void) | undefined

  /**
   * Start observing the Session this instance is about to mint, so no event of
   * it can precede the observation.
   * @param ctx - runtime plugin context owning the observation registration.
   * @param request - parent, title, opening prompt, workspace, route, and cancellation.
   */
  constructor(private readonly ctx: Context, private readonly request: ConversationRequest) {
    this.sessionId = brandString<SessionId>(`flow-${randomUUID()}`)
    this.stopObserving = this.ctx.on('session/event', (session, event) => {
      if (session.id === this.sessionId) this.observe(event)
    })
  }

  /**
   * Materialize the Session, publish it beside the run's parent, and submit the
   * opening prompt. Resolves once the prompt is queued; the turn itself settles
   * through {@link awaitTurn}. If the run is cancelled before or during
   * publication, no opening prompt is submitted, and a cancellation raised by
   * the opening messages' own events keeps the remaining one out of the inbox.
   */
  async open(): Promise<void> {
    const selection: ModelSelectionRef = { current: this.request.route, assembled: undefined }
    const parent = this.request.parent
    const { agent } = await this.ctx.agents.create({
      sessionId: this.sessionId,
      signal: this.request.signal,
      meta: { cwd: this.request.cwd },
      agentOptions: this.request.route,
      setup: (agentCtx) => {
        // A root Session joined to no preset sees an empty tool registry in an
        // agent-plane composition, so it takes the run's parent composition.
        agentCtx.get('agentPresets')?.composeFrom(agentCtx, parent.ctx)
        installModelSelection(agentCtx, selection)
        agentCtx.on('agent/pre-step', async ({ messages }, next): Promise<PreStepDecision> => {
          const decision = await next()
          if (decision.kind === 'reject' || !this.locked) return decision
          // Only a human prompt this runtime did not submit is refused; injected
          // context and the run's own messages keep flowing.
          const refused = messages.some(message => message.source.kind === 'user' && !this.admitted.has(message.id))
          return refused ? { kind: 'reject' } : decision
        })
      },
    })
    this.live = agent
    if (this.request.signal.aborted) {
      // Creation can finish after the caller aborted; adding a listener now
      // would never fire, so cancel the just-created Agent directly.
      this.cancelIssued = true
      this.cancelLive(agent)
      return
    }
    const onAbort = (): void => {
      this.cancelIssued = true
      this.cancelLive(agent)
      this.release()
    }
    this.stopAbort = (): void => { this.request.signal.removeEventListener('abort', onAbort) }
    this.request.signal.addEventListener('abort', onAbort, { once: true })
    this.request.seat.publish((text) => { this.submit(agent, text, 'agent-flow', 'followup') })
    await this.announce(agent)
    if (this.cancelled()) return
    /* Inject the rules as next-step context, then wake with the human request
       when one is wired, so both reach the opening turn. */
    if (this.request.prompt.request === undefined) {
      this.submit(agent, this.request.prompt.context, 'agent-flow', 'followup')
    } else {
      this.submit(agent, this.request.prompt.context, 'agent-flow', 'inject')
      this.submit(agent, this.request.prompt.request, 'user', 'followup')
    }
  }

  /**
   * Wait for this call's own turn to close and select its final assistant
   * output: the first call takes the opening turn, each later call the next one.
   * A turn that already closed before the wait began is returned rather than
   * lost. The wait ends without a turn when the run is cancelled.
   * @returns the closed turn's output and reason.
   */
  async awaitTurn(): Promise<ConversationTurn> {
    const wanted = this.consumed + 1
    while (this.turns.length < wanted && !this.request.signal.aborted) {
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
    const closed = this.turns[wanted - 1]
    if (closed === undefined) return { output: [], reason: undefined }
    this.consumed = wanted
    return closed
  }

  /**
   * Cancel this conversation's activity only while its Agent is still live.
   * A disposed Agent keeps no loop or inbox projection, and cancellation is
   * the documented no-op there; reading the released projection would report a
   * lifecycle fault for work that already ended.
   */
  private cancelLive(agent: Agent): void {
    const registry = this.ctx.get('agents')
    if (registry?.get(this.sessionId) !== agent) return
    agent.cancel({ kind: 'user' })
  }

  /**
   * Stop observing the Session and refuse later human input. The Session itself
   * stays live and readable; the run is simply done talking through it.
   */
  close(): void {
    this.locked = true
    this.request.seat.withdraw()
    this.stopObserving()
    this.stopAbort?.()
    this.stopAbort = undefined
  }

  /**
   * Stop runtime-owned work left in the live Agent and wait for quiescence, so
   * no run terminal record publishes while a turn or tool it still owns runs.
   * This covers three exits: cancellation, a failure after the Session opened,
   * and a Result that closed while a runtime-queued follow-up was accepted.
   * The Session itself stays live; only its remaining work is cancelled.
   */
  async settle(): Promise<void> {
    const live = this.live
    if (live === undefined) return
    if (!this.cancelIssued) {
      this.cancelIssued = true
      this.cancelLive(live)
    }
    await live.whenIdle()
  }

  /**
   * Queue one runtime-owned message as its own turn. Queuing refuses once the
   * run is cancelled, because a submission's own events can cancel it: a
   * listener of the inserted message may cancel this run synchronously, and a
   * message queued after that would wake a turn nothing owns. Cancellation also
   * clears the messages already waiting, so the refusal is the only way to keep
   * the opening request out of a cancelled conversation.
   * @param agent - the conversation's live agent.
   * @param text - message text.
   * @param source - `agent-flow` for runtime rules, `user` for the human request.
   * @param mode - inject the next step without waking, or open a follow-up turn.
   */
  private submit(agent: Agent, text: string, source: 'agent-flow' | 'user', mode: 'inject' | 'followup'): void {
    if (this.cancelled()) return
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: source === 'user' ? { kind: 'user' } : { kind: 'agent-flow' },
    })
    this.admitted.add(message.id)
    if (mode === 'inject') agent.inject(message)
    else agent.followup(message)
  }

  /** Read cancellation afresh: the run's signal, or a cancel this instance issued. */
  private cancelled(): boolean {
    return this.cancelIssued || this.request.signal.aborted
  }

  /** Fold one event of the observed Session and record each turn that closes. */
  private observe(event: SessionEvent): void {
    this.fold.push(event)
    if (event.type !== 'turn/end') return
    this.turns.push({ output: this.fold.collect() ?? [], reason: event.data.reason })
    this.release()
  }

  /** Release a pending turn wait, when one is pending. */
  private release(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  /** List the Session in the run's workspace and title it after its node. */
  private async announce(agent: Agent): Promise<void> {
    const registry = this.ctx.get('workspaceRegistry')
    const parentSessionId = this.request.parent.session.id
    const workspace = registry?.list().find(candidate => candidate.sessionIds.includes(parentSessionId))
    await workspace?.attachSession(this.sessionId)
    this.ctx.get('sessionTitle')?.rename(agent.session, this.request.title)
  }
}
