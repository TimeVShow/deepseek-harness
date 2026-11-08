# Agent Flow

[English](agent-flow.md) | 中文

实验性固定工作流领域、其图执行 provider 与 Web 适配器共享的类型。[Agent Flow Agent Note](../../.agents/notes/implemented/architecture/2026-09-24-agent-flow-plugin-seams.zh.md) 拥有接缝决策；本页记录来自 [`packages/experimental/agent-flow/src/types.ts`](../../packages/experimental/agent-flow/src/types.ts) 与 [`src/spec.ts`](../../packages/experimental/agent-flow/src/spec.ts) 的持久与客户端可见形态。 [入口默认输入记录](../../.agents/notes/implemented/architecture/2026-11-08-agent-flow-entry-input-default.zh.md)拥有入口请求规则。

## Identity

`FlowId`、`AgentTemplateId` 与 `FlowRunId` 是不同[品牌](core.zh.md#branded-ids)之下的随机全局唯一字符串。一次运行绑定它启动时的完整流程文档，因此后续文档保存不会影响在途或已结算的运行。

## Agent templates

一个模板命名一个可复用的 agent 定义：可选的 `persona` 与可选的 `provider`、`model` 路由覆盖。这些字段与 subagent 接缝的启动期选项一一对应，因此一个节点 agent 完全由其模板加运行时为其组装的提示词决定。

## Flow documents

文档声明 `start`、`agent`、`condition`、`join` 与 `end` 节点，唯一 id 匹配 `^[A-Za-z0-9_-]+$`。agent 节点表示由模板定义的角色执行的任务。每条边都有必填 `kind`：`execution` 推进工作并交接来源结果；`input` 补充已有结果引用，不调度任何端点。start 的直接执行后继（入口节点）默认接收本轮原始请求；start 输入边可把请求加入其他节点。输入目标必须是 agent 节点，且来源在该执行路径上保证可用。一个可选的交互任务可以作为唯一入口，并打开供人类回复的 root 会话；它的开场轮次把运行时规则记录为 `agent-flow` 上下文，并把原始请求作为用户消息单独记录。

条件节点读取唯一 agent 前驱最终的 `Result: <词>`，恰好选择路由词匹配的一条执行边。它透明转交该任务结果；all 汇合合并有效分支结果。普通任务也等待全部有效执行前驱，无需显式汇合节点。未选分支不阻塞汇合；失败或取消的工作会停止运行。任务只输出自己的最终说明与产物引用，不传递式继承上游输入。单独的输入边补充必需的先前结果；缺失时在模型工作开始前失败。

## Supported graphs

保存校验分析完整执行图，接受并行 DAG 与单入口串行审查回环。校验器拒绝无条件环、回环内并行分叉或汇入、缺失执行路径及不支持的 `any` 汇合。输入边不影响控制可达性或回环。回环采用替代的首次入口与返回入口：首轮不等待审查，后续轮次复用已完成的外部依赖，内部结果绑定本轮。`maxIterations` 限制 agent 执行总次数。缺少边类型或带旧 `context.sources` 的图需要显式转换；无效存储记录使激活失败，不删除原始数据。旧 `context.sources` 曾能排除某个执行前驱的交接；输入边无法表达这种排除，因此转换应在新规则下重建流程，而不是追加几条输入边。

### 支持矩阵

`X@n` 表示节点 `X` 的第 `n` 次执行。“收到”列出其交接会到达该任务的任务执行；显式输入边追加来源结果，同一来源执行只出现一次。保存分析与图执行器使用同一套规则。

| 案例 | 保存 | 执行 | 任务收到 | 未选分支 | 终态 | 证据 |
| --- | --- | --- | --- | --- | --- | --- |
| 线性 `start→A→B→end` | 接受 | `A@0`、`B@0` | A：原始请求；B：`A@0` | — | completed | `runs a linear pipeline with file handoffs...` |
| 默认入口请求：仅 start 执行边（无需输入线） | 接受 | `A@0` | A：原始请求，无任务结果 | — | completed | `injects the original request into the entry node only` |
| 祖先输入 `A→B→C` 加 `A⇢C` | 接受 | `A@0`、`B@0`、`C@0` | A：原始请求；C：`B@0`、`A@0` | — | completed | `injects the original request into the entry node only`；`hands the selected branch through an all join...` |
| 普通多前驱 all `A,B→C` | 接受 | `A@0`、`B@0`、`C@0` | C：`A@0`、`B@0` 各一次 | — | completed | `waits for all direct execution predecessors...` |
| 显式 all `A,B→J→C` | 接受 | `A@0`、`B@0`、`J@0`、`C@0` | C：`A@0`、`B@0` | — | completed | `passes all branch results through an explicit join` |
| 条件 `A→cond→{left,right}` | 接受 | A、cond、被选分支 | 被选分支：cond 转发的 `A@0` | 未选分支 skipped | completed | `routes on the Result line through a condition node...` |
| 条件 + all `A→cond→{J,B→J}→T`，`A⇢T` | 接受 | A、cond、被选分支、J、T | direct：T 收到 `A@0`（输入去重）；indirect：T 收到 `B@0`、`A@0` | 未选分支 skipped | completed | `hands the selected branch through an all join and keeps an explicit extra input` |
| 串行返工 `D→E→R→cond→{E,end}` | 接受 | `D@0`；E、R、cond 按轮次 | E：`D@0` 加 `R@上一轮`；R：本轮 E | 回环体以新迭代重跑 | completed | `reuses the external design while each review reads the current implementation`；`re-executes loop nodes...` |
| 串联审查块（两个串行回环） | 接受 | 每个块按自己的轮次 | 第二块入口收到第一块的退出结果；外部回环结果持续可用 | — | completed | `runs two serial review blocks in sequence` |
| 全部有效来路未选 | 接受 | 只执行被选路径 | 完全未选的路径上没有任务运行 | 该路径上的节点全部 skipped | completed | `routes on the Result line...`；`skips a whole unselected loop...` |
| 节点失败 | 接受 | 直到失败节点 | 已完成前驱保留记录 | 未到达节点 skipped；在途兄弟以 `run cancelled` 失败 | failed | `fails the run on a node failure, aborts its siblings...` |
| 取消 | 接受 | 直到取消 | 已完成前驱保留记录 | pending 节点 skipped；活动节点以 `run cancelled` 失败 | 静止后 cancelled | `settles a cancelled run...`；生命周期取消回归 |
| 交互入口 | 仅当它是唯一入口时接受 | 交互节点，Result 后继续其余节点 | 后续节点：交互节点的结果 | — | Result 后 completed；随运行取消 | `settles an interactive node on the Result word...`；`cancels the live conversation...` |
| 静态无效输入 | 以 `invalid-source` 拒绝 | 无 | — | — | 未启动 | `rejects future and self inputs...`；`respects exclusive condition paths...` |
| 运行时才发现缺失的输入 | 当前保存校验不会放行；执行器仍防御已存快照 | 目标在模型或工具工作前失败 | — | — | failed | `fails a target before model work when its stored input source never ran` |
| 回环内并行汇合 | 以 `parallel-loop` 拒绝 | 无 | — | — | 未启动 | `rejects parallel fanout or fanin inside a review region...` |
| `any` 汇合、无类型边或 `context.sources` | 记录 schema 拒绝 | 无 | — | — | 原记录保留；需要显式转换 | `stored graph admission`；`refuses legacy sources overrides and any joins...` |

显式输入只追加被点名的来源执行，不继承该任务自身的输入。不写文件的任务以空 `files` 列表合法存在，缺少产物引用本身不会让任务失败。

### 本地产物范围

运行时读写运行父 Session 共享的 Host 文件系统。节点提示词携带 `<cwd>/.dsh/flows/<runId>/<NN>-<nodeId>/` 下的绝对路径，`files` 在节点结算后扫描该目录派生。这是受支持的执行环境。若 provider 把节点 agent 放到另一个文件系统（远程容器或另一台主机），不受支持：运行时既不传输产物，也不检测路径分歧，因此这类运行会报告空 `files`，下游提示词指向不存在的路径。远程支持需要显式的产物传输 seam，不能只改路径字符串。不写文件的任务仍然合法。

在每个宿主上，迭代目录同时是节点的写入边界：节点会话不可变的 header cwd 就是该目录，因此宿主现有的 sandbox policy 会把它的文件工具与子进程限制在那里。工作节点通过每个节点一个的 carrier 会话承载该目录：carrier 的 header cwd 是迭代目录，子 agent 继承它；carrier 不运行轮次，并随子级一起处置。交互对话把该目录记录为自己的 header cwd。上游交付物仍可读取，但不能被覆盖、删除、重命名或替换；节点派生的子级继承同一根目录。节点需要修改上游材料时，先复制到自己的目录。任何宿主包都不需要 Flow 专用的权限接口。

## Runs

运行绑定其文档快照、父 Session 与原始请求。每个 `nodeRuns` 条目以递增 `iteration` 标识一次节点执行，记录状态、最终 `handoff`、产物 `files`、路由 `result` 与导航 Session id。`inputs` 记录确切的来源任务执行，`userInput` 记录本轮原始请求是否到达该任务（入口默认或显式输入边）。运行结算为 `completed`、`cancelled` 或 `failed`；完成要求成功到达结束节点且全部有效工作已结算，交互节点的退出只会在执行器取消其剩余的运行时自有轮次、且工具工作静止后提交。completed 的终态写入还会关闭因跳过写入失败而残留 pending 的节点。服务激活时把失去所有者的中断运行标为失败，不重做工作。终态写入失败会保留所属结果供对账。超出 `maxRuns` 时删除最早结算的运行。

## Executor seam

执行是一个注册表：服务的 `executor` 配置命名引擎，受信同进程 provider 自行注册——[`agent-flow-runtime`](../../packages/experimental/agent-flow-runtime/README.zh.md) 提供 `graph` 解释器。服务在引擎开始前持久化 running 记录，并交给它一个带节点运行持久化与运行取消信号的控制器。注销执行器注册时，会先取消并结算该执行器仍持有的全部活跃运行，再释放注册。执行器注销与运行接纳共用服务队列，因此运行不会在执行器注销后仍进入该执行器。

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

包 [README](../../packages/experimental/agent-flow/README.zh.md) 拥有挂载、配置上限与失败词汇。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.zh.md)

Source: [`packages/experimental/agent-flow/src/index.ts`](../../packages/experimental/agent-flow/src/index.ts)
<!-- END GENERATED cordis-surface -->
