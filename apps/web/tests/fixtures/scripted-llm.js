/**
 * Scripted DeepSeek wire for the L1 Agent Flow acceptance lane. It serves the
 * real `deepseek-official` provider route with the shipped DeepSeek model ids,
 * so templates, the model catalog, and Session metadata name DeepSeek models
 * while the shipped agent loop, tools, Session log, and flow scheduler run
 * unchanged: replies stay deterministic, carrying the request's CASE marker,
 * with the node role read from the template persona deciding the wording.
 */

export const name = 'scripted-llm'
export const inject = ['llm']

/** DeepSeek routes advertised by the scripted wire; ids match the shipped catalog. */
const MODELS = [
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
  { id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' },
]

/** Whether the assembled request already carries a tool result (a follow-up step). */
function hasToolResult(options) {
  return (options.messages ?? []).some(message => message.role === 'tool')
}

/** Reply text for one assembled request; parallel-safe because it reads only the request. */
function replyText(options, reviewCalls) {
  const texts = []
  for (const message of options.messages ?? []) {
    if (typeof message.content === 'string') texts.push(message.content)
    else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block && block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
      }
    }
  }
  const joined = texts.join('\n')
  const caseId = /\[?CASE:([A-Za-z0-9_-]+)\]?/.exec(joined)?.[1] ?? 'NO-CASE'
  const role = /ROLE:([a-z0-9-]+)/.exec(joined)?.[1] ?? 'worker'
  if (/\[HOLD\]/.test(joined)) return { role, caseId, hold: true }
  /* `[SLOW]` keeps the reply in the model context, so every round of that
     conversation streams as real multi-second activity instead of one chunk. */
  const slow = /\[SLOW\]/.test(joined)
  if (role === 'clarify') {
    // Multi-round clarification: keep the conversation open until the user
    // confirms; only then state the closing Result word. The round counts the
    // human messages the model sees, so every reply is uniquely addressable.
    const rounds = (options.messages ?? []).filter(message => message.role === 'user'
      && (message.source?.kind ?? 'user') === 'user').length
    const done = /READY-TO-PROCEED/.test(joined)
    return {
      role,
      caseId,
      slow,
      // The first slow request of each turn calls one harmless tool after its
      // reasoning block; the follow-up request carrying the tool result
      // answers in text, so the card shows a real tool run as well.
      tool: slow && !hasToolResult(options),
      text: done
        ? `clarify CASE:${caseId} round ${rounds} confirmed\nResult: done`
        : `clarify CASE:${caseId} round ${rounds} needs more detail`,
    }
  }
  if (role === 'review') {
    const count = (reviewCalls.get(caseId) ?? 0) + 1
    reviewCalls.set(caseId, count)
    return { role, caseId, slow, text: `${role} on CASE:${caseId} round ${count}\nResult: ${count === 1 ? 'rework' : 'approved'}` }
  }
  return { role, caseId, text: `${role} handled CASE:${caseId}`, slow }
}

/** Milliseconds between two streamed deltas of a `[SLOW]` reply. */
const SLOW_DELTA_MS = 400

export function apply(ctx) {
  const reviewCalls = new Map()
  const released = new Set()
  const releaseWaiters = new Map()
  /** Model requests served per CASE; a node restart would add a request. */
  const requestCalls = new Map()
  /** Let one CASE's held request finish. */
  const release = (caseId) => {
    released.add(caseId)
    for (const resolve of releaseWaiters.get(caseId) ?? []) resolve()
    releaseWaiters.delete(caseId)
  }
  const nextRelease = (caseId) => new Promise((resolve) => {
    const waiters = releaseWaiters.get(caseId) ?? []
    waiters.push(resolve)
    releaseWaiters.set(caseId, waiters)
  })
  // Test control: release a `[HOLD]` request and count a CASE's model requests.
  ctx.effect(() => ctx.provide('scriptedLlm', { release, calls: caseId => requestCalls.get(caseId) ?? 0 }), 'scripted-llm: control')
  const adapter = {
    providerInfo: provider => ({ id: provider, name: 'DeepSeek' }),
    providerRetryPolicy: () => undefined,
    listModels: async provider => MODELS.map(model => ({ provider, ...model })),
    resolveModel: async (provider, model) => ({ provider, id: model, name: model }),
    prepareCall: async (provider, model) => ({
      model: { provider, id: model, name: model },
      stream: options => stream(options),
    }),
  }
  /** One paused delta; an abort while paused ends the stream like the hold does. */
  const pause = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('scripted slow aborted')); return }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('scripted slow aborted')) }, { once: true })
  })
  async function* stream(options) {
    const reply = replyText(options, reviewCalls)
    requestCalls.set(reply.caseId, (requestCalls.get(reply.caseId) ?? 0) + 1)
    if (reply.hold === true && !released.has(reply.caseId)) {
      const outcome = await Promise.race([
        new Promise((resolve) => {
          if (options.signal?.aborted) resolve('aborted')
          else options.signal?.addEventListener('abort', () => resolve('aborted'), { once: true })
        }),
        nextRelease(reply.caseId).then(() => 'released'),
      ])
      if (outcome === 'aborted') {
        // The runtime normalizes a throw while the signal is aborted into the
        // terminal `aborted` finish, exactly like a provider reporting abort.
        throw new Error('scripted hold aborted')
      }
    }
    const text = reply.text ?? `${reply.role} handled CASE:${reply.caseId}`
    if (reply.slow === true) {
      // A short reasoning block first, then the answer in delayed deltas: the
      // progress card reads these as the real Reasoning and Writing stages.
      const thought = `thinking about CASE:${reply.caseId}`
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      for (const part of thought.match(/.{1,12}/g) ?? []) {
        await pause(SLOW_DELTA_MS, options.signal)
        yield { type: 'reasoning-delta', index: 0, text: part }
      }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: thought } }
      if (reply.tool === true) {
        // One tool-call step against the lane's slow fixture tool, then the
        // loop's follow-up request answers in text.
        const callId = `call_slow_${reply.caseId}`
        const args = JSON.stringify({ text: `tool ran for CASE:${reply.caseId}` })
        yield { type: 'block-start', index: 1, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 1, id: callId, name: 'slow_echo', argumentsDelta: args }
        yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: callId, name: 'slow_echo', arguments: args } }
        yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 1, blockType: 'text' }
      for (const part of text.match(/.{1,5}/g) ?? []) {
        await pause(SLOW_DELTA_MS, options.signal)
        yield { type: 'text-delta', index: 1, text: part }
      }
      yield { type: 'block-end', index: 1, block: { type: 'text', text } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    }
    yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['deepseek-official'], adapter), 'scripted-llm: adapter')
}
