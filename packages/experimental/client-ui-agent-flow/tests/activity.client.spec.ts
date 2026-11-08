import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { FlowNodeRun, FlowRun } from '@deepseek-ai/dsh-experimental-agent-flow/types'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { NodeActivityFold, waitsForUser } from '../src/client/activity.ts'

let seq = 0
beforeEach(() => { seq = 0 })
const stamp = (): { seq: ReturnType<typeof SessionSeq>; time: number } => {
  seq += 1
  return { seq: SessionSeq(seq), time: 1_000 + seq }
}

const turnStart = (turn: number): SessionEventLike => ({ ...stamp(), type: 'turn/start', data: { turn } })
const userMessage = (text: string): SessionEventLike => ({
  ...stamp(), type: 'user/message', data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), surfaceOp: 'append',
})
const stepStart = (turn: number, step: number): SessionEventLike => ({ ...stamp(), type: 'step/start', data: { turn, step } })
const requestContext = (): SessionEventLike => ({
  ...stamp(),
  type: 'request/context',
  data: { provider: 'mock', model: 'mock' },
})
const requestHeader = (): SessionEventLike => ({
  ...stamp(),
  type: 'request/header',
  data: { header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial' },
})
const assistantMessage = (turn: number, withTool: boolean): SessionEventLike => ({
  ...stamp(),
  type: 'assistant/message',
  data: {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: withTool
        ? [{ type: 'tool-call', id: ToolCallId('call-1'), name: 'read', arguments: '{}' }]
        : [{ type: 'text', text: 'done' }],
      source: { provider: 'mock', model: 'mock' },
    }),
    stream: [],
  },
  surfaceOp: 'append',
})
const toolCall = (callId: string, name: string): SessionEventLike => ({
  ...stamp(), type: 'tool/call', data: { turn: 1, step: 1, callId: ToolCallId(callId), name, arguments: '{}' },
})
const toolResult = (callId: string): SessionEventLike => ({
  ...stamp(),
  type: 'tool/result',
  data: {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId: ToolCallId(callId), isError: false, content: [{ type: 'text', text: 'ok' }] }),
  },
  surfaceOp: 'append',
})
const turnEnd = (turn: number): SessionEventLike => ({ ...stamp(), type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
const chunk = (kind: 'reasoning-delta' | 'text-delta' | 'tool-call-delta' | 'block-end-tool' | 'block-end-text', time: number): SessionEventLike => ({
  type: 'assistant/live-chunk',
  seq: SessionSeq(time),
  time,
  data: {
    attemptId: 'attempt-1' as never,
    turn: 1,
    step: 1,
    chunk: kind === 'tool-call-delta'
      ? { type: 'tool-call-delta', index: 0, id: ToolCallId('call-1'), argumentsDelta: '{' }
      : kind === 'block-end-tool'
        ? { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('call-1'), name: 'read', arguments: '{}' } }
        : kind === 'block-end-text'
          ? { type: 'block-end', index: 0, block: { type: 'text', text: 'x' } }
          : { type: kind, index: 0, text: 'x' },
  },
})

/** Fold one ordered feed. */
function fold(entries: readonly SessionEventLike[]): ReturnType<NodeActivityFold['activity']> {
  const state = new NodeActivityFold()
  for (const entry of entries) state.push(entry)
  return state.activity()
}

describe('NodeActivityFold', () => {
  it('reports nothing observed before the first entry', () => {
    expect(new NodeActivityFold().activity()).toEqual({ stage: 'unknown', tools: [], observed: false })
  })

  it('opens a turn as preparing and records its identity', () => {
    const activity = fold([turnStart(2)])
    expect(activity).toMatchObject({ stage: 'preparing', turn: 2, observed: true })
    expect(activity.lastAt).toBe(1_001)
  })

  it('needs a logged request before reading a step as awaiting a response', () => {
    expect(fold([turnStart(1), userMessage('go')]).stage).toBe('preparing')
    /* An input with no opened turn has no turn identity to report yet. */
    expect(fold([userMessage('go')]).turn).toBeUndefined()
    /* A step opens before it assembles anything: preparation, not a request. */
    expect(fold([turnStart(1), stepStart(1, 1)]).stage).toBe('preparing')
    /* The loop logs the resolved request immediately before the provider call. */
    expect(fold([turnStart(1), stepStart(1, 1), requestHeader()]).stage).toBe('awaiting-response')
    /* A context record alone updates the business clock, not the stage. */
    expect(fold([turnStart(1), requestContext()]).stage).toBe('preparing')
  })

  it('distinguishes reasoning, answer text, and generated tool calls', () => {
    expect(fold([turnStart(1), chunk('reasoning-delta', 2_000)])).toMatchObject({
      stage: 'reasoning',
      attemptId: 'attempt-1',
      lastAt: 2_000,
    })
    expect(fold([turnStart(1), chunk('text-delta', 2_000)]).stage).toBe('generating')
    expect(fold([turnStart(1), chunk('tool-call-delta', 2_000)]).stage).toBe('generating')
    /* A finished tool-call block is generated work; a text block adds nothing. */
    expect(fold([turnStart(1), chunk('block-end-tool', 2_000)]).stage).toBe('generating')
    expect(fold([turnStart(1), chunk('block-end-text', 2_000)]).stage).toBe('preparing')
  })

  it('keeps the stage when an attempt record arrives', () => {
    expect(fold([
      turnStart(1),
      chunk('reasoning-delta', 2_000),
      { ...stamp(), type: 'assistant/attempt', data: { turn: 1, step: 1, stream: [] } },
    ]).stage).toBe('reasoning')
  })

  it('keeps every running tool until its own result arrives', () => {
    const running = fold([turnStart(1), toolCall('call-1', 'read'), toolCall('call-2', 'grep')])
    expect(running.stage).toBe('tool')
    expect(running.tools).toEqual([{ callId: 'call-1', name: 'read' }, { callId: 'call-2', name: 'grep' }])

    /* One result must not clear a sibling call still running. */
    const afterFirst = fold([turnStart(1), toolCall('call-1', 'read'), toolCall('call-2', 'grep'), toolResult('call-1')])
    expect(afterFirst.stage).toBe('tool')
    expect(afterFirst.tools).toEqual([{ callId: 'call-2', name: 'grep' }])

    /* The last result leaves the loop preparing its next step; a request is
       not owed until one is logged. */
    const afterLast = fold([
      turnStart(1), toolCall('call-1', 'read'), toolCall('call-2', 'grep'), toolResult('call-1'), toolResult('call-2'),
    ])
    expect(afterLast.stage).toBe('preparing')
    expect(afterLast.tools).toEqual([])
  })

  it('separates a settled answer from a settled tool request', () => {
    /* An answer without tool calls leaves the loop preparing its next step. */
    expect(fold([turnStart(1), assistantMessage(1, false)]).stage).toBe('preparing')
    expect(fold([turnStart(1), assistantMessage(1, true)]).stage).toBe('tool')
  })

  it('closes the turn as finished without advancing its business time', () => {
    const activity = fold([turnStart(1), chunk('text-delta', 2_000), toolCall('call-1', 'read'), turnEnd(1)])
    expect(activity.stage).toBe('finished')
    expect(activity.tools).toEqual([])
    /* Business time is the newest model signal, not the turn close. */
    expect(activity.lastAt).toBe(2_000)
  })

  it('ignores event types it does not interpret', () => {
    expect(fold([turnStart(1), stepStart(1, 1), { ...stamp(), type: 'session/title', data: { title: 'x' } } as SessionEventLike]).stage)
      .toBe('preparing')
  })
})

const run = (status: FlowRun['status']): FlowRun => ({
  id: 'run-1' as FlowRun['id'],
  flowId: 'flow-1' as FlowRun['flowId'],
  snapshot: { id: 'flow-1' as FlowRun['flowId'], name: 'demo', maxIterations: 16, nodes: [], edges: [], createdAt: 'a', updatedAt: 'a' },
  parentSessionId: 'session-1' as FlowRun['parentSessionId'],
  status,
  input: 'go',
  nodeRuns: [],
  startedAt: '2026-11-04T00:00:00.000Z',
})
const entry = (status: FlowNodeRun['status']): FlowNodeRun => ({ nodeId: 'talk', iteration: 0, status })

describe('waitsForUser', () => {
  it('is false once the run or the node settled', () => {
    expect(waitsForUser(run('completed'), entry('conversing'), undefined)).toBe(false)
    expect(waitsForUser(run('running'), entry('succeeded'), undefined)).toBe(false)
    expect(waitsForUser(run('running'), undefined, undefined)).toBe(false)
  })

  it('treats a conversing node with no live Session as waiting for the user', () => {
    expect(waitsForUser(run('running'), entry('conversing'), undefined)).toBe(true)
    expect(waitsForUser(run('running'), entry('conversing'), { running: false, pendingSubmissions: 0, pendingInteraction: false, streamFailed: false })).toBe(true)
  })

  it('stops waiting as soon as the Session is working or the user submitted', () => {
    expect(waitsForUser(run('running'), entry('conversing'), { running: true, pendingSubmissions: 0, pendingInteraction: false, streamFailed: false })).toBe(false)
    expect(waitsForUser(run('running'), entry('conversing'), { running: false, pendingSubmissions: 1, pendingInteraction: false, streamFailed: false })).toBe(false)
  })

  it('waits while the model asked a question inside the open turn', () => {
    expect(waitsForUser(run('running'), entry('running'), { running: true, pendingSubmissions: 0, pendingInteraction: true, streamFailed: false })).toBe(true)
  })
})
