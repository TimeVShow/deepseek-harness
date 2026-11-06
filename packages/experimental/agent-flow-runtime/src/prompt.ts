/**
 * Fixed prompt assembly for agent nodes and Result-line parsing for routing.
 * Node prompts are runtime-rendered from the document and upstream handoffs;
 * users never write prompt templates.
 * @module @deepseek-ai/dsh-experimental-agent-flow-runtime/src/prompt
 */

/** One upstream node's handoff as prompt input. */
export interface HandoffSource {
  /** Display name of the source node. */
  readonly name: string
  /** The source agent's final message. */
  readonly handoff: string
  /** Absolute paths the source execution produced. */
  readonly files: readonly string[]
}

/** Inputs to one node's fixed prompt assembly. */
export interface PromptInput {
  /** What this step does. */
  readonly instruction: string
  /**
   * Role text rendered ahead of the instruction. Only an interactive node
   * carries it here: a worker's persona reaches the model as a scoped
   * system-prompt section through the subagent seam, while a root Session has
   * no such seam.
   */
  readonly persona?: string | undefined
  /** Whether the node talks with the user across turns instead of running once. */
  readonly interactive?: boolean | undefined
  /** The run's original request, present only with an explicit input edge from `start`. */
  readonly userMessage?: string | undefined
  /** Task results handed off by execution edges and explicit input references. */
  readonly sources: readonly HandoffSource[]
  /** Absolute directory this execution writes into. */
  readonly dir: string
  /** Routing words of the node's outgoing edges; a Result line is required when non-empty. */
  readonly resultWords: readonly string[]
}

/** One assembled prompt plus the original request kept as a separate message. */
export interface ConversationPrompt {
  /** Runtime-owned instructions, role, handoffs, workspace, and routing. */
  readonly context: string
  /** The run's original request when an explicit start input selected it. */
  readonly request?: string | undefined
}

/** Sections before the optional user request. */
function leadSections(input: PromptInput): string[] {
  const sections: string[] = []
  if (input.persona !== undefined) sections.push(`## Your role\n${input.persona}`)
  sections.push(input.instruction)
  return sections
}

/** Sections after the optional user request. */
function tailSections(input: PromptInput): string[] {
  const sections: string[] = []
  for (const source of input.sources) {
    const files = source.files.length === 0
      ? 'No files.'
      : source.files.map(file => `- ${file}`).join('\n')
    sections.push(`## Handoff from ${source.name}\n${source.handoff}\n\nFiles:\n${files}`)
  }
  sections.push(`## Your workspace directory\nWrite every document you produce into this directory and nowhere else:\n${input.dir}`)
  if (input.interactive === true) {
    sections.push([
      '## Conversation',
      'You talk with the user directly in this session. Ask what you still need to know and wait for the answer.',
      'A message that still asks a question carries no Result line.',
      'When nothing is left ambiguous, ask the user plainly whether to start the rest of the work, and wait for the answer.',
      'Only after the user agrees, write the documents this step owes into your workspace directory and end that final message with the Result line below.',
    ].join('\n'))
  }
  if (input.resultWords.length > 0) {
    const words = input.resultWords.map(word => `"${word}"`).join(', ')
    sections.push(`## Routing\nEnd your final message with one line \`Result: <word>\` where <word> is exactly one of: ${words}.`)
  }
  return sections
}

/**
 * Assemble one worker node's single prompt from its instruction, selected
 * inputs, and output directory. Handoffs carry notes and absolute file paths,
 * never file contents.
 * @param input - instruction, role, selected inputs, output directory, and routing words.
 * @returns the complete prompt text.
 */
export function assemblePrompt(input: PromptInput): string {
  return [
    ...leadSections(input),
    ...input.userMessage === undefined ? [] : [`## User request\n${input.userMessage}`],
    ...tailSections(input),
  ].join('\n\n')
}

/**
 * Assemble an interactive node's opening context and keep the original request
 * as a separate user message, so chat shows runtime rules as context rather
 * than as the human's words.
 * @param input - instruction, role, selected inputs, output directory, and routing words.
 * @returns the runtime context and, when selected, the original request.
 */
export function assembleConversationPrompt(input: PromptInput): ConversationPrompt {
  return {
    context: [...leadSections(input), ...tailSections(input)].join('\n\n'),
    ...input.userMessage === undefined ? {} : { request: input.userMessage },
  }
}

const RESULT_RE = /^Result:\s*(.+?)\s*$/

/**
 * Instruction ending one interactive node's clarification on the user's behalf.
 * It names no Result word: the node's own prompt already fixed the vocabulary,
 * and repeating it here would let this text drift from the graph.
 */
export const CONCLUDE_PROMPT = [
  'The user ended the clarification, so ask nothing further.',
  'Write any document this step still owes into your workspace directory, then end your final message with the Result line.',
].join(' ')

/**
 * Parse the Result word from the last non-empty line of one handoff.
 * @param handoff - final assistant message of one execution.
 * @returns the word, or undefined when the last line declares none.
 */
export function parseResult(handoff: string): string | undefined {
  const last = handoff.split('\n').map(line => line.trim()).filter(line => line !== '').at(-1)
  if (last === undefined) return undefined
  return RESULT_RE.exec(last)?.[1]
}
