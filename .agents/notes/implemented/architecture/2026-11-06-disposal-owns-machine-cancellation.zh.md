# Agent Note：销毁期取消归属 machine 的 disposal

Status: implemented

[English](2026-11-06-disposal-owns-machine-cancellation.md) | 中文

## 问题

Host teardown 会卸载每个插件 fiber，而 Cordis `_unload`（vendor/cordis/src/fiber.ts）并行运行一个 fiber 的全部顶层 effect disposer，各自仅隔一个 `await Promise.resolve()`。在 agent-loop 插件 fiber 里，`inbox` 投影注册的 disposer 与负责取消并排空每个 machine 的 FactoryOwnership disposer 并发执行，前者会释放工厂的投影 key。外部所有者的 `Agent.cancel()` 若在该释放之后落地——例如兄弟插件自身卸载时触发的 subagent run abort，在子 machine 仍在排空时抵达 `child.cancel({ kind: 'parent' })`——会对已释放的投影执行 `inbox.clear()`，并从 abort 监听器内部抛出 `agent "<id>" cannot read inbox state: its projection registration is not active`。抛出源自监听器而非调用者：`AbortController.abort()` 先返回给调用者，进程随后才收到异常（最小 Node 验证的顺序是 `abort returned > uncaughtException`），因此调用方看到的是间歇性崩溃而不是被拒绝的调用。同样的并行释放也会破坏销毁自身的取消：`machine.cancel({ kind: 'disposed' })` 在中断 phase 之前就抛出，machine 不再排空，被持有的模型请求永不结算。失败呈间歇性，因为交错取决于 Host 以何种顺序卸载哪些 fiber，以及另一插件的卸载需要消耗多少个微任务才到达它的 abort。

第一版修复以注册存活性守卫销毁取消，并在释放已移除 key 时传入 `keepInbox`，假定被跳过的持久清理不可观察，因为会话随 machine 一同离开。该假设是错的：关闭会话写句柄并不会撤销已记入日志的输入。之后的 `resume` 会把这些 `agent/inbox/spliced` 插入重新折叠进 inbox，下一轮便将其纳入模型请求。当创建监听器持有发布、且已注入输入时卸载 loop 即可复现：恢复后的会话仍把该消息留在 `nextStep`，下一次模型请求同时包含旧消息与新消息。

## 决策

取消所有权转移给 disposal，且转移由 memoized 的 machine `dispose` 内部的代码顺序承担，而非 fiber effect。`ReactLoopAgent.beginDisposal()` 即该转移：它置起一个私有标记并清除活动 phase 上已锁存的 wake。`dispose()` 在其第一条同步语句处调用它，因此卸载波在 ownership disposer 之后能调度的每个续体——包括另一 fiber 的 executor abort——都会观察到该转移；machineReady 等待为 teardown 早于 minting machine 的 lifecycle effect 运行的情形重新置位。disposal 开始后，`cancel()` 对 `disposed` 以外的任何 cause 直接返回；disposal 自身的 disposed-cause 取消仍会清理 inbox 并中断 phase。`runMaintenance`、`send` 与 wake 锁存保持既有规则：wake 绝不锁存在 `disposed` 原因之后，disposal 开始后提交的输入仍是发送方的 bug，并保留其原有报错。

销毁取消不再依赖注册。`ReactLoopInbox` 保有它自己拥有的待处理列表：构造时从投影播种，每次持久 splice 后镜像已提交的事件快照。machine 是其会话的唯一写入者，因此镜像始终精确，工厂释放之后 `clear()` 依然有效。`dispose()` 始终以 disposed cause 取消且不传 `keepInbox`，持久丢弃在会话写路径仍开放时落地，因此恢复后的会话无法重放 agent 从未运行的输入。释放后新建的 inbox 仍会响亮失败，崩溃恢复（无优雅销毁）仍按设计保留合法待处理输入。`Agent.cancel()` 的 Service Definition 契约与 agent-loop README 记载了该转移。

投递随同一转移关闭。自 `beginDisposal()` 起，全部公开投递入口均拒绝——`send` 及其 `followup`/`steer`/`inject` 别名，以及 Inbox 的变更操作——迟到的外部 `inject` 因此无法提交恢复后会被重放的持久插入；读取对生命周期观察者保持可用。machine 自身的工具流水线保留一条内部投递路径（`appendInternal`）：machine 排空期间结算的工具结果仍会把上下文停在队列中，而不是随被中断的 turn 一同丢失。感知 teardown 的调用方识别导出的 `AgentDeliveryClosedError`，在该边界丢弃尽力而为的通知——subagent 的结算投递即如此——而不是报告传输失败。活动期间读取使用仍注册的实时投影，因此 splice 事件的观察者在 `append` 返回前通过 `agent.inbox.nextStep` 与投影读到同一份新队列；保有的镜像服务于释放窗口，append 失败则两者都不发布。

基于 effect 的顺序无法承担该接缝。`sessionProjections.register()` 在插件 fiber 上创建自己的顶层 effect，包装它无法推迟释放，包装 disposer 在注册之后一个微任务才运行，输给同步释放。machine 的 scope fiber 本身是插件 fiber 的顶层 effect，在同一个并行波中解除，Host 中每个 fiber 都会被传递性地卸载，因此没有 fiber 生命周期能存活到 machine 排空之后去排序它。只有 memoized dispose——ownership disposer 调用的普通代码——能在释放面前排序取消所有权的置位。

## 验证

`packages/core/agent-loop/tests/scope-lifecycle.spec.ts` 确定性地钉住该交错：门控测试工具保持 turn 在途并撑开排空窗口，`loopFiber.dispose()` 启动卸载波，在波释放投影（经 `stateOf` 断言）之后，测试先证明 teardown 仍未完成，再把外部的 `agent.cancel({ kind: 'parent' })` 放入该窗口。测试同时断言该窗口内全部公开投递入口拒绝、被拒绝的身份永不进入持久日志、该取消不抛出、没有未处理 rejection、turn 以 `{ kind: 'aborted', reason: { kind: 'disposed' } }` 结束、machine 到达 idle、卸载完成。对修复前的源码，同一测试以确切的生产报错失败。`packages/core/agent-loop/tests/resume.spec.ts` 覆盖全部三条所有权路径的持久丢弃——单 agent handle 销毁、发布完成后的工厂卸载、创建监听器持有发布期间的工厂卸载——使用真实 JSONL 持久化与双生命周期 resume：各自断言存储日志中的 canceled splice、恢复后 `nextStep` 中不再含被注入的身份、下一次模型请求只含新消息。它还把迟到投递窗口与持久化钉在一起：工具排空期间被拒绝的 `inject` 不留下任何存储 splice，恢复后的会话下一次请求只含新输入。已接受工具结果的例外同样被钉住：工具在 machine 排空期间结算的上下文经 JSONL 恢复后仍留在 `nextStep`，并出现在下一次模型请求中与新输入并列。`packages/core/agent-loop/tests/inbox.spec.ts` 钉住公开变更门禁与已提交读取一致性：splice 事件的观察者通过两个入口读到同一份新队列。崩溃恢复对照确保非优雅生命周期保留待处理输入。agent-loop 套件、subagent driver 套件与 web L1 验收组全绿，host 失败监视器（`unhandledRejection` 与 `uncaughtException`）在每个用例后断言为空。

## 已考虑的替代方案

**在 `stateOf` 中把已释放的投影当作空 inbox。** 这会吞掉真正杂散访问的非法生命周期报错；teardown 之后的 `send()` 是必须保持响亮的发送方 bug。

**捕获并记录销毁取消的失败。** phase 将永不中断、machine 将永不排空、被持有的模型请求泄漏；评审的原则是修所有权，而不是掩盖读取。

**每次会话重开都清空 inbox。** 对恢复路径而言这与崩溃不可区分，而崩溃恢复必须保留合法待处理输入（后台 inject 不是陈旧工作）。

**在销毁路径重放会话日志以恢复待清理队列。** 同步历史读取对新生产调用已弃用，且 machine 已经观察到它拥有的每次变更；保有的镜像无需历史扫描。

**通过重试或禁用同会话多运行掩盖竞态。** 竞态属于 teardown 而非运行数量，掩盖它会让每个带在途 subagent 的 teardown 都暴露在风险中。

## 后果

machine 销毁期间外部取消仅为参考：只有 disposed-cause 取消会影响 machine，因此 teardown 期间的 turn 结束原因稳定，不受与之竞态的外部 abort 影响。带在途 subagent 的 Host 与插件 teardown 不再产生 inbox 投影报错，即使工厂的投影释放已先行执行，disposal 仍排空 machine，且会持久丢弃待处理的外部输入，使恢复后的会话不会重放它们。machine 排空期间结算的已接受工具结果上下文是唯一的保留例外：它经内部投递通道停放，并留在恢复后会话中等待下一轮接纳。需要在并行 teardown 接缝中存活的注册类 effect 需要同样的代码顺序所有权，而不是依赖 effect 顺序。
