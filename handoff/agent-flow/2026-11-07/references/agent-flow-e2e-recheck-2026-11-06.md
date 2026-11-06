# Agent Flow 第二轮修复验收

检视版本为 `agentflow` 分支的 `0d90b9f13f`。前序范围见[第一轮检视](agent-flow-e2e-review-2026-11-06.md)。同目录普通对话的已完成运行卡片隔离可以签收。整轮保留一个 P1 阻断项，涉及核心 AgentLoop 正常卸载后旧输入进入后续请求。

## P1 · 关闭与会话发布重叠时，待处理输入会在重开后进入模型

**影响。** 一个会话已经登记，创建监听器仍在运行，此时卸载 AgentLoop。如果监听器已向会话注入待处理内容，重新打开该 Session，再发送一条新消息，模型会同时收到旧输入。该问题影响 DSH 的持久化 Session，触发它无需使用 Flow 断点续跑。

**复现。** 探针使用真实 JSONL 持久化、新建的两个 DSH Context 和只记录请求的 MockAdapter。在 `agent/created` 监听器中注入唯一标记，保持发布未完成，调用并等待 AgentLoop 正常卸载，随后从磁盘重新打开同一 Session。恢复后标记仍在 `nextStep` 队列里。发出新消息后，适配器恰好收到一次请求，其中同时包含旧标记和新消息。常规 handle 关闭、发布完成后再卸载 factory 两组对照均通过。复现结果为 **2 通过、1 失败**。从仓库根目录用 Python 运行[复现脚本](recheck-disposal-inbox.py)即可验证。临时测试文件运行后自动清理。

**根因。** E08 的修复将并发取消交给正在关闭的 machine，消除了对已释放 inbox 注册的重复读取。但当关闭流程等待发布完成时，注册可能先释放。此时 `keepInbox: true` 允许活动结束，却也跳过了持久化队列清理。关掉 Session 的写句柄不会撤销先前记入日志的输入。现有正常关闭与崩溃恢复的用例也区分了这两种语义。见 [AgentLoop 关闭路径](../../../../packages/core/agent-loop/src/index.ts#L557) 和 [Session 恢复测试](../../../../packages/core/agent-loop/tests/resume.spec.ts#L945)。

**建议。** 保留对重复取消的保护，让正常关闭在写句柄仍可用时具备将待处理输入持久丢弃的能力。优先复用已有 inbox splice 和重放逻辑。若不能让注册活到清理结束，应由 inbox 所有者提供能从 Session 日志恢复待清理队列并提交清理事件的关闭路径。实施时应避免通过重开会话一律清队列来修补，因为崩溃恢复有保留合法待处理输入的要求。

**签收条件。** 把上述三组对照纳入正式测试，断言恢复后的队列和实际请求内容。保留崩溃恢复、重复取消、持有中的模型请求能结束的回归。修正架构记录中“跳过清理不可观察”的结论。

## P2 · 同一 Flow 的并发运行在菜单里无法辨认

同一会话启动同一 Flow 两次，两条运行都处于 running 时，菜单为两项显示相同的流程名称与阶段。选择某一项后，取消会作用于正确的 runId，但用户无法凭可见信息认出要取消的是哪一个。当前 E08 靠第二行的位置选中较早的运行。建议在选项中加入发起请求的短摘要，并在摘要也相同时提供可区分的发起时间或运行标识。验收测试应凭用户看得到的差异选中目标任务。见 [菜单标签](../../../../packages/experimental/client-ui-agent-flow/src/client/FlowRunProgress.tsx#L239) 和 [E08 的选项定位](../../../../apps/web/tests/agent-flow-l1-identity.e2e.ts#L536)。

## P2 · 补齐 E08 的正式验收入口和清理期监测

- 正式 E08 的第二次启动直接调用 Host 的 `scaffold.ctx.agentFlows.start`，未经过浏览器输入框或 Remote。独立临时用例把这一段换成第二次 composer 选择和发送，随后从卡片取消第一条 run，放行第二条并等待完成，本次通过。建议固化这条已验证路径。见 [E08 第二次启动](../../../../apps/web/tests/agent-flow-l1-identity.e2e.ts#L523)。
- 当前自建 Host 监听器在关闭浏览器和 scaffold 前移除，页面错误也在页面关闭前检查。这样失去的恰是原报告关心的清理阶段归因。建议先关闭资源，再在 finally 中检查和移除监听器，同时保证断言失败也能清理。Vitest 自身的未处理错误报告仍有作用。见 [测试清理钩子](../../../../apps/web/tests/agent-flow-l1-identity.e2e.ts#L169)。
- E08 的浏览器测试注释和架构记录对原错误归因不同。核心回归覆盖了 AgentLoop 卸载与外部 parent cancel 重叠，运行时也增加了交互 Agent 已离开注册表时的防护。本轮没有取得历史异常的完整堆栈，建议按这两条各自可复现的路径记录结果。核心回归用 10 ms 等待命中 50 ms 的模拟慢请求，宜改为显式闸门并断言取消发生时清理仍未结束。见 [核心回归](../../../../packages/core/agent-loop/tests/scope-lifecycle.spec.ts#L318)。

## 本轮可签收和待补的范围

| 场景 | 本轮结论 |
| --- | --- |
| E01、E05、E09 | 已完成 Flow 在原会话有卡片，同目录新会话及普通会话无卡片，返回原会话和刷新后可见。E05 验证普通消息得到页面回复，E09 直接断言两次实际启动了两个不同的 Flow。以上已复测通过。E01 使用的是已完成运行。 |
| E06、E07 | 跨会话从卡片取消一个 run，另一个继续完成。两个不同交互 Flow 分别收取回复，只有目标 run 推进。浏览器用例通过。 |
| E17 | 逐轮唯一回复、等待 → 处理中 → 等待 → 最终完成均已覆盖。当前断言接受 Reasoning 或 Writing 任一项，工具运行与两个显示阶段各自出现仍需独立断言。 |
| E19、E20 | 已验证实际页面断线、Host 离线期间继续完成、重连补齐，以及刷新时节点 Session 和请求计数稳定。E19 仍会删除断线以后全部采集的 warnings，包括 gap repair 和 discontinuity，建议仅豁免预期的连接中断提示。见 [E19 警告处理](../../../../apps/web/tests/agent-flow-l1-identity.e2e.ts#L685)。 |
| E15、E23–E25 | 原计划的第二轮三角色并行读取第一轮汇总，本次未找到专门用例。模型配置、交付文件链接及非法配置的第三批场景，本轮未取得完整 E2E 验收证据。继续按原计划排期。 |

## 验证记录

- `pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/agent-flow-l1-identity.e2e.ts`，11 项通过，87.30 秒。
- `pnpm exec vitest run packages/experimental/agent-flow-runtime/tests/conversation.spec.ts packages/experimental/agent-flow-runtime/tests/graph.spec.ts`，61 项通过。
- `pnpm exec vitest run packages/core/agent-loop/tests/scope-lifecycle.spec.ts packages/core/agent-loop/tests/cancel.spec.ts`，85 项通过。
- 临时 E08 双 composer 浏览器探针通过。持久化三组对照结果见 P1。本轮使用脚本或 mock provider，没有付费请求。正式源码及测试文件均无修改。
