/**
 * Live activity for one node execution's Session: which phase the agent is in
 * right now, when it last produced a real business signal, and whether the run
 * is genuinely waiting for the user. Everything here folds the client's own
 * ordered event feed — durable session events plus transient assistant chunks —
 * so no second stream protocol exists and no reasoning text is copied. A
 * surface renders the stage and the age; the text itself stays in the Session
 * view that already owns it.
 * @module
 */

import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
import type { FlowNodeRun, FlowRun } from '@deepseek-ai/dsh-experimental-agent-flow/types'

/** What one node execution's Session is doing right now. */
export type NodeStage =
  /** A turn or step opened, or its last step settled, before a request exists. */
  | 'preparing'
  /** The request is assembled and logged, and no output has arrived yet. */
  | 'awaiting-response'
  /** Reasoning deltas are arriving. */
  | 'reasoning'
  /** Answer text or a tool call is being generated. */
  | 'generating'
  /** At least one tool call is running. */
  | 'tool'
  /** The Session is idle and the run needs the user's reply. */
  | 'waiting-user'
  /** The last observed turn closed. */
  | 'finished'
  /** Nothing observed yet, or the feed closed before any signal. */
  | 'unknown'

/** One node Session's current activity, as a surface renders it. */
export interface NodeActivity {
  readonly stage: NodeStage
  /** Epoch ms of the newest business signal; absent before any arrives. */
  readonly lastAt?: number | undefined
  /** Turn the stage belongs to, when the feed has opened one. */
  readonly turn?: number | undefined
  /** Attempt identity of the newest streamed output. */
  readonly attemptId?: string | undefined
  /** Tool calls still running, in call order. */
  readonly tools: readonly { readonly callId: string; readonly name: string }[]
  /** Whether any signal has been observed at all. */
  readonly observed: boolean
}

/** The activity before any event arrives. */
const UNKNOWN: NodeActivity = { stage: 'unknown', tools: [], observed: false }

/**
 * Incremental fold over one Session's ordered feed. Push entries as they
 * arrive and read {@link activity}; cost is constant per entry, so a long
 * reasoning stream never rescans history or retains its text.
 */
export class NodeActivityFold {
  private stage: NodeStage = 'unknown'
  private lastAt: number | undefined
  private turn: number | undefined
  private attemptId: string | undefined
  private readonly tools = new Map<string, string>()
  private observed = false

  /**
   * Fold one durable event or transient assistant chunk.
   * @param entry - next entry in the Session's ordered feed.
   */
  push(entry: SessionEventLike): void {
    if (entry.type === 'assistant/live-chunk') {
      const { chunk, attemptId, turn } = entry.data
      this.observed = true
      this.touch(entry.time)
      this.attemptId = String(attemptId)
      this.turn = turn
      if (chunk.type === 'reasoning-delta') this.stage = 'reasoning'
      else if (chunk.type === 'text-delta' || chunk.type === 'tool-call-delta') this.stage = 'generating'
      else if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') this.stage = 'generating'
      return
    }
    const event = entry
    switch (event.type) {
      case 'turn/start':
        this.observed = true
        this.stage = 'preparing'
        this.turn = event.data.turn
        this.attemptId = undefined
        this.tools.clear()
        this.touch(event.time)
        return
      case 'user/message':
      case 'step/start':
        /* Input arriving or a step opening is preparation: neither proves a
           request exists, and a step may assemble several things first. */
        this.observed = true
        this.stage = 'preparing'
        this.touch(event.time)
        return
      case 'request/header':
        /* The loop logs the resolved request immediately before the provider
           call; this is the last evidence that a request exists. */
        this.observed = true
        this.stage = 'awaiting-response'
        this.touch(event.time)
        return
      case 'request/context':
      case 'assistant/attempt':
        this.touch(event.time)
        return
      case 'assistant/message':
        this.observed = true
        this.touch(event.time)
        this.turn = event.data.turn
        /* The attempt settled: requested tool calls start next, and otherwise
           the loop is preparing its next step or closing the turn. */
        this.stage = event.data.message.content.some(block => block.type === 'tool-call') ? 'tool' : 'preparing'
        return
      case 'tool/call':
        this.observed = true
        this.stage = 'tool'
        this.tools.set(String(event.data.callId), event.data.name)
        this.touch(event.time)
        return
      case 'tool/result':
        this.observed = true
        this.tools.delete(String(event.data.message.toolCallId))
        /* The last tool settles into the next step's preparation; a request is
           not owed until one is logged. */
        if (this.tools.size === 0) this.stage = 'preparing'
        this.touch(event.time)
        return
      case 'turn/end':
        this.observed = true
        this.stage = 'finished'
        this.turn = event.data.turn
        this.tools.clear()
        return
      default:
        /* A merge-extensible event type this fold does not interpret. */
        return
    }
  }

  /** Advance the business clock monotonically; an older frame never regresses it. */
  private touch(time: number): void {
    this.lastAt = Math.max(this.lastAt ?? time, time)
  }

  /**
   * Read the fold's current activity.
   * @returns the stage, its business timestamp, and the open tool calls.
   */
  activity(): NodeActivity {
    const lastAt = this.lastAt
    /* v8 ignore next 2 -- `observed` is only set by the cases that touch the clock. */
    if (!this.observed || lastAt === undefined) return UNKNOWN
    return {
      stage: this.stage,
      lastAt,
      ...this.turn === undefined ? {} : { turn: this.turn },
      ...this.attemptId === undefined ? {} : { attemptId: this.attemptId },
      tools: [...this.tools].map(([callId, name]) => ({ callId, name })),
      observed: true,
    }
  }
}

/** Live state one retained node Session contributes to the waiting decision. */
export interface LiveSessionState {
  /** Whether the Session's Agent is working right now. */
  readonly running: boolean
  /** Submissions the user made that have not landed yet. */
  readonly pendingSubmissions: number
  /** Whether the model asked a question inside the open turn. */
  readonly pendingInteraction: boolean
  /** Whether the Session's own follow stream failed, so its feed is stale. */
  readonly streamFailed: boolean
}

/**
 * Whether the run is genuinely blocked on the user. The record's `conversing`
 * state is only the fallback: it flips at turn close, so a live Session still
 * working — or a submission that has not landed — means the run is not waiting.
 * @param run - run record being rendered.
 * @param entry - the conversational node's latest execution, when it has one.
 * @param live - live state of that node's Session, when this client retains it.
 * @returns true only when the user's reply is what unblocks the run.
 */
export function waitsForUser(
  run: FlowRun,
  entry: FlowNodeRun | undefined,
  live: LiveSessionState | undefined,
): boolean {
  if (run.status !== 'running' || entry === undefined) return false
  if (entry.status !== 'conversing' && entry.status !== 'running') return false
  if (live?.pendingInteraction === true) return true
  if (live !== undefined && (live.running || live.pendingSubmissions > 0)) return false
  return entry.status === 'conversing'
}
