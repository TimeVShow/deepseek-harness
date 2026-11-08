---
description: "注册 Agent Flow 图解释器：逐节点调度经校验的流程图文档，通过所配置的 subagent provider 运行每个工作节点，并为与用户澄清需求的那个节点开启一个 root 会话。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-agent-flow-runtime

[English](README.md) | 中文

## 概述

`dsh-experimental-agent-flow-runtime` 把已保存的流程文档变成运行中的 agent：逐节点调度图、按条件节点上游 agent 的最终 `Result: <词>` 行路由、在 join 处等待。工作节点作为 subagent 子 agent 运行一次；标记为 `interactive` 的节点改为开启一个用户可加入的 root 会话，并在轮次之间保持 `conversing`，直到某一轮以其 Result 词收尾。并行节点 agent 受并发上限约束，`maxIterations` 限制 agent 执行总次数。每个节点的结果都写入持久运行记录。本包以实验名称发布，无稳定性承诺。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把本包与 `dsh-experimental-agent-flow` 及一个 subagent provider 一起挂载，再通过 `ctx.agentFlows` 启动运行；本包提供这些运行所需的执行器。

### 何时选择

当工作流预先编写为文档且每次都必须以同样方式运行时，选择本包。当模型应针对每次请求自由编排时避免本包；改挂载 `dsh-workflow` 脚本引擎。运行时需要为其工作节点提供 subagent provider，请挂载名称与本包 `provider` 配置一致的 provider；与用户对话的那个节点还需要 `agents` 与 `agentDefaultModel`。

### 最小工作配置

`dsh-base` 已组合了名为 `spawn` 的 subagent provider、一个 agent 工厂与一个默认模型选择，因此只需追加 Agent Flow 服务与本运行时两行：

```yaml
# agent flow documents, runs, and the graph interpreter over the base subagent provider
- name: '@deepseek-ai/dsh-experimental-agent-flow'
- name: '@deepseek-ai/dsh-experimental-agent-flow-runtime'
```

所有值均可配置；`executor` 必须与服务自身的 `executor` 值一致：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `executor` | `'graph'` | 注册使用的注册名；由服务的 `executor` 配置选择。 |
| `provider` | `'spawn'` | 每个工作节点启动所用的 subagent provider 名。 |
| `maxConcurrentAgents` | `4` | 同时运行的节点 agent 数上限。 |
| `maxConversationTurns` | `16` | 一个交互节点在其运行失败前可进行的轮次上限。 |

生成的[配置目录](../../../docs/config-catalog.zh.md)是全部可接受字段的穷尽式真源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 —— 点击展开</summary>

新一轮迭代记录追加失败会让运行在 run 层失败，并保留上一次执行的记录。卸载运行时会取消并结算它仍持有的全部运行后再释放注册。每个节点等待全部有效执行前驱，并要求至少一次实际到达。未选中的条件分支被排除；输入边从不激活工作。条件节点选择一条路线，透明转交收到的任务结果。all 汇合合并已完成分支的结果并保留来源身份。串行回环每轮消费新的内部到达、保留已完成的外部依赖，并在返回入口接收刚完成的审查结果。回环继续时其出口保持未决，防止外部汇合提前执行。完成要求成功到达结束节点，且没有尚未解决的有效工作。

`agent` 节点取得并发槽、解析执行交接与必需输入引用、记录确切的来源节点执行，然后读取模板并组装提示词。start 的直接执行后继（入口节点）默认读取本轮原始请求；来自 start 的显式输入边可把请求加入其他节点。每个任务仅输出最终说明与产物路径。工作节点使用 `ctx.subagents.startActivation`，子 agent 结算后即处置。交互节点通过 `ctx.agents.create` 打开普通 root 会话，在开场提示词中携带模板人设，并对父级组合应用路由覆盖。开场轮次把运行时规则记录为 `agent-flow` 上下文，并把原始请求作为人类消息单独记录。这些插入自身触发的取消（例如同步的 `agent/inbox/inserted` 监听器）不再把剩余消息放进收件箱，因此取消后不会开始新轮次，运行自行结算为 `cancelled`，无需外部再取消活 Agent。结算后的对话仍可阅读，并由进程内的 `agent/pre-step` 锁拒绝后续人类提示。

每个节点都在 `.dsh/flows/<run>/<iteration>-<node>` 下自己的迭代目录中运行。该目录同时是节点会话不可变的 header cwd，因此宿主现有的 sandbox policy 会把节点的文件工具与子进程写入根定在那里，不需要修改任何宿主包。工作节点的目录由每个节点一个的 carrier 会话承载：carrier 的 header cwd 是迭代目录，子 agent 继承它；carrier 不运行轮次，并随子级一起处置。交互对话把该目录记录为自己的 header cwd。上游交付物仍可读取，但不能被覆盖、删除、重命名或替换，节点自己派生的子级也继承同一根目录。节点需要修改上游材料时，先复制到自己的目录。

每次任务执行都持久化最终助手文本、文件与 Session id。接入条件节点的 agent 必须以有效 `Result: <词>` 结尾；没有条件节点的交互节点使用 `done`。没有 Result 的轮次使交互节点保持 `conversing`，等待人类回复或耗尽轮次预算。提示词要求用户同意，但运行时根据 Result 行判定完成；它不是强制执行的人类授权状态。`concludeConversation` 提交一次结束指令并消费其注册。模型失败、节点失败与调用方取消都会停止剩余工作，并把未到达节点记录为跳过。交互节点的每种退出——Result、失败或取消——都会取消剩余的运行时自有轮次，并等待其活 Session 静止，因此运行不会在所属轮次或工具仍在执行时发布终态。

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 函数插件：配置校验与执行器注册 |
| `src/executor.ts` | 图调度、节点委派、运行结算 |
| `src/conversation.ts` | 交互节点的 root 会话：创建、发布、轮次观测 |
| `src/prompt.ts` | 固定提示词组装与 Result 行解析 |

不发布运行时 invariant 伴随包，因为解释器自身不拥有持久流；它读写的记录由 Agent Flow 服务校验。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-experimental-agent-flow](../agent-flow/README.zh.md)——本执行器所驱动的文档、模板与运行记录。
- [Agent Flow 子系统](../../../docs/subsystems/agent-flow.zh.md)——flow 类型与执行器接缝契约。
- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——每个节点 agent 启动所用的委派接缝。
- [dsh-workflow](../../workflow/workflow/README.zh.md)——面向模型编写编排的脚本引擎。

-----

<a id="model-experience"></a>
## 模型体验

### 工作节点委派

#### 模型看到什么

启动运行的那个会话什么也看不到。每个工作 `agent` 节点把组装后的提示词作为一条新的用户消息投递给它自己的子 agent，并与该节点模板的人设与路由组合；子 agent 的最终文本回到运行记录，绝不进入启动会话的对话。

#### Token 影响

父会话不因运行增加任何 token。每条组装后的节点提示词、工具交互与子输出都在该节点自己的子会话内消耗 token。

#### KV Cache 影响

与父会话独立：运行时从不触碰启动会话的请求前缀，因此那里的提供商缓存复用不受影响。每个子会话从节点提示词与其模板人设构建自己的前缀。

### 交互节点对话

#### 模型看到什么

一个属于它自己的普通 root 会话，加入了本次运行父级的组合，因此它看到该组合的系统提示词，而模板人设被折进开场的用户消息，而不是一个人设段落。该会话中之后每条用户消息都是人类自己的回复，由产品的输入框投递，而不是由本运行时投递。

#### Token 影响

父会话不增加任何 token。对话的轮次像任何人类对话一样在交互会话中累积：每次回复都重发整个前缀，因此一次冗长的澄清在计费 token 上呈二次增长。

#### KV Cache 影响

交互会话中是普通的只追加增长，因此提供商前缀缓存逐轮生效。启动会话的前缀不受触碰。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制描述本运行时目前做不到或需要特殊运维注意的地方。它们是当前包约束，不是任务 backlog。

- **Host 侧启动**——本运行时不提供模型侧触发工具；Agent Flow 画布等 Host 集成负责启动运行。
- **模板在节点启动时读取**——编辑模板会改变尚未开始的节点；一次运行固定其图，但不固定其模板。
- **路由是对最后一行的精确匹配**——接条件节点的 agent 最终消息缺少 `Result: <词>` 行，或给出的词不在该条件节点的词汇表内时，该节点失败，整次运行随之失败。
- **首个节点失败即整次运行失败**——没有失败路由边、重试策略或续跑；被中断的运行已结算，无法从失败节点重启。
- **支持的图子集**——支持并行 DAG 与串行条件回环；拒绝 `any` 以及回环内的并行分叉或汇入。
- **本地产物路径**——产物发现读取 Host 文件系统；远程执行环境需要单独设计文件引用。
- **锁不能跨重启存活**——它是活跃 agent 作用域上的进程状态，因此被恢复的对话 Session 又可写，而记录它已结束的运行记录依然是持久的。
- **无稳定性承诺的实验原型**——本包公开发布，但契约在孵化期内可自由变更。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

None.

</details>
