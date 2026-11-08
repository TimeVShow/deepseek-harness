/**
 * Executes fixed graphs with all-predecessor scheduling and bounded serial
 * review loops. Execution edges carry task results; input edges reference
 * existing results without scheduling work. Each loop iteration consumes fresh
 * internal arrivals while retaining its completed external dependencies.
 * @module @deepseek-ai/dsh-experimental-agent-flow-runtime/src/executor
 */

import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  AgentTemplate,
  ExecutionLoop,
  FlowDocument,
  FlowEdge,
  FlowExecutionResult,
  FlowExecutor,
  FlowNode,
  FlowNodeRun,
  FlowNodeRunPatch,
  FlowRunController,
  FlowRunId,
} from '@deepseek-ai/dsh-experimental-agent-flow'
import { analyzeExecutionGraph } from '@deepseek-ai/dsh-experimental-agent-flow'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'
import { Conversation, conversationRoute, type ConversationSeat, type ConversationSubmit } from './conversation.ts'
import { assembleConversationPrompt, assemblePrompt, CONCLUDE_PROMPT, parseResult, type ConversationPrompt } from './prompt.ts'

/** Executor settings resolved once from plugin configuration. */
export interface ExecutorSettings {
  /** Registry name this executor registers under. */
  executor: string
  /** Subagent provider name used for node agents. */
  provider: string
  /** Maximum concurrently running node agents. */
  maxConcurrentAgents: number
  /** Maximum turns one interactive node may take before its run fails. */
  maxConversationTurns: number
}

const AGENT_KIND = 'agent'
const CONDITION_KIND = 'condition'
const START_KIND = 'start'

/** A node's next iteration could not be appended, so no fresh record exists. */
class IterationRecordUnavailable extends Error {
  /**
   * @param nodeId - node whose iteration record was refused.
   * @param iteration - iteration number that was being appended.
   * @param message - the persistence failure.
   */
  constructor(readonly nodeId: string, readonly iteration: number, message: string) {
    super(message)
  }
}

/** Completion word an interactive node owes when no condition node routes it. */
const INTERACTIVE_DONE = 'done'

/** Surface one error's message without assuming it is an `Error`. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Join the text blocks of one assistant output. */
function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/** List every regular file under one directory recursively, as absolute paths. */
async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort()
}

/** Project one template's route overrides onto the subagent start options. */
function agentOptionsOf(template: AgentTemplate): AgentOptions | undefined {
  const { provider, model } = template
  if (provider === undefined && model === undefined) return undefined
  return {
    ...provider === undefined ? {} : { provider },
    ...model === undefined ? {} : { model },
  }
}

/** FIFO concurrency slots bounding concurrent node agents. */
class SlotPool {
  private active = 0
  private readonly waiters: (() => void)[] = []

  constructor(private readonly limit: number) {}

  /** Acquire one slot, waiting in FIFO order when the pool is full. */
  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1
      return
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.active += 1
        resolve()
      })
    })
  }

  /** Release one slot to the next waiter, when one exists. */
  release(): void {
    this.active -= 1
    this.waiters.shift()?.()
  }
}

/** One succeeded agent execution's handoff, kept for downstream prompts. */
interface NodeHandoff {
  readonly handoff: string
  readonly files: string[]
  /** Result word the execution emitted; present when a condition node routes it. */
  readonly result?: string | undefined
}

/** One task execution's own output, preserved through transparent control nodes. */
interface TaskHandoff extends NodeHandoff {
  readonly nodeId: string
  readonly iteration: number
}

type ArrivalState = 'waiting' | 'arrived' | 'consumed' | 'skipped'

/** One graph execution: node scheduling, node-agent driving, and settlement. */
class GraphRun {
  private readonly document: FlowDocument
  private readonly loops: readonly ExecutionLoop[]
  private readonly loopRounds = new Map<string, number>()
  private readonly loopDependencies = new Map<string, readonly TaskHandoff[]>()
  private readonly statuses = new Map<string, FlowNodeRun['status']>()
  private readonly incoming = new Map<string, number[]>()
  private readonly outgoing = new Map<string, number[]>()
  private readonly arrivals = new Map<number, ArrivalState>()
  private readonly edgeResults = new Map<number, readonly TaskHandoff[]>()
  private readonly handoffs = new Map<string, readonly TaskHandoff[]>()
  private readonly executions = new Map<string, number>()
  private readonly local = new AbortController()
  private readonly signal: AbortSignal
  private readonly slots: SlotPool
  private readonly inFlight = new Map<string, Promise<void>>()
  private agentExecutions = 0
  private failure?: string
  private root?: string

  constructor(
    private readonly ctx: Context,
    private readonly settings: ExecutorSettings,
    private readonly controller: FlowRunController,
    private readonly seat: ConversationSeat,
  ) {
    this.document = controller.run.snapshot
    const analysis = analyzeExecutionGraph(this.document)
    this.loops = analysis.loops
    this.signal = AbortSignal.any([controller.signal, this.local.signal])
    this.slots = new SlotPool(settings.maxConcurrentAgents)
    for (const node of this.document.nodes) this.statuses.set(node.id, 'pending')
    this.document.edges.forEach((edge, index) => {
      if (edge.kind !== 'execution') return
      this.arrivals.set(index, 'waiting')
      this.incoming.set(edge.to, [...(this.incoming.get(edge.to) ?? []), index])
      this.outgoing.set(edge.from, [...(this.outgoing.get(edge.from) ?? []), index])
    })
  }

  /** Drive the graph to settlement and report the run's outcome. */
  async drive(): Promise<FlowExecutionResult> {
    const root = this.controller.parent.session.header.cwd
    if (root === undefined) {
      return { stopReason: 'failed', error: 'the parent session has no workspace directory' }
    }
    this.root = root
    const entry = this.document.nodes.find(node => node.kind === 'start')
    /* v8 ignore next 3 -- save-time validation guarantees exactly one start node. */
    if (entry === undefined) {
      return { stopReason: 'failed', error: 'the run snapshot has no start node' }
    }
    try {
      await this.schedule(entry)
    } finally {
      await this.sweepPending()
    }
    if (this.failure !== undefined) return { stopReason: 'failed', error: this.failure }
    if (this.signal.aborted) return { stopReason: 'cancelled' }
    return { stopReason: 'completed' }
  }

  /** Admit every ready node until the graph settles or the run stops. */
  private async schedule(entry: FlowNode): Promise<void> {
    this.dispatch(entry)
    while (true) {
      if (this.signal.aborted || this.failure !== undefined) {
        await Promise.allSettled([...this.inFlight.values()])
        return
      }
      this.dispatchReady(this.deadNodes())
      if (this.inFlight.size === 0) {
        const dead = this.deadNodes()
        const stranded = this.document.nodes.filter(node => this.statuses.get(node.id) === 'pending' && !dead.has(node.id))
        const ended = this.document.nodes.some(node => node.kind === 'end' && this.statuses.get(node.id) === 'succeeded')
        /* v8 ignore next 1 -- save-time validation leaves every node reachable, so a stall names stranded nodes. */
        if (!ended || stranded.length > 0) this.fail(`execution stalled before a successful end${stranded.length === 0 ? '' : `: ${stranded.map(node => node.id).join(', ')}`}`)
        return
      }
      await Promise.race([...this.inFlight.values()])
    }
  }

  /** Admit every currently ready node until the run stops or none remain. */
  private dispatchReady(dead: ReadonlySet<string>): void {
    for (const node of this.document.nodes) {
      if (this.failure !== undefined) break
      if (this.statuses.get(node.id) !== 'pending') continue
      if (dead.has(node.id)) continue
      if (!this.ready(node, dead)) continue
      this.dispatch(node)
    }
  }

  /** Admit one node: mark it running and start its task, never rejecting. */
  private dispatch(node: FlowNode): void {
    if (node.kind === AGENT_KIND) {
      if (this.agentExecutions >= this.document.maxIterations) {
        this.fail(`run reached its iteration cap (${this.document.maxIterations}) — raise maxIterations if the loop is intentionally this long`)
        return
      }
      this.agentExecutions += 1
    }
    const inputs = this.executionInputs(node)
    this.statuses.set(node.id, 'running')
    const task = (async () => {
      try {
        await this.runNode(node, inputs)
      } catch (error) {
        if (error instanceof IterationRecordUnavailable) {
          // The failed append left the previous iteration's record in place;
          // patching "the latest entry" here would rewrite that success.
          this.statuses.set(node.id, 'failed')
          /* v8 ignore next 1 -- a failed append while cancelling is already a run failure. */
          if (!this.signal.aborted) this.fail(`node "${error.nodeId}" could not start iteration ${error.iteration}: ${error.message}`)
        } else {
          const message = this.signal.aborted ? 'run cancelled' : errorMessage(error)
          await this.markFailed(node.id, message)
          if (!this.signal.aborted) this.fail(`node "${node.id}" failed: ${message}`)
        }
      } finally {
        this.inFlight.delete(node.id)
      }
    })()
    this.inFlight.set(node.id, task)
  }

  /** Execute one node to its terminal state; a re-execution appends a record entry. */
  private async runNode(node: FlowNode, inputs: readonly TaskHandoff[]): Promise<void> {
    const iteration = this.executions.get(node.id) ?? 0
    if (iteration > 0) {
      try {
        await this.controller.startNodeIteration(node.id)
      } catch (error) {
        throw new IterationRecordUnavailable(node.id, iteration, errorMessage(error))
      }
    }
    this.executions.set(node.id, iteration + 1)
    switch (node.kind) {
      case 'start':
        await this.patch(node.id, 'succeeded', { endedAt: new Date().toISOString() })
        this.activateAll(node.id, [])
        return
      case 'join':
        this.handoffs.set(node.id, inputs)
        await this.patch(node.id, 'succeeded', { endedAt: new Date().toISOString() })
        this.activateAll(node.id, inputs)
        return
      case 'end':
        await this.patch(node.id, 'succeeded', { endedAt: new Date().toISOString() })
        return
      case CONDITION_KIND:
        await this.runConditionNode(node, inputs)
        return
      case AGENT_KIND:
        await this.runAgentNode(node, iteration, inputs)
        return
      /* v8 ignore next 2 -- the node union is closed and every member is handled above. */
      default:
        assertNever(node)
    }
  }

  /** Route the incoming task result, retaining its source identity. */
  private async runConditionNode(node: Extract<FlowNode, { kind: 'condition' }>, inputs: readonly TaskHandoff[]): Promise<void> {
    const word = inputs[0]?.result
    const chosen = this.edgesOf(this.outgoing, node.id).find(index => this.edgeAt(index).result === word)
    /* v8 ignore next 1 -- save-time validation gives every word on this node a route. */
    if (chosen === undefined) throw new Error(`condition node "${node.id}" has no route for result "${word}"`)
    this.handoffs.set(node.id, inputs)
    await this.patch(node.id, 'succeeded', { result: word, endedAt: new Date().toISOString() })
    const loop = this.loops.find(candidate => candidate.nodes.includes(node.id))
    if (loop !== undefined && loop.backEdges.includes(chosen)) {
      this.restartLoop(loop)
    } else if (loop !== undefined && !loop.nodes.includes(this.edgeAt(chosen).to)) {
      for (const member of loop.nodes) {
        for (const index of this.edgesOf(this.outgoing, member)) {
          if (!loop.nodes.includes(this.edgeAt(index).to)) this.arrivals.set(index, 'skipped')
        }
      }
    }
    for (const index of this.edgesOf(this.outgoing, node.id)) {
      if (index === chosen) continue
      if (loop !== undefined && !loop.nodes.includes(this.edgeAt(index).to) && loop.nodes.includes(this.edgeAt(chosen).to)) continue
      this.arrivals.set(index, 'skipped')
    }
    this.activate(chosen, inputs)
  }

  /** Start one node agent, derive its handoff record, and route on its Result line. */
  private async runAgentNode(node: Extract<FlowNode, { kind: 'agent' }>, iteration: number, executionInputs: readonly TaskHandoff[]): Promise<void> {
    // The slot is the node's first acquisition, so dispatch order decides which
    // of several simultaneously ready nodes runs first.
    await this.slots.acquire()
    try {
      if (this.signal.aborted) throw new Error('run cancelled')
      const inputs = this.sourcesOf(node, executionInputs)
      const userInput = this.readsUserInput(node.id)
      await this.patch(node.id, 'running', {
        inputs: inputs.map(source => ({ nodeId: source.nodeId, iteration: source.iteration })),
        userInput,
      })
      const dir = join(this.workspaceRoot(), '.dsh', 'flows', String(this.controller.run.id), `${String(iteration).padStart(2, '0')}-${node.id}`)
      await mkdir(dir, { recursive: true })
      const template = await this.ctx.agentFlows.readTemplate(node.templateId)
      const words = this.resultWords(node)
      const interactive = node.interactive === true
      const promptInput = {
        instruction: node.instruction,
        // The host no longer accepts a per-child persona at subagent start, so
        // every node's role travels in its prompt.
        ...template.persona === undefined ? {} : { persona: template.persona },
        interactive,
        userMessage: userInput ? this.controller.run.input : undefined,
        sources: inputs.map(source => ({ name: this.nodeName(this.nodeAt(source.nodeId)), handoff: source.handoff, files: source.files })),
        dir,
        resultWords: words,
      }
      const settled = interactive
        ? await this.converse(node, template, dir, assembleConversationPrompt(promptInput), words)
        : await this.runChild(node, template, dir, assemblePrompt(promptInput), words)
      const output = [{ ...settled, nodeId: node.id, iteration }]
      this.handoffs.set(node.id, output)
      await this.patch(node.id, 'succeeded', {
        handoff: settled.handoff,
        files: settled.files,
        ...settled.result === undefined ? {} : { result: settled.result },
        endedAt: new Date().toISOString(),
      })
      this.activateAll(node.id, output)
    } finally {
      this.slots.release()
    }
  }

  /** Run one worker node as a one-shot subagent child and select its handoff. */
  private async runChild(
    node: Extract<FlowNode, { kind: 'agent' }>,
    template: AgentTemplate,
    dir: string,
    prompt: string,
    words: string[],
  ): Promise<NodeHandoff> {
    let child: SubagentActivation | undefined
    try {
      const agentOptions = agentOptionsOf(template)
      child = await this.ctx.subagents.startActivation({
        provider: this.settings.provider,
        label: this.nodeName(node),
        request: {
          prompt: [{ type: 'text', text: prompt }],
          parent: this.controller.parent,
          ...agentOptions === undefined ? {} : { agentOptions },
        },
        signal: this.signal,
        delivery: 'caller',
      })
      await this.patch(node.id, 'running', { agentSessionId: child.childId, dir, startedAt: new Date().toISOString() })
      /* The activation owns its own stop signal; cancellation of the run must
         dispose it explicitly rather than relying on the startup signal. */
      const aborted = Promise.withResolvers<never>()
      const onAbort = (): void => { aborted.reject(new Error('run cancelled')) }
      if (this.signal.aborted) onAbort()
      else this.signal.addEventListener('abort', onAbort, { once: true })
      let result
      try {
        result = await Promise.race([child.result, aborted.promise])
      } finally {
        this.signal.removeEventListener('abort', onAbort)
      }
      if (result.stopReason !== 'completed') {
        throw new Error(result.diagnostic ?? `child stopped with "${result.stopReason}"`)
      }
      const handoff = textOf(result.output)
      let parsed: string | undefined
      if (words.length > 0) {
        parsed = parseResult(handoff)
        if (parsed === undefined || !words.includes(parsed)) throw new Error(this.resultDemand(node, words))
      }
      return { handoff, files: await listFiles(dir), result: parsed }
    } finally {
      if (child !== undefined) await this.disposeChild(child)
    }
  }

  /**
   * Drive one interactive node on a root Session the user joins: open it with
   * the assembled prompt, then settle on the first turn whose final message
   * declares a routing word. A turn that closes without one leaves the node
   * `conversing` and waits for the user's own reply.
   */
  private async converse(
    node: Extract<FlowNode, { kind: 'agent' }>,
    template: AgentTemplate,
    dir: string,
    prompt: ConversationPrompt,
    words: string[],
  ): Promise<NodeHandoff> {
    const conversation = new Conversation(this.ctx, {
      parent: this.controller.parent,
      title: this.nodeName(node),
      prompt,
      cwd: this.workspaceRoot(),
      route: conversationRoute(this.ctx.agentDefaultModel.currentSelection(), template),
      signal: this.signal,
      seat: this.seat,
    })
    try {
      await conversation.open()
      await this.patch(node.id, 'running', { agentSessionId: conversation.sessionId, dir, startedAt: new Date().toISOString() })
      let turns = 0
      while (true) {
        const closed = await conversation.awaitTurn()
        if (this.signal.aborted) throw new Error('run cancelled')
        const reason = closed.reason
        if (reason !== undefined && reason.kind === 'error') {
          throw new Error(`the conversation turn failed: ${reason.error.message}`)
        }
        turns += 1
        const handoff = textOf(closed.output)
        const parsed = parseResult(handoff)
        if (parsed !== undefined) {
          if (!words.includes(parsed)) throw new Error(this.resultDemand(node, words))
          return { handoff, files: await listFiles(dir), result: parsed }
        }
        if (turns >= this.settings.maxConversationTurns) {
          throw new Error(`node "${node.id}" used its ${this.settings.maxConversationTurns}-turn conversation budget without a Result line — raise maxConversationTurns if the clarification is intentionally this long`)
        }
        await this.patch(node.id, 'conversing')
      }
    } finally {
      conversation.close()
      await conversation.settle()
    }
  }

  /** The failure text for one handoff that declares no valid routing word. */
  private resultDemand(node: Extract<FlowNode, { kind: 'agent' }>, words: string[]): string {
    return `node "${node.id}" must end its final message with \`Result: <word>\` using one of: ${words.map(word => `"${word}"`).join(', ')}`
  }

  /**
   * The Result words one node must close with: the vocabulary of the condition
   * node it feeds, or the fixed completion word when an interactive node routes
   * nothing. A turn of the latter closing without one is an unfinished
   * conversation, not a completed node.
   */
  private resultWords(node: Extract<FlowNode, { kind: 'agent' }>): string[] {
    const condition = this.edgesOf(this.outgoing, node.id)
      .map(index => this.edgeAt(index).to)
      .find(to => this.nodeAt(to).kind === CONDITION_KIND)
    if (condition === undefined) return node.interactive === true ? [INTERACTIVE_DONE] : []
    return this.edgesOf(this.outgoing, condition).flatMap((index) => {
      const word = this.edgeAt(index).result
      /* v8 ignore next 1 -- save-time validation requires every condition-node outgoing edge to carry a word. */
      return word === undefined ? [] : [word]
    })
  }

  /** Whether this task reads the run request: entry nodes by default, else an explicit input edge. */
  private readsUserInput(nodeId: string): boolean {
    return this.isEntryNode(nodeId)
      || this.document.edges.some(edge => edge.kind === 'input' && edge.to === nodeId && this.nodeAt(edge.from).kind === START_KIND)
  }

  /** Whether the Start node executes this task directly, making it a flow entry. */
  private isEntryNode(nodeId: string): boolean {
    const start = this.document.nodes.find(node => node.kind === START_KIND)
    if (start === undefined) return false
    return this.document.edges.some(edge => edge.kind === 'execution' && edge.from === start.id && edge.to === nodeId)
  }

  /** Resolve required references before starting any model or tool work. */
  private sourcesOf(node: Extract<FlowNode, { kind: 'agent' }>, executionInputs: readonly TaskHandoff[]): TaskHandoff[] {
    const sources = [...executionInputs]
    for (const edge of this.document.edges) {
      if (edge.kind !== 'input' || edge.to !== node.id || this.nodeAt(edge.from).kind === START_KIND) continue
      const result = this.handoffs.get(edge.from)
      if (this.statuses.get(edge.from) !== 'succeeded' || result === undefined) {
        throw new Error(`required input "${edge.from}" is unavailable for node "${node.id}"`)
      }
      sources.push(...result)
    }
    return this.uniqueResults(sources)
  }

  /** Deduplicate the same execution reached through several transparent routes. */
  private uniqueResults(sources: readonly TaskHandoff[]): TaskHandoff[] {
    return [...new Map(sources.map(source => [`${source.nodeId}:${source.iteration}`, source])).values()]
  }

  /** Consume this activation, retaining a serial loop's initial external inputs. */
  private executionInputs(node: FlowNode): TaskHandoff[] {
    const indices = this.effectiveIncoming(node.id).filter(index => this.arrivals.get(index) === 'arrived')
    /* v8 ignore next 1 -- every arrived edge carries its results. */
    const inputs = indices.flatMap(index => this.edgeResults.get(index) ?? [])
    for (const index of indices) this.arrivals.set(index, 'consumed')
    const loop = this.loops.find(candidate => candidate.header === node.id)
    if (loop !== undefined) {
      if ((this.loopRounds.get(loop.header) ?? 0) === 0) this.loopDependencies.set(loop.header, inputs)
      /* v8 ignore start -- the first round stored this loop's dependencies. */
      else inputs.push(...(this.loopDependencies.get(loop.header) ?? []))
      /* v8 ignore stop */
    }
    return this.uniqueResults(inputs)
  }

  /** External first entry and a selected return enter the loop in different rounds. */
  private effectiveIncoming(nodeId: string): number[] {
    const indices = this.edgesOf(this.incoming, nodeId)
    const loop = this.loops.find(candidate => candidate.header === nodeId)
    if (loop === undefined) return indices
    return (this.loopRounds.get(loop.header) ?? 0) === 0
      ? indices.filter(index => !loop.backEdges.includes(index))
      : indices.filter(index => loop.backEdges.includes(index))
  }

  /** Discard internal arrivals and outputs before admitting the next serial round. */
  private restartLoop(loop: ExecutionLoop): void {
    this.loopRounds.set(loop.header, (this.loopRounds.get(loop.header) ?? 0) + 1)
    for (const id of loop.nodes) {
      this.statuses.set(id, 'pending')
      this.handoffs.delete(id)
      for (const index of this.edgesOf(this.outgoing, id)) {
        this.arrivals.set(index, 'waiting')
        this.edgeResults.delete(index)
      }
    }
  }

  /**
   * The name one node presents to a model and to the session list: its title, or
   * its id when the title carries no text. Titles are user-authored and the
   * document schema accepts a blank one, which the title service rejects.
   */
  private nodeName(node: FlowNode): string {
    const title = node.title?.trim()
    return title === undefined || title === '' ? node.id : title
  }

  /** Record one node's failure durably without failing the run record itself. */
  private async markFailed(nodeId: string, message: string): Promise<void> {
    this.statuses.set(nodeId, 'failed')
    try {
      await this.controller.updateNodeRun(nodeId, { status: 'failed', error: message, endedAt: new Date().toISOString() })
    } catch (error) {
      this.ctx.logger.warn(`agent flow node "${nodeId}" failure record rejected: ${errorMessage(error)}`)
    }
  }

  /** Persist one node state and mirror its status for scheduling. */
  private async patch(nodeId: string, status: FlowNodeRun['status'], patch: FlowNodeRunPatch = {}): Promise<void> {
    this.statuses.set(nodeId, status)
    await this.controller.updateNodeRun(nodeId, { ...patch, status })
  }

  /** Transfer a settled node's own output along all execution edges. */
  private activateAll(nodeId: string, results: readonly TaskHandoff[]): void {
    for (const index of this.edgesOf(this.outgoing, nodeId)) this.activate(index, results)
  }

  /** Publish one arrival; only an explicit loop return re-arms completed tasks. */
  private activate(index: number, results: readonly TaskHandoff[]): void {
    const target = this.edgeAt(index).to
    /* v8 ignore next 1 -- scheduling activates only pending nodes. */
    if (this.statuses.get(target) !== 'pending') throw new Error(`execution arrived at non-pending node "${target}"`)
    this.arrivals.set(index, 'arrived')
    this.edgeResults.set(index, results)
  }

  /** Mark every node that never became runnable as skipped. */
  private async sweepPending(): Promise<void> {
    for (const node of this.document.nodes) {
      if (this.statuses.get(node.id) !== 'pending') continue
      this.statuses.set(node.id, 'skipped')
      // A selected return may be cancelled before this task starts another
      // iteration. Its last completed execution must retain its outcome.
      if ((this.executions.get(node.id) ?? 0) > 0) continue
      try {
        await this.controller.updateNodeRun(node.id, { status: 'skipped', endedAt: new Date().toISOString() })
      } catch (error) {
        this.ctx.logger.warn(`agent flow node "${node.id}" skip record rejected: ${errorMessage(error)}`)
      }
    }
  }

  /** Stop the run with one run-level failure cause. */
  private fail(message: string): void {
    this.failure ??= message
    this.local.abort(new Error(message))
  }

  /** Dispose one child run, containing its cleanup failure. */
  private async disposeChild(child: SubagentActivation): Promise<void> {
    try {
      await child.dispose()
    } catch (error) {
      this.ctx.logger.warn(`agent flow child "${String(child.childId)}" disposal failed: ${errorMessage(error)}`)
    }
  }

  /** Edge indices incident to one node; save-time validation guarantees the required ones exist. */
  private edgesOf(map: Map<string, number[]>, nodeId: string): number[] {
    /* v8 ignore next 1 -- validated documents always carry the edges each node kind requires. */
    return map.get(nodeId) ?? []
  }

  /** The edge at one index; edge indices come from this document's own edge list. */
  private edgeAt(index: number): FlowEdge {
    const edge = this.document.edges[index]
    /* v8 ignore next 1 -- edge indices come from this document's own edge list. */
    if (edge === undefined) throw new Error(`edge ${index} is not part of the run snapshot`)
    return edge
  }

  /** The node with one identity; routing reads only nodes reachable through validated edges. */
  private nodeAt(id: string): FlowNode {
    const node = this.document.nodes.find(candidate => candidate.id === id)
    /* v8 ignore next 1 -- save-time validation rejects edges to missing nodes. */
    if (node === undefined) throw new Error(`node "${id}" is not part of the run snapshot`)
    return node
  }

  /** The parent session's workspace root; drive() rejects runs without one before scheduling. */
  private workspaceRoot(): string {
    /* v8 ignore next 1 -- drive() resolves the root before any node runs. */
    if (this.root === undefined) throw new Error('the run has no workspace directory')
    return this.root
  }

  /** Only a conditional exclusion makes a branch unavailable; failure stops the run. */
  private isEdgeDead(index: number, dead: ReadonlySet<string>): boolean {
    return this.arrivals.get(index) === 'skipped' || dead.has(this.edgeAt(index).from)
  }

  /** Propagate paths excluded by routing without activating empty joins. */
  private deadNodes(): Set<string> {
    const dead = new Set<string>()
    let changed = true
    while (changed) {
      changed = false
      for (const node of this.document.nodes) {
        if (node.kind === 'start' || dead.has(node.id) || this.statuses.get(node.id) !== 'pending') continue
        const incoming = this.effectiveIncoming(node.id)
        if (incoming.length > 0 && incoming.every(index => this.isEdgeDead(index, dead))) {
          dead.add(node.id)
          changed = true
        }
      }
    }
    return dead
  }

  /** Every task uses all semantics, with at least one real control arrival. */
  private ready(node: FlowNode, dead: ReadonlySet<string>): boolean {
    const incoming = this.effectiveIncoming(node.id)
    return incoming.some(index => this.arrivals.get(index) === 'arrived')
      && incoming.every(index => this.arrivals.get(index) === 'arrived' || this.isEdgeDead(index, dead))
  }

}

/** The registered executor: one graph interpreter per run. */
export class GraphExecutor implements FlowExecutor {
  /** Registry name from configuration. */
  readonly name: string

  /** How to reach one in-flight run's conversation, keyed by run. */
  private readonly conversations = new Map<FlowRunId, ConversationSubmit>()

  /**
   * @param ctx - plugin context carrying the Agent Flow, subagent, agent, and model services.
   * @param settings - registry and provider selection with the run bounds.
   */
  constructor(
    private readonly ctx: Context,
    private readonly settings: ExecutorSettings,
  ) {
    this.name = settings.executor
  }

  /**
   * Cancellation requires no work here: the service aborts the run signal this
   * executor observes, which settles every child run it started and stops a
   * conversation's live turn.
   * @param _runId - run identity.
   */
  cancel(_runId: FlowRunId): void {}

  /**
   * End one run's clarification by telling its conversational agent to stop
   * asking and state its Result word. The registration is consumed, so a second
   * request reports that no conversation is open rather than repeating itself.
   * @param runId - run identity.
   * @returns whether a conversation was open to conclude.
   */
  concludeConversation(runId: FlowRunId): boolean {
    const submit = this.conversations.get(runId)
    if (submit === undefined) return false
    this.conversations.delete(runId)
    submit(CONCLUDE_PROMPT)
    return true
  }

  /** Drive one accepted run to settlement. */
  async execute(controller: FlowRunController): Promise<FlowExecutionResult> {
    const runId = controller.run.id
    return await new GraphRun(this.ctx, this.settings, controller, {
      publish: (submit) => { this.conversations.set(runId, submit) },
      withdraw: () => { this.conversations.delete(runId) },
    }).drive()
  }
}
