# Agent Flow

English | [中文](agent-flow.zh.md)

Types shared by the experimental fixed-workflow domain, its graph execution provider, and Web adapters. The [Agent Flow Agent Note](../../.agents/notes/implemented/architecture/2026-09-24-agent-flow-plugin-seams.md) owns the seam decisions; this page records the durable and client-visible forms from [`packages/experimental/agent-flow/src/types.ts`](../../packages/experimental/agent-flow/src/types.ts) and [`src/spec.ts`](../../packages/experimental/agent-flow/src/spec.ts). The [entry input default note](../../.agents/notes/implemented/architecture/2026-11-08-agent-flow-entry-input-default.md) owns the entry request rule.

## Identity

`FlowId`, `AgentTemplateId`, and `FlowRunId` are random globally-unique strings under distinct [brands](core.md#branded-ids). A run binds the complete flow document it started from, so later document saves never affect an in-flight or settled run.

## Agent templates

One template names a reusable agent definition: an optional `persona` and optional `provider` and `model` route overrides. The fields map one-to-one onto the subagent seam's start-time options, so a node agent is fully determined by its template plus the prompt the runtime assembles for the node.

## Flow documents

A document declares `start`, `agent`, `condition`, `join`, and `end` nodes with unique ids matching `^[A-Za-z0-9_-]+$`. An agent node is a task performed by a template-defined role. Every edge has a required `kind`: `execution` advances work and hands off source results; `input` adds an existing result reference without scheduling either endpoint. A Start execution successor (an entry node) receives the run's original request by default; a start input edge adds it to any other node. Input targets must be agent nodes, and their sources must be guaranteed available on that execution path. One optional interactive task may be the single entry and opens a root Session for human replies; its opening turn logs runtime rules with source `agent-flow` and the original request as a user message.

A condition reads the final `Result: <word>` from its single agent predecessor and selects exactly one execution edge with the matching word. It transparently forwards that task result; an all join merges effective branch results. Ordinary tasks also wait for all effective execution predecessors without requiring an explicit join. Unselected branches do not block a merge, while failed or cancelled work stops the run. A task outputs only its own final explanation and artifact references; upstream inputs are not inherited transitively. A separate input edge adds a required earlier result, and absence fails before model work starts.

## Supported graphs

Save-time validation analyzes the complete execution graph and accepts parallel DAGs and single-entry serial review loops. It rejects unconditional cycles, parallel forks or merges inside loops, missing execution paths, and unsupported `any` joins. Input edges do not affect control reachability or cycles. A loop uses alternative first and return entries: the first round does not wait for review, and later rounds reuse completed external dependencies while binding internal results to the current round. `maxIterations` bounds total agent executions. Graphs with missing edge kinds or legacy `context.sources` require explicit conversion; invalid stored records cause activation to fail without deleting their original data. A legacy `context.sources` list could suppress an execution predecessor's handoff; an input edge cannot express that exclusion, so conversion means recreating the flow under the current rules rather than appending input edges.

### Support matrix

`X@n` is node `X`'s iteration-`n` execution. "Receives" lists the task executions whose handoff reaches the task; an explicit input edge adds its source result, and the same source execution appears once. Save-time analysis and the graph executor use the same rules.

| Case | Save | Executions | Task receives | Unselected branches | Terminal | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Linear `start→A→B→end` | accepted | `A@0`, `B@0` | A: original request; B: `A@0` | — | completed | `runs a linear pipeline with file handoffs...` |
| Default entry request, start execution (no input line needed) | accepted | `A@0` | A: original request, no task result | — | completed | `injects the original request into the entry node only` |
| Ancestor input `A→B→C` plus `A⇢C` | accepted | `A@0`, `B@0`, `C@0` | A: original request; C: `B@0`, `A@0` | — | completed | `injects the original request into the entry node only`; `hands the selected branch through an all join...` |
| Ordinary multi-predecessor all `A,B→C` | accepted | `A@0`, `B@0`, `C@0` | C: `A@0`, `B@0` once | — | completed | `waits for all direct execution predecessors...` |
| Explicit all `A,B→J→C` | accepted | `A@0`, `B@0`, `J@0`, `C@0` | C: `A@0`, `B@0` | — | completed | `passes all branch results through an explicit join` |
| Condition `A→cond→{left,right}` | accepted | A, cond, selected branch | selected branch: `A@0` forwarded by cond | unchosen branch skipped | completed | `routes on the Result line through a condition node...` |
| Condition plus all `A→cond→{J,B→J}→T`, `A⇢T` | accepted | A, cond, selected branch, J, T | direct: T `A@0` (input deduped); indirect: T `B@0`, `A@0` | unchosen branch skipped | completed | `hands the selected branch through an all join and keeps an explicit extra input` |
| Serial rework `D→E→R→cond→{E,end}` | accepted | `D@0`; E, R, cond per round | E: `D@0` plus `R@previous`; R: current E | loop body re-runs with new iterations | completed | `reuses the external design while each review reads the current implementation`; `re-executes loop nodes...` |
| Chained review blocks (two serial loops) | accepted | each block per its own rounds | second head receives the first block's exit result; external loop results stay available | — | completed | `runs two serial review blocks in sequence` |
| Every effective arrival unselected | accepted | only the selected path | no task runs on a fully unselected path | every node on it skipped | completed | `routes on the Result line...`; `skips a whole unselected loop...` |
| Node failure | accepted | until the failing node | completed predecessors keep their records | unreached nodes skipped; in-flight siblings fail as `run cancelled` | failed | `fails the run on a node failure, aborts its siblings...` |
| Cancellation | accepted | until the cancel | completed predecessors keep their records | pending nodes skipped; the active node fails as `run cancelled` | cancelled after quiescence | `settles a cancelled run...`; lifecycle cancellation regression |
| Interactive entry | accepted when it is the only entry | interactive node, then remaining nodes after its Result | later nodes: the interactive node's result | — | completed after Result; cancelled with the run | `settles an interactive node on the Result word...`; `cancels the live conversation...` |
| Statically invalid input | rejected with `invalid-source` | none | — | — | not started | `rejects future and self inputs...`; `respects exclusive condition paths...` |
| Runtime-only missing input | not reachable through current save validation; the executor still guards stored snapshots | target fails before model or tool work | — | — | failed | `fails a target before model work when its stored input source never ran` |
| Parallel merge inside a loop | rejected with `parallel-loop` | none | — | — | not started | `rejects parallel fanout or fanin inside a review region...` |
| `any` join, untyped edge, or `context.sources` | rejected by the record schema | none | — | — | stored record retained; explicit conversion required | `stored graph admission`; `refuses legacy sources overrides and any joins...` |

An explicit input adds only the named source execution; it never inherits that task's own inputs. A task that writes no files is valid with an empty `files` list, and a missing artifact reference does not fail a task by itself.

### Local artifact scope

The runtime reads and writes the Host filesystem shared by the run's parent Session. Node prompts carry absolute paths under `<cwd>/.dsh/flows/<runId>/<NN>-<nodeId>/`, and `files` is derived by scanning that directory after the node settles. This is the supported execution environment. A provider that runs node agents in another filesystem, such as a remote container or another host, is not supported: the runtime neither transfers artifacts nor detects path divergence, so such a run reports no files and downstream prompts point at paths that do not exist. Remote support requires an explicit artifact-transfer seam; it is not obtained by changing path strings. A node that writes no files remains valid.

An iteration directory is also the node's write boundary on every host: the node Session's immutable header cwd is that directory, so the host's existing sandbox policy confines its file tools and subprocesses there. A worker carries the directory in a per-node carrier Session whose header cwd is the iteration directory; the subagent child inherits it, and the carrier runs no turn and is disposed with the child. An interactive conversation records the directory as its own header cwd. Upstream deliveries stay readable but cannot be overwritten, deleted, renamed, or replaced, and a node's delegated children inherit the same root. A node copies the upstream material it needs into its own directory before changing it. No host package requires a flow-specific permission interface.

## Runs

A run binds its document snapshot, parent Session, and original request. Each `nodeRuns` entry identifies one node execution with an incrementing `iteration`, its status, final `handoff`, artifact `files`, routing `result`, and navigation Session id. `inputs` records the exact source task executions, and `userInput` records whether the run's original request reaches that task (entry default or explicit input edge). The run settles to `completed`, `cancelled`, or `failed`; completion requires a successful end and all effective work to settle, and an interactive exit commits only after the executor cancels its remaining runtime-owned turns and their tool work reaches quiescence. A completed terminal write also closes every node left pending by a failed skip write. Interrupted ownerless runs become failed on service activation without replaying work. Terminal-write failures retain their owned result for reconciliation. Oldest settled runs drop beyond `maxRuns`.

## Executor seam

Execution is a registry: the service's `executor` config names the engine, and a trusted same-process provider registers itself — [`agent-flow-runtime`](../../packages/experimental/agent-flow-runtime/README.md) ships the `graph` interpreter. The service persists the running record before the engine begins and hands it a controller with node-run persistence and the run's cancellation signal. Disposing the executor registration cancels and settles every active run that executor still owns before it resolves. Registration removal and run admission share the service queue, so a run cannot enter an executor after it has been unregistered.

```ts type-equiv
/** Caller request to start one run of a saved flow. */
interface FlowStartRequest {
  readonly flowId: FlowId
  /** The user message the run starts from. */
  readonly input: string
  /** Caller cancellation for the whole run. */
  readonly signal: AbortSignal
}
```

```ts type-equiv
/** Run-scoped surface the service hands one executor. */
interface FlowRunController {
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
```

```ts type-equiv
/**
 * One registered execution engine for flow runs. Executors are trusted
 * same-process implementations: they receive the live parent Agent and treat
 * all persisted values as borrowed immutable data.
 */
interface FlowExecutor {
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
```

The package [README](../../packages/experimental/agent-flow/README.md) owns mounting, configuration limits, and failure vocabulary.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxagentflows--agentflowservice"></a>

### `ctx.agentFlows` — `AgentFlowService`

Agent Flow service over one storage domain. Template and flow saves fail loud with every validation problem; runs persist before execution starts and settle exactly once through the registered executor.

```ts cordis-catalog
/**
 * Register one execution engine.
 * @param executor - trusted same-process implementation.
 * @returns the disposer removing the registration and settling the runs it
 *   still owns, so unloading a provider never leaves an ownerless run.
 */
registerExecutor(executor: FlowExecutor): () => Promise<void>

/** Read every template in display order.
 * @returns stored templates sorted by name, then id.
 */
@Remote('listTemplates') listTemplates(): Promise<AgentTemplate[]>

/**
 * Resolve one template.
 * @param id - template identity.
 * @returns the stored template.
 */
@Remote('readTemplate') readTemplate(id: AgentTemplateId): Promise<AgentTemplate>

/**
 * Create or replace one template.
 * @param draft - template fields; an absent id creates a new identity.
 * @returns the stored template.
 */
@Remote('saveTemplate') async saveTemplate(draft: AgentTemplateDraft): Promise<AgentTemplate>

/**
 * Delete one template.
 * @param id - template identity.
 */
@Remote('deleteTemplate') async deleteTemplate(id: AgentTemplateId): Promise<void>

/** Read every flow document in display order.
 * @returns stored documents sorted by name, then id.
 */
@Remote('listFlows') listFlows(): Promise<FlowDocument[]>

/**
 * Resolve one flow document.
 * @param id - flow identity.
 * @returns the stored document.
 */
@Remote('readFlow') readFlow(id: FlowId): Promise<FlowDocument>

/**
 * Create or replace one flow document. A save validates the complete graph
 * and every template reference, and rejects with all problems at once.
 * @param draft - document fields; an absent id creates a new identity.
 * @returns the stored document.
 */
@Remote('saveFlow') async saveFlow(draft: FlowDraft): Promise<FlowDocument>

/**
 * Delete one flow document. Settled run records keep their snapshots and stay readable.
 * @param id - flow identity.
 */
@Remote('deleteFlow') async deleteFlow(id: FlowId): Promise<void>

/**
 * Read persisted runs, newest first.
 * Retries completed outcomes whose terminal write previously failed.
 * @returns run records sorted by start time, newest first.
 */
@Remote('listRuns') async listRuns(): Promise<FlowRun[]>

/**
 * Resolve one run record, retrying a pending terminal write before returning.
 * @param id - run identity.
 * @returns the stored run.
 */
@Remote('readRun') async readRun(id: FlowRunId): Promise<FlowRun>

/**
 * Start one run of a saved flow. The run record persists in `running` state
 * before the registered executor begins, so every observer reads committed
 * state. Settlement happens in the background and lands on the same record.
 * @param parent - live Agent under whose lineage node agents are spawned.
 * @param request - flow identity, the user message, and caller cancellation.
 * @returns the persisted running record.
 */
async start(parent: Agent, request: FlowStartRequest): Promise<FlowRun>

/**
 * Start one run for a browser client. The Gateway resolves the invoking
 * session's live Agent, which becomes the run's parent.
 * @param agent - live Agent resolved from the invoking session.
 * @param request - flow identity and the user message.
 * @param signal - remote cancellation for the whole run.
 * @returns the persisted running record.
 */
@Remote('start') async startForClient(agent: Agent, request: FlowStartRemoteRequest, signal: AbortSignal): Promise<FlowRun>

/**
 * Cancel one in-flight run for a browser client. Only the Agent of the
 * session that started the run may cancel it.
 * @param agent - live Agent resolved from the invoking session.
 * @param id - run identity.
 */
@Remote('cancel') async cancelForClient(agent: Agent, id: FlowRunId): Promise<void>

/**
 * Request cancellation of one in-flight run. A run from another parent
 * session resolves as not-found rather than revealing it. If execution has
 * finished but its terminal write failed, retry that outcome without changing it.
 * @param parent - live Agent whose session started the run.
 * @param id - run identity.
 */
async cancel(parent: Agent, id: FlowRunId): Promise<void>

/**
 * End one in-flight run's clarification for a browser client. Only the Agent
 * of the session that started the run may conclude it.
 * @param agent - live Agent resolved from the invoking session.
 * @param id - run identity.
 */
@Remote('concludeConversation') async concludeConversationForClient(agent: Agent, id: FlowRunId): Promise<void>

/**
 * Ask the engine to end one in-flight run's clarification, so its
 * conversational node stops asking and states its Result word. The run keeps
 * executing; only the dialogue with the user ends. A run from another parent
 * session resolves as not-found rather than revealing it.
 * @param parent - live Agent whose session started the run.
 * @param id - run identity.
 * @throws `agent-flow/not-conversing` when no node of the run awaits the user.
 */
async concludeConversation(parent: Agent, id: FlowRunId): Promise<void>
```

Types: [Agent](core.md)

Source: [`packages/experimental/agent-flow/src/index.ts`](../../packages/experimental/agent-flow/src/index.ts)
<!-- END GENERATED cordis-surface -->
