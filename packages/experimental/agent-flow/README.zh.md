---
description: "面向需要画布式固定多 Agent 工作流的部署与维护者：持久的 agent 模板、经校验的流程图文档、持久化运行记录与执行器接缝。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-agent-flow

[English](README.md) | 中文

## 概述

`dsh-experimental-agent-flow` 保存用户编写的固定多 Agent 工作流：定义人设与模型路由的 agent 模板，以及把这些模板连成一张有向图的流程文档。保存流程时一次性拒绝整图并列出全部问题；启动运行时先持久化运行记录再开始执行。本包不自带执行引擎——由运行时包注册执行器，缺它时启动运行会高声失败。本包以实验名称发布，无稳定性承诺，需要持久存储才能激活。

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

当用户希望一次编写 agent 模板与固定工作流图、再以不同的输入消息反复启动运行时，把本包加入组合。它只拥有文档与运行记录；要执行运行，须由独立的运行时包注册执行器。

启动运行会持久占用其父会话：服务记录该会话并应答 session controller 的使用扩展点，因此新对话不会把该会话复用为空白会话，运行结果也留在该会话自己的会话记录中。占用状态可跨重启，且比运行记录本身存活更久。

### 何时选择

当工作流本身是固定数据——节点、条件节点的路由词与指令都预先编写——而不是运行时由模型临场决定时，选择本包。当模型应自由编排时避免本包；改挂载 `dsh-workflow` 脚本引擎。两者都需要存储三件套（`dsh-storage`、某个后端、`dsh-storage-domain`）才能激活。

### 最小工作配置

已发布的 `dsh-base` bundle 已组合存储枢纽、JSON 后端与 domain 层，因此只需追加一行：

```yaml
# agent flow documents and runs over the base storage trio
- name: '@deepseek-ai/dsh-experimental-agent-flow'
```

所有上限均可选，并在启动时校验：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `executor` | `'graph'` | `start` 选择的注册名；未注册时运行会高声失败。 |
| `maxFlows` | `100` | 保存的流程文档数量上限。 |
| `maxTemplates` | `100` | 保存的 agent 模板数量上限。 |
| `maxRuns` | `1000` | 持久化运行记录上限；超出时丢弃最旧的已结算运行。 |

生成的[配置目录](../../../docs/config-catalog.zh.md)是全部可接受字段的权威来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 —— 点击展开</summary>

`src/spec.ts` 中的 zod schema 在存储时校验模板、文档与运行。每条边明确声明 `execution` 或 `input`。执行边定义可达性与调度；输入边引用目标路径上保证可用的结果，只有每条激活路径都已交接该结果时，连接才判为冗余。`src/graph.ts` 分析完整执行图，`src/validation.ts` 接受并行 DAG 与单入口串行条件回环。校验器拒绝无条件环、回环内并行分叉或汇入、无法解析的引用及冗余结果连接。普通任务有多个执行前驱时采用 all 语义，无需汇合节点。保存时一起报告全部结构问题。

服务打开逐记录布局的 `agent_flow` 存储 domain。同一个修改队列覆盖引用检查、数量限额、写入、运行接纳与结算。执行器的结果在终态写入成功前持续由服务持有；后续读取、取消或卸载可以重试该次写入。激活时把失去所有者的中断运行标为失败，不重新执行。注册的执行器获得持久化节点更新操作与取消信号；注销其注册会取消并结算它仍持有的全部运行，随后服务卸载再关闭存储。completed 的终态写入会关闭因跳过写入失败而残留 pending 的节点。`concludeConversation` 要求所属引擎结束尚未关闭的澄清，没有开放对话时报告 `agent-flow/not-conversing`。会话占用为每个父会话持久化一条 `usage` 记录，并由激活时重建的内存集合应答；重建会为仅有运行记录证明的父会话补写该记录。该记录比运行记录存活更久：保留策略删除某个会话最后一条可证明的运行前会先写入该记录，写入失败则保留该运行，重启后不会丢失事实。新占用的会话还会通过扩展点的变更通知上报，运行中的会话列表会立即刷新。

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 服务、远程方法、执行器注册表、运行生命周期 |
| `src/spec.ts` | zod 记录 schema、持久化类型、domain 声明 |
| `src/types.ts` | 品牌化 id、草稿、执行器接缝契约 |
| `src/validation.ts` / `src/graph.ts` | 图校验与共享执行分析 |

不发布运行时 invariant 伴随包，因为本服务不拥有会分歧的观测：每条记录都经过同一个 storage-domain schema，运行生命周期由包测试套件断言。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-storage-domain](../../storage/storage-domain/README.zh.md) —— 本包打开的 domain 层及其后端路由。
- [dsh-experimental-agent-team](../../experimental/agent-team/README.zh.md) —— 无固定图的协作 agent 实验性姊妹接缝。
- [dsh-typert-protocol](../../typert/protocol/README.zh.md) —— 远程方法使用的 `@Remote` 方法与错误词汇。
- [扩展指南](../../../docs/cookbook/extension-cookbook.zh.md) —— 把功能映射到能力接缝的逐步指南。

-----

<a id="model-experience"></a>
## 模型体验

### 持久的工作流文档

#### 模型看到什么

无。本包不注册工具、不注入提示词、不追加会话事件；模板、流程与运行记录位于 `ctx.agentFlows` 之后的存储 domain 数据中，只有未来的消费者通过自身文档化的展示面渲染它时才会到达模型。

#### Token 影响

零：本包没有任何文本进入模型请求。

#### KV Cache 影响

独立：文档与运行的读写不触碰请求前缀，因此这里的一切都不会使提供商缓存复用失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制描述本包目前做不到或需要特殊运维注意的地方。它们是当前包约束，不是任务 backlog。

- **本包不含执行引擎** —— 本包拥有文档与运行；在运行时包注册所配置的执行器之前，`start` 会以 `agent-flow/executor-missing` 拒绝所有请求。
- **无模型侧触发** —— 运行只能从宿主侧发起；模型无法调用流程，也不存在读取流程的工具。
- **运行权限仅限父会话** —— 只有启动运行的会话的活跃 Agent 能取消它或结束它的澄清；其他调用方得到 not-found。
- **占用状态在激活后才应答** —— 宿主启动到本服务激活之间，会话摘要会把父会话报告为未占用。
- **旧图需要显式转换**——缺少边类型、`context.sources` 与 `any` 汇合会触发 schema 校验失败；插件拒绝激活该 domain 并保留记录。重写为明确的执行边和输入边之前，先导出并审查受影响的图。
- **单进程变更可见性** —— `domain/changed` 仅进程内；第二个宿主进程观察不到变更。
- **无稳定性承诺的实验原型** —— 本包公开发布，但契约在孵化期内可自由变更。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 —— 点击展开</summary>

None.

</details>
