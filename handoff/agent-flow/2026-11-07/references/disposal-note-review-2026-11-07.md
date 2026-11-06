# AgentLoop 关闭与取消的架构复核

2026-11-07，审阅对象为 `agentflow` 分支在 `0d90b9f13f` 之上的当前工作树。[架构记录](../../../../.agents/notes/implemented/architecture/2026-11-06-disposal-owns-machine-cancellation.md)

建议保留由关闭流程统一负责取消的决定。上轮报告中“发布时已入队的输入在正常卸载后重现”的反例已通过。以下两个问题影响文档对收件箱和重新打开会话的承诺，仍需修复。

| 优先级 | 已复现的行为 | 实施与验收 |
| --- | --- | --- |
| P1 | 关闭已经清空队列，仍在等待工具退出时，旧 Agent 接受了一条迟到的 inject。重新打开持久化 Session 后，该标记仍在 nextStep，并与用户新消息一起进入了 MockAdapter 收到的请求。另一个独立探针发现，factory 完全卸载后旧句柄的 inject 仍返回成功。 | 从 beginDisposal 起拒绝外部投递，覆盖 send 的衍生入口及向公开 inbox 写入的入口，给内部关闭流程保留清理权限。用闸门固定“完成清理、工具尚未退出”的窗口。断言拒绝写入、无对应持久化插入、恢复后无残留且下一请求只有新输入。保留正常关停与崩溃恢复的既有差异。[投递与关闭标志](../../../../packages/core/agent-loop/src/agent.ts#L155) |
| P2 | 在同一条已提交的 splice 事件回调中，projection 已经能读到新消息，agent.inbox.nextStep 仍是旧队列。Session.append 在返回前就通知观察者，机器在它返回后才更新本地副本。此项仅做了只读观察。 | 活动期间让公开读取与已提交投影一致，例如注册有效时读取投影，并将本地副本限于内部关闭清理。保留 append 失败时不发布新状态的保证。添加事件回调内同时读取两个入口的测试。[更新顺序](../../../../packages/core/agent-loop/src/inbox.ts#L248) |

文档本身还有两处可直接更新。Verification 仍写 hang-slow，而正式测试现在用工具闸门保持关闭尚未完成。Problem 将监听器异常描述成从 AbortController.abort() 同步抛给调用者。本机 Node 的最小验证顺序为 `abort returned > uncaughtException`。建议写明错误源自监听器，并区别调用者返回和进程收到异常的时刻。[验证段落](../../../../.agents/notes/implemented/architecture/2026-11-06-disposal-owns-machine-cancellation.md#L23)

本轮运行了 agent-loop 的 inbox、resume、scope-lifecycle、cancel 四个正式测试文件，140 项通过。上一轮外部脚本直接运行时因 fixture 挂载代码已变而停止，在内存中改用当前 fixture 提供的 unloadLoop 后，原三组对照全部通过。另用真实 JSONL 持久化、MockAdapter 和临时测试文件运行三个新增反例，三个均复现。可在仓库根目录用 Python 运行[复现脚本](disposal-mirror-probes-2026-11-07.py)。本轮未修改产品源码或架构记录。
