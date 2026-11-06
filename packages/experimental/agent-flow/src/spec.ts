/**
 * Durable record vocabulary and the storage-domain declaration. The zod
 * schemas are the single source of the persisted types: they validate every
 * record at the durability boundary and project to future RPC wire schemas.
 * @module @deepseek-ai/dsh-experimental-agent-flow/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { AgentTemplateId, FlowId, FlowRunId } from './types.ts'

/** Flow id schema at the durable boundary; branding has no runtime representation. */
const flowId = z.string().transform(value => FlowId(value))

/** Agent template id schema at the durable boundary. */
const agentTemplateId = z.string().transform(value => AgentTemplateId(value))

/** Flow run id schema at the durable boundary. */
const flowRunId = z.string().transform(value => FlowRunId(value))

/** Session id schema at the durable boundary. */
const sessionId = z.string().transform(value => value as SessionId)

/** Canvas placement of one node; absent until an editor writes it. */
const nodePosition = z.object({ x: z.number(), y: z.number() })

/** One node in a flow graph; ids are unique per document and match `^[A-Za-z0-9_-]+$`. */
const flowNode = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('start'), id: z.string(), title: z.string().optional(), position: nodePosition.optional() }),
  z.object({
    kind: z.literal('agent'),
    id: z.string(),
    title: z.string().optional(),
    position: nodePosition.optional(),
    /** Template defining the spawned agent's persona and model route. */
    templateId: agentTemplateId,
    /** What this step does; the runtime assembles the complete prompt. */
    instruction: z.string(),
    /** Retired source selection is rejected; explicit input edges own additional references. */
    context: z.never({ error: 'context.sources is unsupported; replace it with explicit input edges after reviewing execution handoffs' }).optional(),
    /**
     * Marks the flow's single user-facing node: the one that clarifies the
     * request with the user before handing off. It owes a Result word even when
     * nothing routes it, so a turn that closes without one is an unfinished
     * conversation rather than a completed node.
     */
    interactive: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('join'),
    id: z.string(),
    title: z.string().optional(),
    position: nodePosition.optional(),
    /** Wait for every selected execution branch; `any` graphs require an explicit redesign. */
    mode: z.literal('all', { error: 'join.mode must be all; legacy any joins are unsupported' }),
  }),
  z.object({
    /**
     * Routes on the Result word of its single incoming agent node: exactly one
     * outgoing edge activates, the one whose word matches. It produces no
     * content of its own and forwards that agent's handoff to its targets.
     */
    kind: z.literal('condition'),
    id: z.string(),
    title: z.string().optional(),
    position: nodePosition.optional(),
  }),
  z.object({ kind: z.literal('end'), id: z.string(), title: z.string().optional(), position: nodePosition.optional() }),
])

/**
 * One directed connection. Execution edges activate targets and hand off their
 * source results. Input edges only reference results already available to an
 * agent; an input edge from start explicitly selects the original user request.
 */
const flowEdge = z.object({
  kind: z.enum(['execution', 'input'], { error: 'edge.kind must explicitly be execution or input; legacy untyped edges are unsupported' }),
  from: z.string(),
  to: z.string(),
  /** Routing word of a condition node's execution edge; absent on input edges. */
  result: z.string().optional(),
})

/** A saved flow graph. */
export const flowDocumentRecord = z.object({
  id: flowId,
  name: z.string(),
  description: z.string().optional(),
  /** Bound on total agent-node executions per run; semantic range is validated at save. */
  maxIterations: z.number(),
  nodes: z.array(flowNode),
  edges: z.array(flowEdge),
  /** ISO-8601 creation timestamp, preserved across saves. */
  createdAt: z.string(),
  /** ISO-8601 timestamp of the last accepted save. */
  updatedAt: z.string(),
})

/**
 * One user-authored agent definition. Fields map onto the subagent seam's
 * start-time options, so a node agent is fully determined by its template
 * plus the prompt the runtime assembles for the node.
 */
export const agentTemplateRecord = z.object({
  id: agentTemplateId,
  name: z.string(),
  description: z.string().optional(),
  /** Persona text shadowing the deployment persona for spawned agents. */
  persona: z.string().optional(),
  /** Provider route override for spawned agents. */
  provider: z.string().optional(),
  /** Model id override for spawned agents. */
  model: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** One execution of one node inside a run; a node re-executing in a loop appends entries. */
const flowNodeRunRecord = z.object({
  nodeId: z.string(),
  /** How many times this node executed before this entry; the first execution is 0. */
  iteration: z.number().int().min(0),
  /** `conversing` is an interactive node whose turn closed without a Result, so it waits for the user. */
  status: z.enum(['pending', 'running', 'conversing', 'succeeded', 'failed', 'skipped']),
  /** Child session identity for navigation from the run view. */
  agentSessionId: sessionId.optional(),
  /** Exact task executions whose results this execution consumed. */
  inputs: z.array(z.object({ nodeId: z.string(), iteration: z.number().int().min(0) })).optional(),
  /** Whether an explicit input edge selected the run's original user request. */
  userInput: z.boolean().optional(),
  /** Absolute workspace directory this execution wrote into. */
  dir: z.string().optional(),
  /** Absolute paths found in `dir` after the execution settled; derived, never declared. */
  files: z.array(z.string()).optional(),
  /** Final assistant message of the execution. */
  handoff: z.string().optional(),
  /** Result word an agent emitted, or the one a condition node routed on. */
  result: z.string().optional(),
  /** Failure detail for a `failed` entry. */
  error: z.string().optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
})

/** One persisted run of a flow. */
const flowRunRecord = z.object({
  id: flowRunId,
  flowId: flowId,
  /** Whole-document snapshot taken when the run started; the run never follows later saves. */
  snapshot: flowDocumentRecord,
  /** Session under whose lineage node agents are spawned. */
  parentSessionId: sessionId,
  status: z.enum(['running', 'completed', 'cancelled', 'failed']),
  /** The user message the run started from. */
  input: z.string(),
  nodeRuns: z.array(flowNodeRunRecord),
  /** Run-level failure detail for a `failed` run. */
  error: z.string().optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
})

/**
 * First recorded use of one Session as a run's parent. The row is written once
 * per Session and never rewritten: run records themselves are capped by
 * `maxRuns`, while this table keeps the Session's usage durable after every
 * run that justified it has been evicted.
 */
const sessionUsageRecord = z.object({
  /** The run whose successful start first occupied the Session. */
  runId: flowRunId,
  /** ISO-8601 timestamp of that run's start. */
  startedAt: z.string(),
})

/** One node in a flow graph. */
export type FlowNode = z.infer<typeof flowNode>

/** One directed connection in a flow graph. */
export type FlowEdge = z.infer<typeof flowEdge>

/** A saved, validated flow graph. */
export type FlowDocument = z.infer<typeof flowDocumentRecord>

/** One user-authored agent definition. */
export type AgentTemplate = z.infer<typeof agentTemplateRecord>

/** One execution of one node inside a run. */
export type FlowNodeRun = z.infer<typeof flowNodeRunRecord>

/** One persisted run of a flow. */
export type FlowRun = z.infer<typeof flowRunRecord>

/** First recorded use of one Session as a run's parent. */
export type SessionUsageRecord = z.infer<typeof sessionUsageRecord>

/**
 * The Agent Flow storage domain. `per-record` layout keeps each flow,
 * template, and run as its own document, because runs update frequently and
 * carry sizable node outputs. Version 3 is retained: unsupported legacy graphs
 * fail schema validation without discarding their stored records. Untyped
 * edges, context.sources, and any joins require explicit user conversion. The
 * `usage` table is additive under the per-record layout: its rows are stamped
 * with the current version and old units open without it.
 */
export const agentFlowDomain = defineDomain({
  name: 'agent_flow',
  version: 3,
  layout: 'per-record',
  tables: {
    templates: domainTable<AgentTemplateId, AgentTemplate>(agentTemplateRecord),
    flows: domainTable<FlowId, FlowDocument>(flowDocumentRecord),
    runs: domainTable<FlowRunId, FlowRun>(flowRunRecord),
    usage: domainTable<SessionId, SessionUsageRecord>(sessionUsageRecord),
  },
})
