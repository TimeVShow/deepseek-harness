# Agent Note: Give Agent Flow its own service seam over storage-domain

Status: implemented

[English](2026-09-24-agent-flow-plugin-seams.md) | 中文

## Problem

用户需要固定的多 Agent 工作流：一次性编写 agent 类型，用自己控制路由的流程图式图连接起来，再用不同入参反复执行。Harness 已提供 agent 底座（subagent 接缝以 persona、模型路由、工具范围与输出 schema 组合子 agent），也提供工作流引擎——但该引擎执行模型编写的 JavaScript 编排脚本，而非用户编写的图数据，且一个 context 只能加载一个 `WorkflowEngine` provider。新能力挂在哪里的选择不得修改 agent 底座、不得顶替脚本引擎、也不得在表面孵化期暗示稳定性承诺。

## Decision

`packages/experimental/agent-flow` 以服务键 `ctx.agentFlows` 拥有持久数据与编排生命周期，是一个带模板、流程文档与运行 CRUD 远程方法的 `TypertRemoteService`。完整接缝有三个角色：

- **Service Definition**——本包。它校验完整执行图、显式输入引用与模板引用，接受并行 DAG 与串行条件回环，拒绝不支持的组合。[子系统参考](../../../../docs/subsystems/agent-flow.zh.md)负责定义图术语。
- **Provider**——`packages/experimental/agent-flow-runtime` 通过 `registerExecutor(executor)` 注册 `graph` 解释器，由 `executor` 配置选择。文档与运行保持独立于引擎；provider 挂载前，`start` 以 `agent-flow/executor-missing` 明确失败。
- **Consumer**——`packages/experimental/client-ui-agent-flow` 在画布上编辑文档、编辑模板，并通过远程方法启动或取消运行；运行时通过同一命名空间读取模板，并通过运行控制器持久化每个节点结果。它的进度卡片还合并这些执行所开启会话的实时活动：客户端只保留执行中或对话中的节点执行所属的会话，把这些会话有序的事件流折叠为阶段、业务时间戳与未结束的工具调用而不复制消息文本，并在对应执行或运行结算时释放。等待判定读取记录的 `conversing` 状态与该实时状态，因此正在处理回复的节点不会被报告为等待用户。面向模型的工具尚未发布。

记录持久化到一个逐记录布局的 `agent_flow` 存储 domain 单元。同一个服务队列串行处理引用检查、限额、写入、运行接纳与结算。运行绑定启动时的文档快照，并在执行前持久化。终态写入失败会保留结果供稍后对账；激活时把失去所有者的中断运行标为失败，不重新执行。Fiber 卸载在同一个顺序 effect 中中止工作、等待结算写入并关闭单元，因为独立 effect 的 disposer 会并发执行。

Agent 模板通过运行时提供 `persona`、`provider` 与 `model` 覆盖。文档服务不导入 subagent provider。运行携带 `parentSessionId`，只有该 Session 的 live Agent 可以取消运行或结束澄清。

运行详情位于存储 domain。文档服务不注册模型侧工具或 Session 事件；运行时通过普通 Agent API 提交任务提示词，因此节点 Session 记录确切的模型可见输入。无需修改 `SessionEventMap` 或 SDK 格式。浏览器面板自行挂载生成的 Remote contribution，`packages/experimental/agent-flow-profile` 把三条插件配置组合成可选 bundle。

## Testing

本包测试通过存储 gate 覆盖 CRUD 竞争，并覆盖数量与引用保护、显式图校验、运行所有权、取消、保留策略、终态写入失败及中断后的激活。运行时测试观察节点提示词、确切来源执行、全部前驱调度、条件排除、串行审查轮次、兄弟取消以及达到执行上限时保留的已完成记录。客户端测试覆盖有界的有环布局与执行/输入连线编辑。一个真实 AgentLoop 生命周期套件覆盖普通取消、开启后控制器失败、正常完成时已排队的 conclude，以及 provider 卸载；每次终态写入都会等待活轮次与工具静止。运行时与客户端套件还覆盖迭代追加失败、跳过写入失败、刷新顺序、慢刷新合并、执行器接纳与注销的先后关系表单身份采纳、交互消息来源与显式入口 Agent 选择。实时活动链路以无 key 方式端到端固定：有序会话事件进入共享客户端事件流，跟踪器折叠它们，控制器发布观察，渲染出的卡片显示阶段——覆盖超过无活动阈值的持续推理、已提交但尚未落地的回复、开放轮次内的提问，以及结算后的释放。

## Alternatives considered

**实现第二个 `WorkflowEngine` provider。** workflow 接缝每个 context 只允许一个 provider；加载图解释器会顶替 `workflow-ptc`，违反不变更既有行为的约束。脚本模型也没有承载用户编写图文档的位置。

**扩展 Agent Teams。** Teams 通过活跃 roster 与任务板在一个会话内协调自由协作；固定编写的图是持久化需求不同的另一种数据，耦合二者会强加同一条稳定性轨道。

**把流程编写为 preset 或 bundle YAML。** preset 是由 Loader 组合的部署配置，在 Web 客户端只读；用户编写的文档需要对持久存储的运行时 CRUD，那正是 storage-domain 的契约。

**把运行记为会话事件 journal。** 当运行模型可见或必须从日志重放时那才是正确形态。没有模型侧展示面时，它会为存储 domain 已拥有的数据付出 `SessionEventMap` 与 TypeScript/Python SDK 双端更新的代价。未来的模型侧触发会在那个里程碑补事件，而不是在这里预先付出。

## Consequences

执行器可替换而不改变文档所有权，Web UI 独立于 provider 消费 remotes。运行详情从存储读取，而不由 Session 日志重建。旧图不满足当前 schema 时需要显式转换；原始记录保留在磁盘。取消权限保留给父 Session。本实验 API 不提供稳定性承诺。
