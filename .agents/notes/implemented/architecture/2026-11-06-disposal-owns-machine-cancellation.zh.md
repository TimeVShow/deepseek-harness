# Agent Note：销毁期取消归属 machine 的 disposal

Status: implemented

[English](2026-11-06-disposal-owns-machine-cancellation.md) | 中文

## 问题

Host teardown 会卸载每个插件 fiber，而 Cordis `_unload`（vendor/cordis/src/fiber.ts）并行运行一个 fiber 的全部顶层 effect disposer，各自仅隔一个 `await Promise.resolve()`。在 agent-loop 插件 fiber 里，`inbox` 投影注册的 disposer 与负责取消并排空每个 machine 的 FactoryOwnership disposer 并发执行，前者会释放工厂的投影 key。外部所有者的 `Agent.cancel()` 若在该释放之后落地——例如兄弟插件自身卸载时触发的 subagent run abort，在子 machine 仍在排空时抵达 `child.cancel({ kind: 'parent' })`——会对已释放的投影执行 `inbox.clear()`，并从 `AbortController.abort()` 中同步抛出 `agent "<id>" cannot read inbox state: its projection registration is not active`。同样的并行释放也会破坏销毁自身的取消：`machine.cancel({ kind: 'disposed' })` 在中断 phase 之前就抛出，machine 不再排空，被持有的模型请求永不结算。失败呈间歇性，因为交错取决于 Host 以何种顺序卸载哪些 fiber，以及另一插件的卸载需要消耗多少个微任务才到达它的 abort。

## 决策

取消所有权转移给 disposal，且转移由 memoized 的 machine `dispose` 内部的代码顺序承担，而非 fiber effect。`ReactLoopAgent.beginDisposal()` 即该转移：它置起一个私有标记并清除活动 phase 上已锁存的 wake。`dispose()` 在其第一条同步语句处调用它，因此卸载波在 ownership disposer 之后能调度的每个续体——包括另一 fiber 的 executor abort——都会观察到该转移；machineReady 等待为 teardown 早于 minting machine 的 lifecycle effect 运行的情形重新置位。disposal 开始后，`cancel()` 对 `disposed` 以外的任何 cause 直接返回；disposal 自身的 disposed-cause 取消仍会清理 inbox 并中断 phase。`runMaintenance`、`send` 与 wake 锁存保持既有规则：wake 绝不锁存在 `disposed` 原因之后，disposal 开始后提交的输入仍是发送方的 bug，并保留其原有报错。

销毁取消以存活性为守卫而不信任注册：`dispose()` 在取消前立刻读取 `stateOf(session, 'inbox')`，读取与取消之间没有 await，当工厂的释放已移除 key 时传入 `keepInbox`。被跳过的持久清理不可观察，因为会话随 machine 一同离开；phase 仍会中断，machine 仍会排空。`Agent.cancel()` 的 Service Definition 契约与 agent-loop README 记载了该转移；释放后杂散读取的非法生命周期报错保持不变。

基于 effect 的顺序无法承担该接缝。`sessionProjections.register()` 在插件 fiber 上创建自己的顶层 effect，包装它无法推迟释放，包装 disposer 在注册之后一个微任务才运行，输给同步释放。machine 的 scope fiber 本身是插件 fiber 的顶层 effect，在同一个并行波中解除，Host 中每个 fiber 都会被传递性地卸载，因此没有 fiber 生命周期能存活到 machine 排空之后去排序它。只有 memoized dispose——ownership disposer 调用的普通代码——能在释放面前排序取消所有权的置位。

## 验证

`packages/core/agent-loop/tests/scope-lifecycle.spec.ts` 确定性地钉住该交错：`hang-slow` 模型请求保持一个 turn 在途，`loopFiber.dispose()` 启动卸载波，在波释放投影（经 `stateOf` 断言）之后，外部的 `agent.cancel({ kind: 'parent' })` 落在仍在排空的窗口内。测试断言该取消不抛出、没有未处理 rejection、turn 以 `{ kind: 'aborted', reason: { kind: 'disposed' } }` 结束、machine 到达 idle、卸载完成。对修复前的源码，同一测试以确切的生产报错失败。agent-loop 套件、subagent driver 套件与 web L1 验收组全绿，host 失败监视器（`unhandledRejection` 与 `uncaughtException`）在每个用例后断言为空。

## 已考虑的替代方案

**在 `stateOf` 中把已释放的投影当作空 inbox。** 这会吞掉真正杂散访问的非法生命周期报错；teardown 之后的 `send()` 是必须保持响亮的发送方 bug。

**捕获并记录销毁取消的失败。** phase 将永不中断、machine 将永不排空、被持有的模型请求泄漏；评审的原则是修所有权，而不是掩盖读取。

**通过重试或禁用同会话多运行掩盖竞态。** 竞态属于 teardown 而非运行数量，掩盖它会让每个带在途 subagent 的 teardown 都暴露在风险中。

## 后果

machine 销毁期间外部取消仅为参考：只有 disposed-cause 取消会影响 machine，因此 teardown 期间的 turn 结束原因稳定，不受与之竞态的外部 abort 影响。带在途 subagent 的 Host 与插件 teardown 不再产生 inbox 投影评错，且即使工厂的投影释放已先行执行，disposal 仍排空 machine。需要在并行 teardown 接缝中存活的注册类 effect 需要同样的代码顺序所有权，而不是依赖 effect 顺序。
