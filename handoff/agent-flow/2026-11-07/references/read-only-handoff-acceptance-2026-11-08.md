# Agent Flow 只读交接验收记录 · 2026-11-08

本记录对应 V1.0 发布交接（`v1-release-handoff-2026-11-08.md`，保存在原交接工作树）的阻断项：下游节点不得改写上游交付文件。结论：机制已落地并通过负向验收，E26 覆盖工作节点、E27 覆盖交互节点，两类节点各自由真实 Bash 尝试六种写入并被拒绝，上游原件保持不变。

## 1. 机制

| 组成 | 位置 | 事实 |
| --- | --- | --- |
| 逐会话沙箱根 | `packages/sandbox/sandbox-policy/src/session-mode.ts`、`src/index.ts` | `setRoot` 追加一条 `sandbox/root` 事件；`sandboxRoot` 投影折叠；`resolve()` 的根目录优先级为：最后一次 `sandbox/root` → 不可变 header cwd → 部署回退。事件仅写日志，跨重启回放，不改变 header cwd 与工作区成员关系 |
| 子级显式根 | `packages/subagent/subagent/src/types.ts`、`src/manager.ts` | `SubagentStartRequest.sandboxRoot` 在首次请求前写入子会话日志；请求能力 `sandboxRoot` 由进程内 spawn/fork 声明，进程外后端拒绝该请求而不是静默放宽 |
| 委派继承 | `packages/subagent/subagent/src/child-agent.ts` | 父会话的显式根以 `source: 'delegation'` 写入子会话，节点派生出的子 agent 不能扩大范围 |
| 节点作用域 | `packages/experimental/agent-flow-runtime/src/executor.ts`、`src/conversation.ts` | 工作节点把迭代目录作为 `request.sandboxRoot`；交互节点保留工作区为 header cwd（继续可挂载工作区），把迭代目录设为工作目录与沙箱根 |

部署未挂载 sandbox policy 时没有受限写入可收窄，节点行为与之前一致；此时也无法提供本验收要求的保护。

## 2. 负向验收

命令：

```sh
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/agent-flow-l1-identity.e2e.ts -t "E2[67]"
```

结果：2 passed（E26 工作节点、E27 交互节点）。每个节点按顺序发起六次真实 Bash 写入，每次都必须被拒绝：

| 顺序 | 操作 | 目标 |
| --- | --- | --- |
| 1 | 同字节覆盖 | 上游 `original.txt` |
| 2 | 改写 | 上游 `original.txt` |
| 3 | 删除 | 上游 `original.txt` |
| 4 | 重命名 | 上游 `original.txt` → `original.txt.moved` |
| 5 | 临时文件替换 | 在节点目录写临时文件后 `mv` 到上游 |
| 6 | 路径别名 | 在节点目录建立指向上游的符号链接，再经链接写入 |

断言：六条 `tool/result` 都包含 `STEP-DENIED`（该标记只在 shell 未能执行写入时输出）；上游正文仍为 `upstream-original`；工作节点的上游目录只剩 `original.txt`（没有 `.moved` 或替换条目）；两个节点的会话日志各有且只有一条 `sandbox/root` 等于其迭代目录。

E27 的上游文件位于工作区根，交互节点是执行入口，因此该用例同时覆盖“入口节点读取运行请求”和“交互节点只写自己的目录”。返工读取上一轮产物沿用同一规则：每次迭代目录是其自身沙箱根，其他迭代目录（包括同一节点上一轮）只能读取；D 项的两轮返工用例在此基础上验证读取路径。

## 3. 同批验证

| 检查 | 结果 |
| --- | --- |
| `tsc -b tsconfig.host.json` | exit 0 |
| `vitest run packages/sandbox/sandbox-policy/tests` | 30/30 通过（含根目录优先级、回放、相对根拒绝） |
| `vitest run packages/subagent/subagent/tests` | 通过，含 `sandbox-root.spec.ts` 5/5（子级事件、委派继承、能力拒绝、缺少服务时失败） |
| `vitest run packages/experimental/agent-flow-runtime/tests` | 83/83 通过（含工作节点 `sandboxRoot`、交互节点工作目录与解析根） |
| `vitest run --config vitest.web.config.ts apps/web/tests/agent-flow-l1-identity.e2e.ts apps/web/tests/agent-flow-session-isolation.e2e.ts` | 18/18 通过 |
| `pnpm run test:docs` | 21 项检查全部通过 |
| `pnpm run lint` | 0 error；1 条既有 warning（`client-ui-cot-translation` 未使用指令，与本改动无关） |
| `pnpm run verify-type-equiv` | 554 个块全部匹配 |
| 持久化类型变更记录 | `docs/persistence-changes/2026-11-08-sandbox-root-and-flow-source.*` 已生成，same-version 决策 |

## 4. 已知边界与发布注意

- **官方宿主已改由独立插件路线保护。** 初版候选依赖 fork 的 `sandbox/root`/`sandboxRoot`，在官方 CLI 上不生效；当前实现改为节点会话 header cwd = 迭代目录（工作节点用 carrier 会话承载，交互节点直接记录），官方宿主无需修改。工作节点与交互节点在官方全新 profile 上各六种写入全部拒绝、上游原件保持。[独立插件验收](standalone-verification-2026-11-08.md) 发布范围不再要求配套 fork。
- **平台临时区域仍可写。** `workspace-write` 保留 `/tmp` 与用户临时目录授权，因此工作区本身位于系统临时目录时无法演示拒绝。Web 验收通道改用 HOME 下的工作区（`LaunchOptions.workspaceParentDirectory`）；生产工作区通常不在临时目录。
- **`sandbox/root` 是必需读取的新事件。** 不认识它的构建会拒绝恢复该类会话，而不是静默放宽边界；发布时需在“配套 fork 宿主修改”一栏列出该事件、`sandboxRoot` 请求能力与运行时的作用域逻辑。
- **交互节点的 header cwd 保持工作区。** 沙箱根与工作目录都指向迭代目录，会话仍可挂载到工作区；把 header cwd 改成节点目录会破坏工作区挂载，已排除。
- **420px 结果页受侧栏挤压。** 在 420px 视口下，应用左侧栏仍占宽，结果面板右侧被裁切（截图 `.artifacts/agent-flow-e28-results-light.png`）。请求开关与结果内容仍可用键盘到达，但完整可读性需要更宽视口或后续的窄屏壳层适配；本次未修改壳层布局。
- **未覆盖。** 远程工作区、终端持久会话跨节点复用、以及非 macOS/Linux 的 ACL 后端未在本次验收中执行；它们使用同一份解析策略，但仍需在对应平台单独取证。
