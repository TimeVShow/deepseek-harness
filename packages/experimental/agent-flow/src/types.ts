/**
 * Public Agent Flow identities, the executor seam, and service request values.
 * Persisted record types live in `./spec.ts` where their zod schemas are the
 * single source; this module owns the non-persisted contracts.
 * @module @deepseek-ai/dsh-experimental-agent-flow/types
 */

import type { Agent } from '@deepseek-ai/dsh-agent/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AgentTemplate, FlowDocument, FlowNodeRun, FlowRun } from './spec.ts'

/** Identifies one saved flow document. */
export type FlowId = Branded<'FlowId'>

/**
 * Brand a string as a {@link FlowId}.
 * @param id - the raw id.
 * @returns the same string, branded.
 */
export function FlowId(id: string): FlowId {
  return id as FlowId
}

/** Identifies one saved agent template. */
export type AgentTemplateId = Branded<'AgentTemplateId'>

/**
 * Brand a string as an {@link AgentTemplateId}.
 * @param id - the raw id.
 * @returns the same string, branded.
 */
export function AgentTemplateId(id: string): AgentTemplateId {
  return id as AgentTemplateId
}

/** Identifies one persisted flow run. */
export type FlowRunId = Branded<'FlowRunId'>

/**
 * Brand a string as a {@link FlowRunId}.
 * @param id - the raw id.
 * @returns the same string, branded.
 */
export function FlowRunId(id: string): FlowRunId {
  return id as FlowRunId
}

/** Mutable save request for a flow; the service fills identity, the iteration bound, and timestamps. */
export type FlowDraft = Omit<FlowDocument, 'id' | 'maxIterations' | 'createdAt' | 'updatedAt'> & {
  readonly id?: FlowId | undefined
  /** Bound on total agent-node executions per run; defaults to 16. */
  readonly maxIterations?: number | undefined
}

/** Mutable save request for a template; the service fills identity and timestamps. */
export type AgentTemplateDraft = Omit<AgentTemplate, 'id' | 'createdAt' | 'updatedAt'> & {
  readonly id?: AgentTemplateId | undefined
}

/** Fields an executor merges into one node-run entry; absent fields keep stored values. */
export interface FlowNodeRunPatch {
  status?: FlowNodeRun['status'] | undefined
  agentSessionId?: SessionId | undefined
  inputs?: FlowNodeRun['inputs'] | undefined
  userInput?: boolean | undefined
  dir?: string | undefined
  files?: string[] | undefined
  handoff?: string | undefined
  result?: string | undefined
  error?: string | undefined
  startedAt?: string | undefined
  endedAt?: string | undefined
}

/** Terminal outcome an executor reports for one run. */
export interface FlowExecutionResult {
  readonly stopReason: 'completed' | 'cancelled' | 'failed'
  readonly error?: string | undefined
}

/** Run-scoped surface the service hands one executor. */
export interface FlowRunController {
  /** The started run record as persisted in `running` state. */
  readonly run: FlowRun
  /** Live parent Agent under whose lineage the executor spawns node agents. */
  readonly parent: Agent
  /** Cancellation signal for the whole run; fires on caller abort or service `cancel`. */
  readonly signal: AbortSignal
  /**
   * Merge one patch into the latest node-run entry of one node durably.
   * @param nodeId - document node identity from the run snapshot.
   * @param patch - fields to merge; absent fields keep their stored values.
   * @returns the stored run after the write lands.
   */
  updateNodeRun(nodeId: string, patch: FlowNodeRunPatch): Promise<FlowRun>
  /**
   * Append a fresh `running` entry for one node's next iteration. Called when
   * a cycle re-executes a node; the appended entry becomes the node's latest.
   * @param nodeId - document node identity from the run snapshot.
   * @returns the stored run after the write lands.
   */
  startNodeIteration(nodeId: string): Promise<FlowRun>
}

/**
 * One registered execution engine for flow runs. Executors are trusted
 * same-process implementations: they receive the live parent Agent and treat
 * all persisted values as borrowed immutable data.
 */
export interface FlowExecutor {
  /** Registry name; the service's `executor` config selects the default. */
  readonly name: string
  /**
   * Execute one accepted run to settlement. Resolves with the run's terminal
   * outcome; may reject only on an infrastructure fault the outcome cannot
   * express.
   * @param controller - run state, parent, cancellation, and node-run persistence.
   */
  execute(controller: FlowRunController): Promise<FlowExecutionResult>
  /** Request cancellation of one in-flight run owned by this executor. */
  cancel(runId: FlowRunId): void
  /**
   * End one in-flight run's clarification early, on the user's behalf. An
   * engine that drives no conversation, or whose conversation already settled,
   * reports that it had nothing to conclude.
   * @param runId - run identity.
   * @returns whether a conversation was open to conclude.
   */
  concludeConversation(runId: FlowRunId): boolean
}

/** Caller request to start one run of a saved flow. */
export interface FlowStartRequest {
  readonly flowId: FlowId
  /** The user message the run starts from. */
  readonly input: string
  /** Caller cancellation for the whole run. */
  readonly signal: AbortSignal
}

/** Remote request to start one run; cancellation arrives as the trailing remote signal. */
export interface FlowStartRemoteRequest {
  readonly flowId: FlowId
  /** The user message the run starts from. */
  readonly input: string
}

/** Service configuration: default executor selection and count limits. */
export interface Config {
  /** Registry name of the executor `start` selects. */
  executor?: string
  /** Maximum saved flow documents. */
  maxFlows?: number
  /** Maximum saved agent templates. */
  maxTemplates?: number
  /** Maximum persisted runs; oldest settled runs are dropped beyond it. */
  maxRuns?: number
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No record supplies the requested identity. */
    'agent-flow/not-found': { readonly kind: 'flow' | 'template' | 'run'; readonly id: string }
    /** The document or request failed validation; `problems` lists every violation. */
    'agent-flow/invalid': { readonly problems: readonly { readonly code: string; readonly message: string }[] }
    /** A count limit from configuration was reached. */
    'agent-flow/limit': { readonly limit: number; readonly kind: 'flows' | 'templates' | 'runs' }
    /** The template is referenced by saved flows and cannot be deleted. */
    'agent-flow/template-in-use': { readonly id: string; readonly flows: readonly string[] }
    /** The flow has in-flight runs and cannot be deleted. */
    'agent-flow/flow-in-use': { readonly id: string; readonly runs: readonly string[] }
    /** The run is not in-flight, so it cannot be cancelled or driven. */
    'agent-flow/run-not-active': { readonly id: string }
    /** No node of the in-flight run is waiting for the user, so there is no clarification to end. */
    'agent-flow/not-conversing': { readonly id: string }
    /** The configured executor is not registered. */
    'agent-flow/executor-missing': { readonly executor: string; readonly registered: readonly string[] }
  }
}

export type {
  AgentTemplate,
  FlowDocument,
  FlowEdge,
  FlowNode,
  FlowNodeRun,
  FlowRun,
} from './spec.ts'
