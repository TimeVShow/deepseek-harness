/**
 * Deterministic subagent provider double for Agent Flow runtime tests. It
 * scripts one outcome per `start` call (a list of outcomes for a looping
 * node), records every request, tracks concurrency, writes the files a real
 * agent would produce into the workspace directory named by its prompt, and
 * honours the run signal the way a real provider does: an aborted request
 * settles as `aborted` instead of hanging on its gate.
 * @module
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ResolvedSubagentStartRequest, SubagentProvider, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'

/** Outcome scripts keyed by the node label the executor sends (`node.title ?? node.id`). */
export type StubScripts = Readonly<Record<string, StubScript | StubScript[]>>

/** One scripted node-agent outcome. */
export interface StubScript {
  /** Final assistant text. */
  text?: string
  /** Stop reason; defaults to `completed`. */
  stopReason?: SubagentResult['stopReason']
  /** Provider diagnostic carried by a non-`completed` result. */
  diagnostic?: string
  /** Gate the result until the test resolves it. */
  gate?: Promise<void>
  /** Reject the start call itself, as an infrastructure fault. */
  rejectStart?: string
  /** Reject the start call with a non-Error value. */
  rejectStartValue?: unknown
  /** Exact assistant blocks to return instead of a single text block. */
  blocks?: ContentBlock[]
  /** Files to write into the prompt's workspace directory, relative path to content. */
  writes?: Record<string, string>
  /** Make disposal reject, as a failing cleanup. */
  failDispose?: boolean
  /** Delay before the result settles, to observe concurrency. */
  delayMs?: number
}

/** Resolve when the signal aborts; never resolves otherwise. */
function aborted(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return }
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

/** Extract the workspace directory the runtime prompt assigns to the node agent. */
function workspaceDir(request: ResolvedSubagentStartRequest): string {
  const text = request.prompt.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  const dir = /nowhere else:\n([^\n]+)/.exec(text)?.[1]
  if (dir === undefined) throw new Error('stub provider found no workspace directory in the prompt')
  return dir
}

/** Scripted provider: a plain script repeats; a list script is consumed in order. */
export interface RecordedRequest extends ResolvedSubagentStartRequest {
  /** Node label the runtime sent in the activation spec. */
  readonly label: string
}

export class StubProvider implements SubagentProvider {
  readonly capabilities = {
    agentOptions: true,
    agentPreset: false,
    outputSchema: true,
    depthLimit: true,
  }
  readonly inheritsParentContext = false

  /** Every accepted start request, in call order. */
  readonly requests: RecordedRequest[] = []
  /** Identities of disposed runs. */
  readonly disposed: SessionId[] = []
  /** Identities of runs whose signal aborted. */
  readonly aborted: SessionId[] = []
  /** Highest number of simultaneously active runs observed. */
  maxConcurrent = 0

  private active = 0
  private readonly consumed = new Map<string, number>()

  constructor(readonly name = 'stub', private readonly scripts: StubScripts = {}) {}

  /** The next scripted outcome for one label; a single script object repeats forever. */
  private script(label: string): StubScript {
    const entry = this.scripts[label] ?? {}
    if (!Array.isArray(entry)) return entry
    const index = this.consumed.get(label) ?? 0
    this.consumed.set(label, index + 1)
    const script = entry[index]
    if (script === undefined) throw new Error(`stub script for "${label}" exhausted after ${entry.length} calls`)
    return script
  }

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    /* The manager forwards the activation label on the provider request even
       though the public request type omits it. */
    const label = (request as ResolvedSubagentStartRequest & { readonly label?: string }).label ?? ''
    const script = this.script(label)
    if (script.rejectStart !== undefined) throw new Error(script.rejectStart)
    if (script.rejectStartValue !== undefined) throw script.rejectStartValue
    this.requests.push({ ...request, label })
    const id = SessionId(`child-${this.requests.length}`)
    this.active += 1
    this.maxConcurrent = Math.max(this.maxConcurrent, this.active)
    const signal = request.signal
    const result = (async (): Promise<SubagentResult> => {
      try {
        if (script.gate !== undefined) await Promise.race([script.gate, aborted(signal)])
        if (script.delayMs !== undefined) await new Promise(resolve => setTimeout(resolve, script.delayMs))
        if (signal.aborted) {
          this.aborted.push(id)
          return { output: [], stopReason: 'aborted' }
        }
        if (script.writes !== undefined) {
          const dir = workspaceDir(request)
          for (const [name, content] of Object.entries(script.writes)) {
            const path = join(dir, name)
            await mkdir(dirname(path), { recursive: true })
            await writeFile(path, content)
          }
        }
        return {
          output: script.blocks ?? [{ type: 'text', text: script.text ?? '' }],
          ...script.diagnostic === undefined ? {} : { diagnostic: script.diagnostic },
          stopReason: script.stopReason ?? 'completed',
        }
      } finally {
        this.active -= 1
      }
    })()
    return {
      id,
      result,
      dispose: async () => {
        this.disposed.push(id)
        if (script.failDispose === true) throw new Error('disposal failed')
      },
    }
  }
}
