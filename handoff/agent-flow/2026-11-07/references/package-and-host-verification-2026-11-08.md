# Agent Flow 候选包与全新 profile 验收 · 2026-11-08

本记录对应 [V1.0 发布交接](v1-release-handoff-2026-11-08.md) A 项。结论：四个候选包在官方 CLI `0.2.2-rc.1` 的全新 profile 中安装、组合并通过页面完成了一条脚本模型 Flow，重开页面后仍能取回结果。**但只读交接的保护在该环境未生效**：官方 host 的 `subagent` 与 `sandbox-policy` 不认识本分支新增的 seam，因此发布范围必须标为配套 fork，官方宿主兼容（尤其是只读交接）继续待验。

## 1. 候选包

构建：`pnpm run build`（exit 0），随后在四个包目录执行 `pnpm pack`。

| 包 | 包名 | tarball 大小 | 内容核对 |
| --- | --- | --- | --- |
| agent-flow | `@deepseek-ai/dsh-experimental-agent-flow` | 74,352 B | `lib/index.js`、`lib/types/**`、`lib/typert.host.*`、`lib/typert.remote-client.*` |
| agent-flow-runtime | `@deepseek-ai/dsh-experimental-agent-flow-runtime` | 28,105 B | `lib/index.js`、`lib/types/**`；含 `sandboxRoot` 作用域代码 |
| client-ui-agent-flow | `@deepseek-ai/dsh-experimental-client-ui-agent-flow` | 194,733 B | `lib/index.js`、`lib/client.js`、`lib/types/client/**` |
| agent-flow-profile | `@deepseek-ai/dsh-experimental-agent-flow-profile` | 6,983 B | `cordis.patch.yml`、`icon.svg`、`lib/index.js`、`lib/types/**` |

四个 tarball 的 `package.json` 中 `workspace:*` 已改写为 `0.2.2-rc.1`；profile 声明 `dsh.bundle.patch` 与 `icon`。npm scope 为 `@deepseek-ai/`，候选版本均为 `0.2.2-rc.1`。

## 2. 新环境

| 项 | 值 |
| --- | --- |
| 环境 | `/tmp/dsh-fresh`（空目录，`npm init`） |
| 官方 CLI | `npm install @deepseek-ai/dsh@0.2.2-rc.1`；`dsh --version` 输出 `0.2.2-rc.1` |
| pnpm | 环境内安装 `pnpm@11.28.5` 并通过 `PATH` 提供（CLI 的 `plugin` 子命令需要） |
| DSH_HOME | `/tmp/dsh-fresh/home`（全新） |
| profile | `web`，首次 `--dump-config` 时初始化 |

安装命令（依赖包按 `file:` tarball 加入，随后 CLI 注册组合包）：

```sh
dsh plugin --profile web add /tmp/flow-packs/deepseek-ai-dsh-experimental-agent-flow-0.2.2-rc.1.tgz
dsh plugin --profile web add /tmp/flow-packs/deepseek-ai-dsh-experimental-agent-flow-runtime-0.2.2-rc.1.tgz
dsh plugin --profile web add /tmp/flow-packs/deepseek-ai-dsh-experimental-client-ui-agent-flow-0.2.2-rc.1.tgz
dsh plugin --profile web add /tmp/flow-packs/deepseek-ai-dsh-experimental-agent-flow-profile-0.2.2-rc.1.local.tgz
dsh --profile web --dump-config
```

**本地依赖解析适配。** 候选 `client-ui-agent-flow` 未发布到 registry，profile tarball 内的依赖范围会被 pnpm 解析到远端并 404。为在空环境验证这组候选，测试把 profile tarball 解包后的 `package.json` 三个依赖改写为对应 `file:` tarball 路径（文件名加 `.local`），其余内容不变。正式发布时应同时发布四个包，或发布改写后依赖指针的 profile 包。

证据：

- `--dump-config` 在 `# == @deepseek-ai/dsh-experimental-agent-flow-profile` 下输出 `agent-flow`、`agent-flow-runtime`、`ui-agent-flow` 三行。
- profile `pnpm-lock.yaml` 的三项 specifier/version 均为 `/tmp/flow-packs/*.tgz`（`file:`），确认安装的是候选 tarball。
- 安装后的 runtime `lib/index.js` 含 `sandboxRoot` 作用域代码。

## 3. 页面脚本模型 Flow

启动（测试 overlay 插入脚本模型并停用 keyed adapter）：

```sh
dsh --profile web --patch /tmp/dsh-fresh/overlay.yml --no-open --port 45678
```

页面实操（Playwright，截图在 `.artifacts/fresh-flow-*.png`）：

1. 首次进入完成 Preview Notice。
2. Agent Flow → Flows → New flow，生成并保存中性 `start → step → end` 图（模板 `Starter agent`）。
3. 回到会话，从 composer 的 Workflow 选择 `Untitled flow`，输入 `run the starter flow` 回车。
4. 运行卡片显示 `Flow completed`；`View full flow` 显示 Start/End 与 `Starter agent · Succeeded`，交付文本为 `worker handled CASE:NO-CASE`。
5. 刷新页面后再次 `View full flow`，同一运行仍显示 `Completed` 与相同交付文本。

## 4. 官方宿主兼容判定

**只读交接未生效。** 新环境解析到的是官方 `@deepseek-ai/dsh-subagent` 与 `@deepseek-ai/dsh-sandbox-policy`，其 `lib/index.js` 均不含 `sandboxRoot` / `sandbox/root`（grep 计数为 0）。运行时在挂载 sandbox policy 时仍会传入 `request.sandboxRoot`，官方管理器忽略未知字段，因此节点不会因上游写入被拒绝。本项不能按官方宿主签收。

**最小 host 差异**（相对官方 `66491b05e3`，不含四个 Flow 包）：

- `packages/sandbox/sandbox-policy`：`sandbox/root` 事件与投影、解析优先级、`setRoot`；README/测试。
- `packages/subagent/subagent` 及 spawn/fork/acp provider：`sandboxRoot` 能力与请求字段、首次请求前写入、委派继承、失败诊断；README/测试。
- 移植提交另含 Session 占用 seam（`api/session-controller` 的 usage/list/types、client sessions、ui-workspace）等宿主改动。

发布结论：本轮产物应标注为**配套 fork** 的候选包；官方宿主上的 Flow 功能可用，但只读交接保护需要 fork 的 `sandbox-policy` 与 `subagent`（或将其上游化后重新验证）。A 项的“官方宿主 + 安装包 + 脚本模型 Flow + 重开 Session”已在官方 CLI 上完成；只读交接的官方宿主签收仍为待验。

## 5. 复跑入口

- 候选包：`/tmp/flow-packs/*.tgz`（`.local` 为测试用依赖改写版）。
- 页面脚本：`.artifacts/fresh-probe.mjs`、`.artifacts/fresh-probe2.mjs`、`.artifacts/fresh-flow-run.mjs`（未入库）。
- 测试 overlay：`/tmp/dsh-fresh/overlay.yml` 插入 `apps/web/tests/fixtures/scripted-llm.js`，并停用 `llm-deepseek`。
- 截图：`.artifacts/fresh-flows.png`、`fresh-flow-created.png`、`fresh-flow-running.png`、`fresh-flow-reopened.png`。

## 6. 补记（2026-11-08 晚）：独立插件路线已生效

第 4 节的“官方宿主上只读未生效”是**初版候选**的结论：当时 Flow 包依赖 fork 的 `sandbox/root`/`sandboxRoot` seam。此后的独立插件实现改为让节点会话不可变的 header cwd 等于迭代目录：

- 工作节点由每节点一个的 carrier 会话承载（`meta.cwd = 迭代目录`），subagent 子级继承 carrier 的 header cwd；
- 交互节点直接把迭代目录记录为 header cwd；
- Flow 包不再调用 `sandboxPolicy.setRoot` 或传 `request.sandboxRoot`。

在同一个官方 `0.2.2-rc.1` 全新 profile 上重跑，工作节点与交互节点各六种真实 Bash 写入全部被拒绝（`STEP-DENIED`），上游 `original.txt`/`upstream.txt` 保持原字节；官方 `subagent` 与 `sandbox-policy` 未修改。[独立插件验收](standalone-verification-2026-11-08.md)

因此发布范围不再要求配套 fork；B（官方宿主身份矩阵）、D（从官方标签重建干净候选并按 registry 只装组合包）、E（完整签收矩阵）仍是剩余项。
