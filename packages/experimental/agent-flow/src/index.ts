/**
 * Agent Flow service (`ctx.agentFlows`): durable agent templates, validated
 * flow documents, persisted run records, and the executor registry that run
 * execution providers plug into.
 * @module @deepseek-ai/dsh-experimental-agent-flow
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SessionUsage } from '@deepseek-ai/dsh-api-session-controller'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { agentFlowDomain, agentTemplateRecord, flowDocumentRecord } from './spec.ts'
import type { AgentTemplate, FlowDocument, FlowNodeRun, FlowRun, SessionUsageRecord } from './spec.ts'
import { AgentTemplateId, FlowId, FlowRunId } from './types.ts'
import type {
  AgentTemplateDraft,
  Config,
  FlowDraft,
  FlowExecutionResult,
  FlowExecutor,
  FlowNodeRunPatch,
  FlowRunController,
  FlowStartRemoteRequest,
  FlowStartRequest,
} from './types.ts'
import { validateFlow } from './validation.ts'

export { AgentTemplateId, FlowId, FlowRunId } from './types.ts'
export type {
  Config,
  FlowDraft,
  AgentTemplateDraft,
  FlowExecutionResult,
  FlowExecutor,
  FlowNodeRunPatch,
  FlowRunController,
  FlowStartRemoteRequest,
  FlowStartRequest,
} from './types.ts'
export type { AgentTemplate, FlowDocument, FlowEdge, FlowNode, FlowNodeRun, FlowRun, SessionUsageRecord } from './spec.ts'
export { agentFlowDomain, agentTemplateRecord, flowDocumentRecord } from './spec.ts'
export { validateFlow } from './validation.ts'
export type { FlowProblem, FlowProblemCode } from './validation.ts'
export { analyzeExecutionGraph } from './graph.ts'
export type { ExecutionGraphAnalysis, ExecutionLoop } from './graph.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentFlows: AgentFlowService
  }
}

const DEFAULT_EXECUTOR = 'graph'
const DEFAULT_MAX_FLOWS = 100
const DEFAULT_MAX_TEMPLATES = 100
const DEFAULT_MAX_RUNS = 1000
const DEFAULT_MAX_ITERATIONS = 16

/** Surface one error's message without assuming it is an `Error`. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Reject problems as one remote-invalid error carrying every violation. */
function invalid(message: string, problems: readonly { code: string; message: string }[]): RemoteError {
  return new RemoteError('agent-flow/invalid', message, {
    problems: problems.map(problem => ({ code: problem.code, message: problem.message })),
  })
}

/** Index of one node's latest entry; entries append in iteration order. */
function latestNodeRunIndex(run: FlowRun, nodeId: string): number {
  let index = -1
  run.nodeRuns.forEach((entry, position) => {
    if (entry.nodeId === nodeId) index = position
  })
  /* v8 ignore next 1 -- callers reject node ids the run does not carry. */
  if (index < 0) throw new RemoteError('agent-flow/not-found', `node "${nodeId}" is not part of run ${run.id}`, { kind: 'run', id: String(run.id) })
  return index
}

/** Completed executor outcome retained until its terminal record commits. */
interface RunSettlement {
  readonly result: FlowExecutionResult
  readonly endedAt: string
}

/** One service-owned execution, including a completed outcome awaiting durability. */
interface ActiveRun {
  readonly executor: FlowExecutor
  readonly controller: AbortController
  settlement?: RunSettlement
}

/**
 * Agent Flow service over one storage domain. Template and flow saves fail
 * loud with every validation problem; runs persist before execution starts
 * and settle exactly once through the registered executor.
 */
export class AgentFlowService extends TypertRemoteService {
  static inject = ['storageDomain']

  static Config = z.object({
    executor: z.string().default(DEFAULT_EXECUTOR),
    maxFlows: z.number().step(1).min(1).default(DEFAULT_MAX_FLOWS),
    maxTemplates: z.number().step(1).min(1).default(DEFAULT_MAX_TEMPLATES),
    maxRuns: z.number().step(1).min(1).default(DEFAULT_MAX_RUNS),
  })

  /** Validated deployment limits and default executor selection. */
  private readonly config: Required<Config>

  private readonly executors = new Map<string, FlowExecutor>()
  private readonly active = new Map<FlowRunId, ActiveRun>()
  private readonly drives = new Map<FlowRunId, Promise<void>>()
  /**
   * Sessions that have started a run, answered to the session-usage seam. The
   * in-memory copy is authoritative for this process and rebuilt at activation
   * from the usage table plus every persisted run, so evicted run records and
   * historical runs both keep their Session occupied.
   */
  private readonly occupiedSessions = new Set<SessionId>()
  /**
   * Sessions known to have a durable usage row. In-memory occupation and
   * durable proof are tracked separately: the set answers the current process,
   * while the row must exist before the last run proving it may be evicted.
   */
  private readonly usagePersisted = new Set<SessionId>()
  /**
   * Listeners of the session-usage change feed, one per live consumer
   * subscription; notified once per newly occupied Session.
   */
  private readonly usageListeners = new Set<(sessionId: SessionId) => void>()
  /** Checks and writes across all four tables share one operation order. */
  private operations: Promise<void> = Promise.resolve()
  private stopping = false
  private flows?: KvTable<FlowId, FlowDocument>
  private templates?: KvTable<AgentTemplateId, AgentTemplate>
  private runs?: KvTable<FlowRunId, FlowRun>
  private usage?: KvTable<SessionId, SessionUsageRecord>

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'agentFlows')
    const executor = config.executor?.trim() ?? DEFAULT_EXECUTOR
    if (!executor) throw new Error('executor must not be an empty name')
    this.config = {
      executor,
      maxFlows: config.maxFlows ?? DEFAULT_MAX_FLOWS,
      maxTemplates: config.maxTemplates ?? DEFAULT_MAX_TEMPLATES,
      maxRuns: config.maxRuns ?? DEFAULT_MAX_RUNS,
    }
  }

  /** Open the domain and register one sequenced teardown: settle runs, then close the unit. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(agentFlowDomain)
    // Fiber unload runs effect disposers concurrently, so one effect must own
    // the whole ordering: in-flight runs settle before the storage unit closes.
    this.ctx.effect(() => async () => {
      const failures: unknown[] = []
      try {
        await this.disposeRuntime()
      } catch (error) {
        failures.push(error)
      }
      try {
        await domain.close()
      } catch (error) {
        /* v8 ignore next 1 -- the storage unit’s close failure is contained here. */
        failures.push(error)
      }
      if (failures.length === 1) throw failures[0]
      /* v8 ignore next 1 -- two failing disposers are needed to aggregate. */
      if (failures.length > 1) throw new AggregateError(failures, 'agent flow service cleanup failed')
    }, 'agentFlows.dispose')
    this.flows = domain.table('flows')
    this.templates = domain.table('templates')
    this.runs = domain.table('runs')
    this.usage = domain.table('usage')
    // Opening the domain reserves its sole live handle before this service
    // accepts runs; the loaded records have no executor owned by this handle.
    await this.reconcileInterruptedRuns()
    await this.rebuildOccupiedSessions()
    // The seam is provided only after the occupied set is complete, so a
    // consumer that sees the service answers from durable facts, never from a
    // half-loaded roster.
    const unprovide = this.ctx.provide('sessionUsage', {
      isOccupied: (sessionId: SessionId) => this.occupiedSessions.has(sessionId),
      subscribe: (listener: (sessionId: SessionId) => void) => {
        this.usageListeners.add(listener)
        return () => { this.usageListeners.delete(listener) }
      },
    } satisfies SessionUsage)
    this.ctx.effect(() => unprovide, 'agentFlows.sessionUsage')
  }

  /**
   * Rebuild the occupied set from the usage table and every persisted run's
   * parent, backfilling the durable usage row for a parent first proved only
   * by its runs so occupation outlives those runs' eviction.
   */
  private async rebuildOccupiedSessions(): Promise<void> {
    for (const sessionId of this.requireUsage().keys()) {
      this.occupiedSessions.add(sessionId)
      this.usagePersisted.add(sessionId)
    }
    for (const [, run] of this.requireRuns().entries()) {
      this.occupiedSessions.add(run.parentSessionId)
      await this.persistUsage(run.parentSessionId, run.id, run.startedAt)
    }
  }

  /**
   * Report one newly occupied Session to every live seam subscriber. A broken
   * listener cannot fail the run that already admitted it.
   * @param sessionId - Session that became occupied.
   */
  private notifyUsage(sessionId: SessionId): void {
    for (const listener of this.usageListeners) {
      try {
        listener(sessionId)
      } catch (error) {
        this.ctx.logger.warn(
          `agent flow usage listener for session "${String(sessionId)}" failed: ${errorMessage(error)}`,
        )
      }
    }
  }

  /**
   * Write the durable usage row that keeps one Session occupied after every
   * run record is evicted. Failures are reported and retried by the next
   * admission, activation backfill, or retention pass while the in-memory set
   * answers the current process.
   * @param sessionId - occupied parent Session.
   * @param runId - run whose admission proves the occupation.
   * @param startedAt - run start timestamp stored on the row.
   * @returns whether the durable row is known to exist after this attempt.
   */
  private async persistUsage(sessionId: SessionId, runId: FlowRunId, startedAt: string): Promise<boolean> {
    if (this.usagePersisted.has(sessionId)) return true
    try {
      await this.requireUsage().put(sessionId, { runId, startedAt })
      this.usagePersisted.add(sessionId)
      return true
    } catch (error) {
      this.ctx.logger.warn(
        `agent flow usage record for session "${String(sessionId)}" failed: ${errorMessage(error)}`,
      )
      return false
    }
  }

  /**
   * Register one execution engine.
   * @param executor - trusted same-process implementation.
   * @returns the disposer removing the registration and settling the runs it
   *   still owns, so unloading a provider never leaves an ownerless run.
   */
  registerExecutor(executor: FlowExecutor): () => Promise<void> {
    if (!executor.name.trim()) throw new Error('executor name must not be empty')
    if (this.executors.has(executor.name)) throw new Error(`duplicate agent flow executor: ${executor.name}`)
    this.executors.set(executor.name, executor)
    return async () => {
      /* Removal and the active snapshot share the service queue with `start`,
         so a run cannot pass admission after its executor is gone. */
      const owned = await this.sequence(() => {
        if (this.executors.get(executor.name) === executor) this.executors.delete(executor.name)
        return this.detachExecutorRuns(executor)
      })
      /* v8 ignore next 1 -- a boot with no unsettled run reconciles nothing. */
      if (owned.length === 0) return
      await Promise.allSettled(owned.map(id => this.drives.get(id)).filter((drive): drive is Promise<void> => drive !== undefined))
      /* v8 ignore next 1 -- activation reconciles unless teardown already began. */
      if (!this.stopping) await this.sequence(() => this.reconcileSettlements(owned))
    }
  }

  /**
   * Cancel every active run still owned by one executor and return its ids.
   * Runs are detached in the service queue; their settlement stays outside it
   * so the drive's terminal write can enter the queue without deadlocking.
   */
  private detachExecutorRuns(executor: FlowExecutor): FlowRunId[] {
    const owned = [...this.active.entries()]
      .filter(([, entry]) => entry.executor === executor)
      .map(([id]) => id)
    for (const id of owned) {
      const entry = this.active.get(id)
      /* v8 ignore next 1 -- a run that settled during unload needs no cancellation. */
      if (entry === undefined || entry.settlement !== undefined) continue
      try {
        /* v8 ignore next 1 -- a refused cancellation during unload is contained. */
        entry.executor.cancel(id)
      } catch (error) {
        /* v8 ignore next 1 -- a refused cancellation during unload is contained. */
        this.ctx.logger.warn(`agent flow run "${String(id)}" cancellation failed during executor unload: ${errorMessage(error)}`)
      } finally {
        entry.controller.abort()
      }
    }
    return owned
  }

  /** Read every template in display order.
   * @returns stored templates sorted by name, then id.
   */
  @Remote('listTemplates')
  listTemplates(): Promise<AgentTemplate[]> {
    return Promise.resolve([...this.requireTemplates().entries()]
      .map(([, template]) => template)
      .sort((a, b) => a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id))))
  }

  /**
   * Resolve one template.
   * @param id - template identity.
   * @returns the stored template.
   */
  @Remote('readTemplate')
  readTemplate(id: AgentTemplateId): Promise<AgentTemplate> {
    const template = this.requireTemplates().get(id)
    if (template === undefined) {
      return Promise.reject(new RemoteError('agent-flow/not-found', `unknown agent template: ${id}`, { kind: 'template', id: String(id) }))
    }
    return Promise.resolve(template)
  }

  /**
   * Create or replace one template.
   * @param draft - template fields; an absent id creates a new identity.
   * @returns the stored template.
   */
  @Remote('saveTemplate')
  async saveTemplate(draft: AgentTemplateDraft): Promise<AgentTemplate> {
    return await this.operate(async () => {
      if (!draft.name.trim()) {
        throw invalid('template name must not be empty', [{ code: 'empty-name', message: 'template name must not be empty' }])
      }
      const { id: draftId, ...rest } = draft
      const table = this.requireTemplates()
      const existing = draftId !== undefined ? table.get(draftId) : undefined
      if (existing === undefined && table.size >= this.config.maxTemplates) {
        throw new RemoteError('agent-flow/limit', `at most ${this.config.maxTemplates} templates may be saved`, {
          limit: this.config.maxTemplates,
          kind: 'templates',
        })
      }
      const now = new Date().toISOString()
      const record: AgentTemplate = {
        ...rest,
        id: draftId ?? AgentTemplateId(randomUUID()),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      const parsed = agentTemplateRecord.safeParse(record)
      if (!parsed.success) {
        throw invalid('template record failed its schema', parsed.error.issues.map((issue: { message: string }) => ({
          code: 'invalid-record' as const,
          message: issue.message,
        })))
      }
      await table.put(record.id, parsed.data)
      return parsed.data
    })
  }

  /**
   * Delete one template.
   * @param id - template identity.
   */
  @Remote('deleteTemplate')
  async deleteTemplate(id: AgentTemplateId): Promise<void> {
    await this.operate(async () => {
      const table = this.requireTemplates()
      if (table.get(id) === undefined) {
        throw new RemoteError('agent-flow/not-found', `unknown agent template: ${id}`, { kind: 'template', id: String(id) })
      }
      await this.reconcileSettlements([...this.requireRuns().entries()]
        .filter(([, run]) => run.snapshot.nodes.some(node => node.kind === 'agent' && node.templateId === id))
        .map(([runId]) => runId))
      const referencing = [...this.requireFlows().entries()]
        .filter(([, flow]) => flow.nodes.some(node => node.kind === 'agent' && node.templateId === id))
        .map(([flowId]) => String(flowId))
      for (const [, run] of this.requireRuns().entries()) {
        if (run.status === 'running' && run.snapshot.nodes.some(node => node.kind === 'agent' && node.templateId === id)) {
          /* v8 ignore next 1 -- a saved flow normally names the template it uses. */
          if (!referencing.includes(String(run.flowId))) referencing.push(String(run.flowId))
        }
      }
      if (referencing.length > 0) {
        throw new RemoteError('agent-flow/template-in-use', `template ${id} is referenced by a saved flow or running snapshot`, {
          id: String(id),
          flows: referencing,
        })
      }
      await table.delete(id)
    })
  }

  /** Read every flow document in display order.
   * @returns stored documents sorted by name, then id.
   */
  @Remote('listFlows')
  listFlows(): Promise<FlowDocument[]> {
    return Promise.resolve([...this.requireFlows().entries()]
      .map(([, flow]) => flow)
      .sort((a, b) => a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id))))
  }

  /**
   * Resolve one flow document.
   * @param id - flow identity.
   * @returns the stored document.
   */
  @Remote('readFlow')
  readFlow(id: FlowId): Promise<FlowDocument> {
    const flow = this.requireFlows().get(id)
    if (flow === undefined) {
      return Promise.reject(new RemoteError('agent-flow/not-found', `unknown agent flow: ${id}`, { kind: 'flow', id: String(id) }))
    }
    return Promise.resolve(flow)
  }

  /**
   * Create or replace one flow document. A save validates the complete graph
   * and every template reference, and rejects with all problems at once.
   * @param draft - document fields; an absent id creates a new identity.
   * @returns the stored document.
   */
  @Remote('saveFlow')
  async saveFlow(draft: FlowDraft): Promise<FlowDocument> {
    return await this.operate(async () => {
      if (!draft.name.trim()) {
        throw invalid('flow name must not be empty', [{ code: 'empty-name', message: 'flow name must not be empty' }])
      }
      const { id: draftId, ...rest } = draft
      const table = this.requireFlows()
      const existing = draftId !== undefined ? table.get(draftId) : undefined
      if (existing === undefined && table.size >= this.config.maxFlows) {
        throw new RemoteError('agent-flow/limit', `at most ${this.config.maxFlows} flows may be saved`, {
          limit: this.config.maxFlows,
          kind: 'flows',
        })
      }
      const now = new Date().toISOString()
      const record: FlowDocument = {
        ...rest,
        maxIterations: draft.maxIterations ?? DEFAULT_MAX_ITERATIONS,
        id: draftId ?? FlowId(randomUUID()),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      const parsed = flowDocumentRecord.safeParse(record)
      if (!parsed.success) {
        throw invalid('flow record failed its schema', parsed.error.issues.map((issue: { message: string }) => ({
          code: 'invalid-record' as const,
          message: issue.message,
        })))
      }
      const problems = validateFlow(parsed.data, new Set(this.requireTemplates().keys()))
      if (problems.length > 0) {
        throw invalid(`flow "${record.name}" is not a valid graph`, problems)
      }
      await table.put(record.id, parsed.data)
      return parsed.data
    })
  }

  /**
   * Delete one flow document. Settled run records keep their snapshots and stay readable.
   * @param id - flow identity.
   */
  @Remote('deleteFlow')
  async deleteFlow(id: FlowId): Promise<void> {
    await this.operate(async () => {
      const table = this.requireFlows()
      if (table.get(id) === undefined) {
        throw new RemoteError('agent-flow/not-found', `unknown agent flow: ${id}`, { kind: 'flow', id: String(id) })
      }
      await this.reconcileSettlements([...this.requireRuns().entries()]
        .filter(([, run]) => run.flowId === id)
        .map(([runId]) => runId))
      const active = [...this.requireRuns().entries()]
        .filter(([, run]) => run.flowId === id && run.status === 'running')
        .map(([runId]) => String(runId))
      if (active.length > 0) {
        throw new RemoteError('agent-flow/flow-in-use', `flow ${id} has in-flight runs`, { id: String(id), runs: active })
      }
      await table.delete(id)
    })
  }

  /**
   * Read persisted runs, newest first.
   * Retries completed outcomes whose terminal write previously failed.
   * @returns run records sorted by start time, newest first.
   */
  @Remote('listRuns')
  async listRuns(): Promise<FlowRun[]> {
    return await this.operate(async () => {
      await this.reconcileSettlements(this.active.keys())
      return [...this.requireRuns().entries()]
        .map(([, run]) => run)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || String(a.id).localeCompare(String(b.id)))
    })
  }

  /**
   * Resolve one run record, retrying a pending terminal write before returning.
   * @param id - run identity.
   * @returns the stored run.
   */
  @Remote('readRun')
  async readRun(id: FlowRunId): Promise<FlowRun> {
    return await this.operate(async () => {
      await this.reconcileSettlements([id])
      return this.requireRun(id)
    })
  }

  /**
   * Start one run of a saved flow. The run record persists in `running` state
   * before the registered executor begins, so every observer reads committed
   * state. Settlement happens in the background and lands on the same record.
   * @param parent - live Agent under whose lineage node agents are spawned.
   * @param request - flow identity, the user message, and caller cancellation.
   * @returns the persisted running record.
   */
  async start(parent: Agent, request: FlowStartRequest): Promise<FlowRun> {
    return await this.operate(async () => {
      const document = await this.readFlow(request.flowId)
      const problems = validateFlow(document, new Set(this.requireTemplates().keys()))
      /* v8 ignore next 1 -- a stored snapshot was validated when it was saved. */
      if (problems.length > 0) throw invalid(`flow "${document.name}" is not a valid graph`, problems)
      if (!request.input.trim()) {
        throw invalid('run input must not be empty', [
          { code: 'empty-input', message: 'run input must not be empty' },
        ])
      }
      if (request.signal.aborted) {
        throw invalid('run request is already cancelled', [
          { code: 'aborted', message: 'run request signal is already aborted' },
        ])
      }
      const executor = this.executors.get(this.config.executor)
      if (executor === undefined) {
        throw new RemoteError(
          'agent-flow/executor-missing',
          `no agent flow executor is registered as "${this.config.executor}"`,
          { executor: this.config.executor, registered: [...this.executors.keys()] },
        )
      }
      const runs = this.requireRuns()
      const run: FlowRun = {
        id: FlowRunId(randomUUID()),
        flowId: document.id,
        snapshot: document,
        parentSessionId: parent.session.id,
        status: 'running',
        input: request.input,
        nodeRuns: document.nodes.map(node => ({ nodeId: node.id, iteration: 0, status: 'pending' as const })),
        startedAt: new Date().toISOString(),
      }
      const controller = new AbortController()
      const signal = AbortSignal.any([request.signal, controller.signal])
      await runs.put(run.id, run)
      const newlyOccupied = !this.occupiedSessions.has(parent.session.id)
      this.occupiedSessions.add(parent.session.id)
      // Consumers holding the seam keep their Session summaries current without
      // waiting for the next list read.
      if (newlyOccupied) this.notifyUsage(parent.session.id)
      // The run record itself backfills occupation after a restart until this
      // row lands; the row outlives run eviction, so a failure is reported and
      // retried instead of failing a run that is already durably admitted.
      await this.persistUsage(parent.session.id, run.id, run.startedAt)
      this.active.set(run.id, { executor, controller })
      const drive = this.driveRun(run, executor, parent, signal)
      this.drives.set(run.id, drive)
      return run
    })
  }

  /**
   * Start one run for a browser client. The Gateway resolves the invoking
   * session's live Agent, which becomes the run's parent.
   * @param agent - live Agent resolved from the invoking session.
   * @param request - flow identity and the user message.
   * @param signal - remote cancellation for the whole run.
   * @returns the persisted running record.
   */
  @Remote('start')
  async startForClient(agent: Agent, request: FlowStartRemoteRequest, signal: AbortSignal): Promise<FlowRun> {
    return await this.start(agent, { flowId: request.flowId, input: request.input, signal })
  }

  /**
   * Cancel one in-flight run for a browser client. Only the Agent of the
   * session that started the run may cancel it.
   * @param agent - live Agent resolved from the invoking session.
   * @param id - run identity.
   */
  @Remote('cancel')
  async cancelForClient(agent: Agent, id: FlowRunId): Promise<void> {
    await this.cancel(agent, id)
  }

  /**
   * Request cancellation of one in-flight run. A run from another parent
   * session resolves as not-found rather than revealing it. If execution has
   * finished but its terminal write failed, retry that outcome without changing it.
   * @param parent - live Agent whose session started the run.
   * @param id - run identity.
   */
  async cancel(parent: Agent, id: FlowRunId): Promise<void> {
    await this.operate(async () => {
      const entry = this.requireOwnedActiveRun(parent, id)
      if (entry.settlement !== undefined) {
        await this.reconcileSettlements([id])
        return
      }
      try {
        entry.executor.cancel(id)
      } finally {
        entry.controller.abort()
      }
    })
  }

  /**
   * End one in-flight run's clarification for a browser client. Only the Agent
   * of the session that started the run may conclude it.
   * @param agent - live Agent resolved from the invoking session.
   * @param id - run identity.
   */
  @Remote('concludeConversation')
  async concludeConversationForClient(agent: Agent, id: FlowRunId): Promise<void> {
    await this.concludeConversation(agent, id)
  }

  /**
   * Ask the engine to end one in-flight run's clarification, so its
   * conversational node stops asking and states its Result word. The run keeps
   * executing; only the dialogue with the user ends. A run from another parent
   * session resolves as not-found rather than revealing it.
   * @param parent - live Agent whose session started the run.
   * @param id - run identity.
   * @throws `agent-flow/not-conversing` when no node of the run awaits the user.
   */
  async concludeConversation(parent: Agent, id: FlowRunId): Promise<void> {
    await this.operate(async () => {
      const entry = this.requireOwnedActiveRun(parent, id)
      /* v8 ignore start -- the run settled while still recorded as active. */
      if (entry.settlement !== undefined) {
        await this.reconcileSettlements([id])
        throw new RemoteError('agent-flow/run-not-active', `run ${id} has already finished executing`, { id: String(id) })
      /* v8 ignore stop */
      }
      if (!entry.executor.concludeConversation(id)) {
        throw new RemoteError('agent-flow/not-conversing', `run ${id} has no node waiting for the user`, { id: String(id) })
      }
    })
  }

  /**
   * Resolve the engine and cancellation of one in-flight run the caller owns.
   * @param parent - live Agent whose session started the run.
   * @param id - run identity.
   * @returns the run's executor and controller.
   * @throws `agent-flow/not-found` for a run another session started, and
   *   `agent-flow/run-not-active` for one that already settled.
   */
  private requireOwnedActiveRun(
    parent: Agent,
    id: FlowRunId,
  ): ActiveRun {
    const run = this.requireRun(id)
    if (run.parentSessionId !== parent.session.id) {
      throw new RemoteError('agent-flow/not-found', `unknown agent flow run: ${id}`, { kind: 'run', id: String(id) })
    }
    const entry = this.active.get(id)
    if (entry === undefined) {
      throw new RemoteError('agent-flow/run-not-active', `run ${id} is not in flight`, { id: String(id) })
    }
    return entry
  }

  /**
   * Merge one executor patch into the latest node-run entry of one node
   * durably. The read-modify-write runs on the service's operation chain, so
   * concurrent node updates never overwrite each other.
   */
  private async updateNodeRun(id: FlowRunId, nodeId: string, patch: FlowNodeRunPatch): Promise<FlowRun> {
    return await this.sequence(async () => {
      const run = this.requireActiveRun(id)
      if (!run.nodeRuns.some(entry => entry.nodeId === nodeId)) {
        throw invalid(`node "${nodeId}" is not part of run ${id}`, [
          { code: 'unknown-node', message: `node "${nodeId}" is not part of run ${id}` },
        ])
      }
      const runs = this.requireRuns()
      return await runs.update(id, (latest) => {
        const index = latestNodeRunIndex(latest, nodeId)
        const current = latest.nodeRuns[index] as FlowNodeRun
        const merged = {
          ...current,
          status: patch.status ?? current.status,
          agentSessionId: patch.agentSessionId !== undefined ? patch.agentSessionId : current.agentSessionId,
          dir: patch.dir !== undefined ? patch.dir : current.dir,
          files: patch.files !== undefined ? patch.files : current.files,
          handoff: patch.handoff !== undefined ? patch.handoff : current.handoff,
          result: patch.result !== undefined ? patch.result : current.result,
          inputs: patch.inputs !== undefined ? patch.inputs : current.inputs,
          userInput: patch.userInput !== undefined ? patch.userInput : current.userInput,
          error: patch.error !== undefined ? patch.error : current.error,
          startedAt: patch.startedAt !== undefined ? patch.startedAt : current.startedAt,
          endedAt: patch.endedAt !== undefined ? patch.endedAt : current.endedAt,
        }
        return {
          ...latest,
          nodeRuns: [...latest.nodeRuns.slice(0, index), merged, ...latest.nodeRuns.slice(index + 1)],
        }
      })
    })
  }

  /**
   * Append a fresh `running` entry for one node's next iteration. A cycle
   * re-executing a node starts a new entry instead of rewriting the last.
   */
  private async startNodeIteration(id: FlowRunId, nodeId: string): Promise<FlowRun> {
    return await this.sequence(async () => {
      const run = this.requireActiveRun(id)
      if (!run.snapshot.nodes.some(node => node.id === nodeId)) {
        throw invalid(`node "${nodeId}" is not part of run ${id}`, [
          { code: 'unknown-node', message: `node "${nodeId}" is not part of run ${id}` },
        ])
      }
      const runs = this.requireRuns()
      return await runs.update(id, latest => ({
        ...latest,
        nodeRuns: [
          ...latest.nodeRuns,
          {
            nodeId,
            iteration: latest.nodeRuns.filter(entry => entry.nodeId === nodeId).length,
            status: 'running' as const,
            startedAt: new Date().toISOString(),
          },
        ],
      }))
    })
  }

  /** Resolve one in-flight run, rejecting unknown and settled identities alike. */
  private requireActiveRun(id: FlowRunId): FlowRun {
    const run = this.requireRun(id)
    const entry = this.active.get(id)
    if (run.status !== 'running' || entry === undefined || entry.settlement !== undefined) {
      throw new RemoteError('agent-flow/run-not-active', `run ${id} is not in flight`, { id: String(id) })
    }
    return run
  }

  /** Drive one run, retaining its completed outcome until the terminal write commits. */
  private async driveRun(run: FlowRun, executor: FlowExecutor, parent: Agent, signal: AbortSignal): Promise<void> {
    const controller: FlowRunController = {
      run,
      parent,
      signal,
      updateNodeRun: (nodeId, patch) => this.updateNodeRun(run.id, nodeId, patch),
      startNodeIteration: nodeId => this.startNodeIteration(run.id, nodeId),
    }
    let result: FlowExecutionResult
    try {
      result = await executor.execute(controller)
    } catch (error) {
      result = { stopReason: 'failed', error: errorMessage(error) }
    }
    try {
      await this.sequence(async () => {
        const entry = this.active.get(run.id)
        /* v8 ignore next 1 -- only a committed settlement releases this entry. */
        if (entry === undefined) return
        entry.settlement = { result, endedAt: new Date().toISOString() }
        try {
          await this.settleRun(run.id, entry.settlement)
        } catch (error) {
          this.ctx.logger.error(`agent flow run "${String(run.id)}" terminal write failed; the outcome is retained for retry: ${errorMessage(error)}`)
          return
        }
        try {
          await this.enforceRunRetention()
        } catch (error) {
          this.ctx.logger.warn(`agent flow run retention failed: ${errorMessage(error)}`)
        }
      })
    } finally {
      this.drives.delete(run.id)
    }
  }

  /** Commit a retained terminal outcome before releasing the run's owner. */
  private async settleRun(id: FlowRunId, settlement: RunSettlement): Promise<void> {
    const runs = this.requireRuns()
    const result = settlement.result
    await runs.update(id, current => ({
      ...current,
      status: result.stopReason,
      error: result.error,
      endedAt: settlement.endedAt,
      nodeRuns: result.stopReason === 'completed'
        ? this.completedNodes(current, settlement.endedAt)
        : this.interruptedNodes(
          current,
          /* v8 ignore next 1 -- a terminal run without a recorded error names its stop reason. */
          result.error ?? (result.stopReason === 'cancelled' ? 'run cancelled' : 'run failed'),
          settlement.endedAt,
        ),
    }))
    this.active.delete(id)
  }

  /**
   * Close every node a completed execution never persisted as skipped. The
   * executor already decided those nodes were unreached; a failed skip write
   * must not leave them pending once the run publishes `completed`.
   */
  private completedNodes(run: FlowRun, endedAt: string): FlowNodeRun[] {
    return run.nodeRuns.map(node => node.status === 'pending' ? { ...node, status: 'skipped', endedAt } : node)
  }

  /** Retry only completed executions; querying a running executor never restarts it. */
  private async reconcileSettlements(ids: Iterable<FlowRunId>): Promise<void> {
    let committed = false
    for (const id of ids) {
      const settlement = this.active.get(id)?.settlement
      if (settlement === undefined) continue
      await this.settleRun(id, settlement)
      committed = true
    }
    if (committed) await this.enforceRunRetention()
  }

  /** Close orphaned records before this domain owner accepts new work. */
  private async reconcileInterruptedRuns(): Promise<void> {
    const runs = this.requireRuns()
    for (const [id, run] of runs.entries()) {
      if (run.status !== 'running' || this.active.has(id)) continue
      const endedAt = new Date().toISOString()
      const error = 'run interrupted: no live executor owns the stored running record'
      await runs.update(id, current => ({
        ...current,
        status: 'failed',
        error,
        endedAt,
        nodeRuns: this.interruptedNodes(current, error, endedAt),
      }))
    }
  }

  /** Preserve settled steps and close every unfinished step of an interrupted execution. */
  private interruptedNodes(run: FlowRun, error: string, endedAt: string): FlowNodeRun[] {
    return run.nodeRuns.map((node) => {
      if (node.status === 'pending') return { ...node, status: 'skipped', endedAt }
      if (node.status === 'running' || node.status === 'conversing') return { ...node, status: 'failed', error, endedAt }
      return node
    })
  }

  /**
   * Drop oldest settled runs beyond the configured limit; running runs are
   * never dropped. Before the last run proving one Session's occupation is
   * deleted, its durable usage row is written; a failed write keeps that run
   * so a restart cannot lose the fact.
   */
  private async enforceRunRetention(): Promise<void> {
    const runs = this.requireRuns()
    const all = [...runs.entries()].map(([, run]) => run)
    let excess = all.length - this.config.maxRuns
    if (excess <= 0) return
    const evidence = new Map<SessionId, number>()
    for (const run of all) evidence.set(run.parentSessionId, (evidence.get(run.parentSessionId) ?? 0) + 1)
    const settled = all
      .filter(run => run.status !== 'running')
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || String(a.id).localeCompare(String(b.id)))
    for (const run of settled) {
      if (excess <= 0) break
      /* v8 ignore next 1 -- every settled run was counted from the same list; the fallback only satisfies the typed Map lookup */
      const count = evidence.get(run.parentSessionId) ?? 0
      if (count <= 1 && !await this.persistUsage(run.parentSessionId, run.id, run.startedAt)) continue
      await runs.delete(run.id)
      evidence.set(run.parentSessionId, count - 1)
      excess--
    }
  }

  /** Abort in-flight runs and wait for their settlement writes before the storage unit closes. */
  private async disposeRuntime(): Promise<void> {
    this.stopping = true
    await this.operations
    const failures: unknown[] = []
    for (const [id, entry] of this.active) {
      if (entry.settlement !== undefined) continue
      try {
        /* v8 ignore next 1 -- settlement cancels only runs it still owns. */
        entry.executor.cancel(id)
      } catch (error) {
        /* v8 ignore next 1 -- an executor that refuses cancellation at settlement is contained. */
        failures.push(error)
      } finally {
        entry.controller.abort()
      }
    }
    for (const outcome of await Promise.allSettled([...this.drives.values()])) {
      /* v8 ignore next 1 -- a settlement task that rejects is contained here. */
      if (outcome.status === 'rejected') failures.push(outcome.reason)
    }
    await this.sequence(async () => {
      for (const [id, entry] of this.active) {
        /* v8 ignore next 1 -- only a run whose settlement can no longer change is skipped. */
        if (entry.settlement === undefined) continue
        try {
          await this.settleRun(id, entry.settlement)
        } catch (error) {
          failures.push(error)
        }
      }
    })
    if (failures.length > 0) throw new AggregateError(failures, 'agent flow service shutdown failed')
  }

  /** Admit a public operation only while this service accepts work. */
  private operate<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new Error('agent flow service is stopping'))
    return this.sequence(operation)
  }

  /** Serialize checks with their writes; rejection belongs only to its caller. */
  private sequence<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.operations.then(operation)
    this.operations = result.then(() => undefined, () => undefined)
    return result
  }

  /** Resolve one durable run without admitting another service operation. */
  private requireRun(id: FlowRunId): FlowRun {
    const run = this.requireRuns().get(id)
    if (run === undefined) {
      throw new RemoteError('agent-flow/not-found', `unknown agent flow run: ${id}`, { kind: 'run', id: String(id) })
    }
    return run
  }

  /** Resolve the flows table; activation completes `[Service.init]` before any caller is reachable. */
  private requireFlows(): KvTable<FlowId, FlowDocument> {
    const table = this.flows
    /* v8 ignore next 1 -- service activation gates every method behind [Service.init]. */
    if (table === undefined) throw new Error('agent flow service is not initialized')
    return table
  }

  /** Resolve the templates table; activation completes `[Service.init]` before any caller is reachable. */
  private requireTemplates(): KvTable<AgentTemplateId, AgentTemplate> {
    const table = this.templates
    /* v8 ignore next 1 -- service activation gates every method behind [Service.init]. */
    if (table === undefined) throw new Error('agent flow service is not initialized')
    return table
  }

  /** Resolve the runs table; activation completes `[Service.init]` before any caller is reachable. */
  private requireRuns(): KvTable<FlowRunId, FlowRun> {
    const table = this.runs
    /* v8 ignore next 1 -- service activation gates every method behind [Service.init]. */
    if (table === undefined) throw new Error('agent flow service is not initialized')
    return table
  }

  /** Resolve the usage table; activation completes `[Service.init]` before any caller is reachable. */
  private requireUsage(): KvTable<SessionId, SessionUsageRecord> {
    const table = this.usage
    /* v8 ignore next 1 -- service activation gates every method behind [Service.init]. */
    if (table === undefined) throw new Error('agent flow service is not initialized')
    return table
  }
}

export default AgentFlowService
