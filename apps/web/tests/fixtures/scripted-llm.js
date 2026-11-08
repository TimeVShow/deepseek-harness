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

/** A long Markdown deliverable for the results-page scenario (`[LONG]`). */
const LONG_MARKDOWN = [
  '# Long report',
  '',
  'The acceptance lane renders a document longer than one screen.',
  '',
  '## Requirements',
  '',
  '- the heading survives the compact result card',
  '- the list stays readable in a narrow window',
  '- the request toggle keeps working from the keyboard',
  '',
  '## Notes',
  '',
  'A paragraph long enough to wrap across several lines keeps the card honest: '.repeat(8),
  '',
  '```ts',
  'const answer = 42',
  '```',
].join('\n')

/** Reply text for one assembled request; parallel-safe because it reads only the request. */
function replyText(options, reviewCalls, roleRounds) {
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
  if (role === 'implement' && /\[ROUNDS\]/.test(joined)) {
    const key = `${caseId}:implement`
    const count = (roleRounds.get(key) ?? 0) + 1
    roleRounds.set(key, count)
    return { role, caseId, slow, text: `implement round ${count} for CASE:${caseId}` }
  }
  if (role === 'writer' && /\[SANDBOX\]/.test(joined)) {
    return hasToolResult(options)
      ? { role, caseId, text: 'writer created the upstream file\n[SANDBOX-ATTACK]' }
      : { role, caseId, toolCall: { name: 'bash', args: { command: "printf 'upstream-original' > original.txt", description: 'Create the upstream file' } } }
  }
  if (role === 'filer' && /\[FILES\]/.test(joined)) {
    const dir = /nowhere else:\n([^\n]+)/.exec(joined)?.[1]
    const mark = /\[MARK:([^\]\n]+)\]/.exec(joined)?.[1] ?? 'A'
    if (dir === undefined) return { role, caseId, text: 'filer could not locate its directory' }
    const toolResults = (options.messages ?? []).filter(message => message.role === 'tool').length
    if (toolResults === 0) {
      return {
        role,
        caseId,
        toolCall: {
          name: 'write',
          args: {
            file_path: `${dir}/RESULT.md`,
            content: `# RESULT ${mark}\n\nline two\nrun ${mark} line 3\nline four\n`,
            description: 'Write the result document',
          },
        },
      }
    }
    if (toolResults === 1) {
      return {
        role,
        caseId,
        toolCall: {
          name: 'write',
          args: {
            file_path: `${dir}/结果 报告.md`,
            content: `# 结果 ${mark}\n\n中文内容 ${mark}\n`,
            description: 'Write the localized report',
          },
        },
      }
    }
    if (toolResults === 2) {
      return {
        role,
        caseId,
        toolCall: {
          name: 'write',
          args: {
            file_path: `${dir}/notes.txt`,
            content: `line one\nline two\n${mark} line 3\nline four\n`,
            description: 'Write the plain-text notes',
          },
        },
      }
    }
    return { role, caseId, text: `wrote the result for ${mark}\n\n[line 3](./notes.txt:3)` }
  }
  if ((role === 'checker' || role === 'sandboxcheck') && /\[SANDBOX-(?:ATTACK|ENTRY)\]/.test(joined)) {
    const upstream = /\[UPSTREAM:([^\]\n]+)\]/.exec(joined)?.[1]
      ?? /Files:\n- (\/[^\n]+)/.exec(joined)?.[1]
    const dir = /nowhere else:\n([^\n]+)/.exec(joined)?.[1]
    if (upstream === undefined || dir === undefined) {
      return { role, caseId, text: `${role} could not locate the upstream paths` }
    }
    /* One refused write per request: a same-byte overwrite, a rewrite, a
       delete, a rename, a temp-file replacement, and a write through a symlink
       inside the node's own directory. Each prints STEP-DENIED only when the
       shell cannot perform it. */
    const steps = [
      `printf 'upstream-original' > "${upstream}" || echo STEP-DENIED`,
      `printf 'hacked' > "${upstream}" || echo STEP-DENIED`,
      `rm -f "${upstream}" || echo STEP-DENIED`,
      `mv "${upstream}" "${upstream}.moved" || echo STEP-DENIED`,
      `printf x > "${dir}/tmpfile" && mv "${dir}/tmpfile" "${upstream}" || echo STEP-DENIED`,
      `ln -sf "${upstream}" "${dir}/alias" && printf x > "${dir}/alias" || echo STEP-DENIED`,
    ]
    const toolResults = (options.messages ?? []).filter(message => message.role === 'tool').length
    if (toolResults < steps.length) {
      return {
        role,
        caseId,
        toolCall: { name: 'bash', args: { command: steps[toolResults], description: 'Attempt an upstream write' } },
      }
    }
    return {
      role,
      caseId,
      text: role === 'checker'
        ? 'checker finished with the upstream file'
        : 'reviewer finished with the upstream file\nResult: done',
    }
  }
  if (/\[LONG\]/.test(joined)) {
    /* Downstream nodes only see handoffs, so a `[ROUNDS]` flow carries the
       marker in the delivered text to give each implement round its own body. */
    const rounds = /\[ROUNDS\]/.test(joined) ? '\n\n[ROUNDS]' : ''
    return { role, caseId, slow, text: `${LONG_MARKDOWN}${rounds}` }
  }
  return { role, caseId, text: `${role} handled CASE:${caseId}`, slow }
}

/** Milliseconds between two streamed deltas of a `[SLOW]` reply. */
const SLOW_DELTA_MS = 400

export function apply(ctx) {
  const reviewCalls = new Map()
  /** Per CASE and role request count for `[ROUNDS]` replies. */
  const roleRounds = new Map()
  const released = new Set()
  const releaseWaiters = new Map()
  /** Model requests served per CASE; a node restart would add a request. */
  const requestCalls = new Map()
  /** Provider/model each request of a CASE actually resolved, in call order. */
  const requestRoutes = new Map()
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
  // Test control: release a `[HOLD]` request, count a CASE's model requests,
  // and read the provider/model each of those requests resolved.
  ctx.effect(() => ctx.provide('scriptedLlm', {
    release,
    calls: caseId => requestCalls.get(caseId) ?? 0,
    routes: caseId => requestRoutes.get(caseId) ?? [],
  }), 'scripted-llm: control')
  const adapter = {
    providerInfo: provider => ({ id: provider, name: 'DeepSeek' }),
    providerRetryPolicy: () => undefined,
    listModels: async provider => MODELS.map(model => ({ provider, ...model })),
    resolveModel: async (provider, model) => ({ provider, id: model, name: model }),
    prepareCall: async (provider, model) => ({
      model: { provider, id: model, name: model },
      stream: options => stream(options, { provider, model }),
    }),
  }
  /** One paused delta; an abort while paused ends the stream like the hold does. */
  const pause = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('scripted slow aborted')); return }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('scripted slow aborted')) }, { once: true })
  })
  async function* stream(options, route) {
    const reply = replyText(options, reviewCalls, roleRounds)
    requestCalls.set(reply.caseId, (requestCalls.get(reply.caseId) ?? 0) + 1)
    const routes = requestRoutes.get(reply.caseId) ?? []
    routes.push({ role: reply.role, provider: route.provider, model: route.model })
    requestRoutes.set(reply.caseId, routes)
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
    if (reply.toolCall !== undefined) {
      const args = JSON.stringify(reply.toolCall.args)
      const callId = `call_${reply.caseId}_${reply.role}`
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: callId, name: reply.toolCall.name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: reply.toolCall.name, arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
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
