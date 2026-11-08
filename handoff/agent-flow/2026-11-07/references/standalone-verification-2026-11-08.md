# Agent Flow 独立插件验收 · 2026-11-08

本记录对应 [独立插件整改计划](../standalone-plugin-remediation-2026-11-08.md) 的 C 项及 A 项复核。结论：四个 Flow 包在官方 `@deepseek-ai/dsh@0.2.2-rc.1` 的全新 profile 中，以**未修改的官方宿主**完成了工作节点与交互节点的只读交接负向验收：两类节点各六次真实 Bash 写入全部被拒绝，上游原件保持不变。

## 1. 实现路线

节点会话不可变的 header cwd 就是其迭代目录，官方 `sandbox-policy` 已把这个值当作 `workspace-write` 根：

- **工作节点**：运行时为每个节点创建一个 carrier 会话（`meta.cwd = 迭代目录`），把运行父会话的 preset 与路由交给它，再以 carrier 为父启动现有的 subagent 子级。子级继承 carrier 的 header cwd，因此文件工具与子进程以迭代目录为写根；carrier 不运行轮次，并随子级处置。
- **交互节点**：会话 header cwd 直接记录迭代目录；只有目录等于工作区根时才加入工作区，节点目录不是工作区成员。
- Flow 包不再调用 `sandboxPolicy.setRoot`，也不再传 `request.sandboxRoot`；fork 的 `sandbox/root`/`sandboxRoot` 宿主 seam 保留给其他使用方，但本路径不依赖它。

官方子级实现包含 `cwd: parentHeader.cwd`，这是 carrier 路线在官方宿主成立的关键事实。

## 2. 环境与安装

| 项 | 值 |
| --- | --- |
| 官方 CLI | `@deepseek-ai/dsh@0.2.2-rc.1`（`/tmp/dsh-fresh`，npm 安装） |
| DSH_HOME | `/tmp/dsh-standalone-home`（全新） |
| profile | `web`，全新初始化 |
| 候选包 | 当前分支 `pnpm run build` 后 `pnpm pack` 的四个 tarball（`/tmp/flow-packs-standalone`） |
| 宿主解析 | 官方 `@deepseek-ai/dsh-subagent`、`@deepseek-ai/dsh-sandbox-policy`（不含 fork seam） |
| 脚本模型 | 测试 overlay 插入 `apps/web/tests/fixtures/scripted-llm.js` 并停用 `llm-deepseek` |
| 工作区 | 官方 CLI 默认工作区 `/Users/lzy/Documents/deepseek-harness/default-workspace`（HOME 下，避开临时目录授权） |

安装方式与 A 项一致：三个插件包以 `file:` 加入 profile，profile tarball 的依赖指针在测试环境中改写为对应 tarball 后由 CLI 注册组合包；`--dump-config` 显示三行 Flow 组合。正式发布仍需按 D 项把四包发布到同一 scope 或提供改写依赖的 profile 包。

## 3. 负向验收

两条流程通过页面从 composer 启动，均显示 `Flow completed`。

### 3.1 工作节点

- flow：`Sandbox flow`（Start → Writer → Checker → End），run `6522c04f-bde8-4d4c-ab77-6cbc7fbb51ac`。
- writer 会话 `91492f0b-b3f8-4473-a1da-edcb4d0d0911`、checker 会话 `85a16587-9a08-470e-b35d-b76224a80a2b`。
- checker 会话 header cwd = `.../00-checker`；其父为 carrier `flow-node-8155dea5-...`。
- checker 依次发起同字节覆盖、改写、删除、重命名、临时文件替换、经符号链接写入；6 条 `tool/result` 全部含 `STEP-DENIED`。
- 上游 `.../00-writer/original.txt` 仍为 `upstream-original`，上游目录只有该文件。

### 3.2 交互节点

- flow：`Sandbox entry flow`（Start → Reviewer[interactive] → End），run `2b286770-f4bf-41b9-aec0-17087e38a8ca`。
- reviewer 会话 `flow-5cb940af-9f55-48e5-a114-49c3a134d6a5`，header cwd = `.../00-reviewer`。
- 6 条 `tool/result` 全部含 `STEP-DENIED`。
- 工作区根的 `upstream.txt` 仍为 `upstream-original`。

证据命令（可在同一机器重放）：

```sh
zstd -dc "/tmp/dsh-standalone-home/sessions/--Users-lzy-Documents-deepseek-harness-default-workspace-.dsh-flows-6522c04f-bde8-4d4c-ab77-6cbc7fbb51ac-00-checker--/85a16587-9a08-470e-b35d-b76224a80a2b/session.v4.jsonl.zstd" | grep -c STEP-DENIED
cat "/Users/lzy/Documents/deepseek-harness/default-workspace/.dsh/flows/6522c04f-bde8-4d4c-ab77-6cbc7fbb51ac/00-writer/original.txt"
```

## 4. 当前状态与剩余项

| 项 | 状态 | 说明 |
| --- | --- | --- |
| A 官方基准与复现 | 完成 | 官方 CLI、全新 profile、宿主解析路径、失败证据均已记录 |
| B 运行身份与历史归插件 | 部分 | 运行记录、取消、结果与文件均按 runId/父会话定位；官方宿主没有 `occupied` 标记，空白会话复用与原生侧栏身份的完整矩阵未在官方环境执行 |
| C 官方宿主只读交接 | 完成（本轮） | 工作节点与交互节点各六种写入拒绝，原件保持 |
| D 干净候选与发布 | 部分 | 四包已在当前分支按正式流程打包；从官方标签重建干净分支、registry 只装组合包的安装方式未执行 |
| E 独立签收 | 部分 | 安装、运行、重开与只读矩阵已有；多 run/多会话、归档、卸载后启动仍需在同一候选上补验 |

发布结论：**只读交接与运行主链路已可在官方宿主独立安装使用**；在 B、D、E 的剩余矩阵完成前，候选状态为“可安装验证版”，不标注最终「可独立安装」。
