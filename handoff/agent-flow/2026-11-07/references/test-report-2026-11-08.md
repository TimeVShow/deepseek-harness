# Agent Flow 测试报告 · 2026-11-08

本报告记录 2026-11-08 在新检出仓库上的无 key 回归、新增验收用例，以及两次最小预算真实模型运行。范围是交接清单的基线复跑、E08/E15/E22/E23/E24 补充和 T-10 的单点数据；不把单次真实运行当成四组配置对照或统计结论。

## 1. 环境与版本

| 项 | 值 |
| --- | --- |
| 分支 | `agentflow`（AgentFlow V1.0 提交 + 本轮未提交的测试/文档改动） |
| 平台 | macOS arm64 |
| Node / pnpm | v25.8.0 / 11.7.0 |
| 浏览器 | Playwright Chromium headless shell 149 |
| 真实模型凭据 | `~/.dsh/.credentials.yaml`（启动环境与仓库 `.env` 均无 Key；报告不记录密钥） |
| 干净树构建 | 首次 `pnpm run build` 因缺少 Typert `/remote` 声明失败；先执行一次 `tsdown --env.DSH_BUILD_FACE host` 播种后构建成功 |

## 2. 自动化回归结果

| 检查 | 结果 |
| --- | --- |
| 关闭探针 `disposal-mirror-probes` | 3/3 通过 |
| 核心组（cancel / inbox / resume / scope-lifecycle / agent / 进度卡片） | 202/202 通过 |
| AgentLoop contract + subagent | 369/369 通过 |
| Agent Flow 服务与运行时全量 | 176/176 通过 |
| Web L1 identity（含新增 E08 同页、E23、E24） | 14/14 通过 |
| Web session isolation（含新增 E22） | 2/2 通过 |
| keyless snapshot | 172 通过，2 跳过 |
| `tsc -b tsconfig.host.json` | 通过 |
| oxlint（改动文件） | 0 warning / 0 error |
| `publint` | exit 0（仅既有 `./src/*` 提示） |
| `verify-node-next-types` | 320 个声明 API 通过 |
| `verify-agent-note-format` / `verify-translation-pairing` | 通过 |
| `test:docs` | 19/20；`verify-repository-references` 失败，见第 5 节 |

## 3. 本轮新增或修改的测试

| 范围 | 文件 | 覆盖事实 |
| --- | --- | --- |
| E08 同页第二次认领 | [apps/web/tests/agent-flow-l1-identity.e2e.ts](../../../../apps/web/tests/agent-flow-l1-identity.e2e.ts) | 同一页面、同一 Session、同一 Flow 连续两次经 composer 启动；按请求摘要选择并取消第一条；第二条完成；父 Session 无额外普通 turn |
| E15 两轮固定 DAG | [packages/experimental/agent-flow-runtime/tests/graph.spec.ts](../../../../packages/experimental/agent-flow-runtime/tests/graph.spec.ts) | 闸门控制下第一轮三路并行、汇总 1 等全部前驱；第二轮三路读到汇总 1；汇总 2 等三个有效前驱且只启动一次 |
| E22 历史、搜索、归档 | [apps/web/tests/agent-flow-session-isolation.e2e.ts](../../../../apps/web/tests/agent-flow-session-isolation.e2e.ts) | 占用中的 Flow 父会话保持可识别历史行；平铺列表仍可见；按显示标题搜索可返回原身份；归档后可见于“显示已归档”，恢复后归档集合清空 |
| E23 路由与固定图 | [apps/web/tests/agent-flow-l1-identity.e2e.ts](../../../../apps/web/tests/agent-flow-l1-identity.e2e.ts) | 从脚本模型收到的真实请求验证每个节点的 provider/model；已有 run 固定快照；模板在节点启动时读取；改图后新 run 使用新模板 |
| E24 结果页（部分） | [apps/web/tests/agent-flow-l1-identity.e2e.ts](../../../../apps/web/tests/agent-flow-l1-identity.e2e.ts) | 条件节点无卡片；工作节点各一张卡；长 Markdown 渲染与展开；更早轮次可用；420px 窄屏 + 深色主题；键盘展开原始需求 |
| 工具结果上下文恢复 | [packages/core/agent-loop/tests/resume.spec.ts](../../../../packages/core/agent-loop/tests/resume.spec.ts) | 关闭排空期间结算的已接受工具结果上下文经 JSONL 恢复后仍在 `nextStep`，并进入下一次真实 mock 请求 |
| 脚本模型夹具 | [apps/web/tests/fixtures/scripted-llm.js](../../../../apps/web/tests/fixtures/scripted-llm.js) | 记录每个 CASE 实际解析的 provider/model；`[LONG]` 返回长 Markdown 交付物 |
| 关闭契约文档 | [.agents/notes/implemented/architecture/2026-11-06-disposal-owns-machine-cancellation.md](../../../../.agents/notes/implemented/architecture/2026-11-06-disposal-owns-machine-cancellation.md) | 中英文 Consequences 明确外部投递被清理、已接受工具结果上下文保留；i18n 配对已重录 |

## 4. 真实模型最小运行（T-10 切片）

两次运行都未自动重试、未调用工具、无人工接管；成本按官方列表价的空闲时段折算，实际账单为准。

### 4.1 单 Agent + deepseek-flash 基线

| 项 | 值 |
| --- | --- |
| 任务 | `T10-CONTROL-01`：社区图书交换简报，固定三标题、≤120 词、结尾 `T10-DONE` |
| 请求 | 1 次（标题生成 LLM 关闭） |
| Token | 输入 12,552 / 输出 645 / 缓存 0 / 总计 13,197 |
| 耗时 | 模型延迟 4.79s；CLI 8s |
| 结果 | 通过：三标题、68 词、结束标记齐全，无工具调用 |
| 估算成本 | ≈ 0.0151 元（空闲时段）；高峰约 0.0303 元 |
| Session | `session-67a4dd30-df89-41c8-97ca-a2631c4c95a8` |

### 4.2 F-A 两节点：Start → Writer → Checker → End

两个节点均使用 `deepseek-official/deepseek-flash`；通过 Host API 启动，未产生根 Agent 模型调用；标题生成 LLM 关闭。

| 节点 | 状态 | 请求 | 工具 | 输入/输出 | 结果 |
| --- | --- | --- | --- | --- | --- |
| writer | succeeded | 1 | 0 | 1,040 / 531 | 三标题、72 词、`T10-DONE` |
| checker | succeeded | 1 | 0 | 1,133 / 219 | `CHECK-PASS`、`T10-CHECKED` |
| 合计 | completed | 2 | 0 | 2,173 / 750 | 6.1s，run `c847a881-da15-4c90-ad5a-697d5916967a` |

估算成本 ≈ 0.0052 元（空闲时段）；高峰约 0.0103 元。两次真实运行合计约 **0.02 元**。

**观察（2026-11-08 修正）。** 测试计划要求所有节点在最终说明中保留本次 CASE 标识，因此 CASE 未保留是**任务要求的失败**，不是夹具噪声。Writer 的交接文本没有 `[CASE:T10-FA-01]`，Runner 的 `writerOk` 与 `accepted` 为 false 是正确判定。用 [判定脚本](t10-fa-judgment-2026-11-08.py) 对 [原始输出](t10-fa-original-2026-11-08.out) 重放冻结规则：三标题、66 词、`T10-DONE`、`CHECK-PASS`/`T10-CHECKED`、无工具、单请求、flash 路由均通过，`case_retained` 失败，重评分 `accepted: false`（[重评分](t10-fa-rescore-2026-11-08.json) 与原记录并存）。要让 F-A 可接受，节点指令必须显式要求保留 CASE 标识；这不改变任务内容本身的通过事实。

### 4.3 边界

- 两次运行是 n=1 的探索样本，不构成四组配置（单 Agent 强/弱、多 Agent 全强/混合）的对照，也不提供统计显著性。
- 单 Agent 组与 F-A 组的任务、提示和上下文规模不同，不能直接比较成本高低；单 Agent 的 12.5k 输入主要来自 headless 的完整系统提示与工具模式。
- 真实模型质量只按预先写明的确定性验收（标题、词数、结束标记、Checker 结论）判定，未做人工质量评分。

## 5. 已知问题与未覆盖

1. **`verify-repository-references` 失败（已处理）**：交接包内的 Markdown 与 zip 含提交号，`test:docs` 曾为 19/20。冻结交接材料需要保留这些提交号以维持可追溯性，因此校验器把 `handoff/` 与 `vendor/`、归档笔记一样排除；两个工作树的文档检查现在分别为 20/20（旧分支）与 21/21（迁移分支）。
2. **干净树构建引导缺口**：没有历史 `lib/` 产物时，`pnpm run build` 的 Host tsc 会先于 Typert 生成而失败。建议在交接步骤写明先播种一次 host tsdown，或提供正式引导命令。
3. **E24 文件类场景未覆盖**：中文/空格文件名、同名 `RESULT.md`、缺失文件、文件预览与行号链接需要脚本夹具增加真实写文件工具调用。
4. **E25 浏览器错误展示未覆盖**：非法模板、删除占用模板和非法记录由 `service.spec.ts` 覆盖，但页面错误提示与重试路径未做浏览器验收。
5. **T-10 全量未执行**：四组配置对照、公开任务集与自有需求集仍需独立预算和排期。

## 6. 结论与后续

- 本轮无 key 回归全部通过；新增 E08、E15、E22、E23 和部分 E24 已进入正式测试。
- 关闭契约文档已与代码一致，工具结果上下文的恢复行为有 JSONL + mock 请求用例。
- 真实模型最小切片证明路由、交接和验收链路可用；成本约 0.02 元量级。F-A 未通过冻结验收（CASE 未保留），单 Agent 控制组按任务内容通过；两者都不构成四组配置对照。
- 后续优先级：处理既有 `verify-repository-references` 失败与构建引导缺口；补齐 E24/E25 浏览器场景；再决定是否扩大 T-10。

## 7. A–E 执行记录（2026-11-08 本轮）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 只读交接阻断项 | 通过（配套 fork） | [只读交接验收](read-only-handoff-acceptance-2026-11-08.md)：E26/E27 六种写入全部拒绝 |
| A 宿主适配与安装包 | 通过（独立插件） | [候选包与全新 profile 验收](package-and-host-verification-2026-11-08.md)；[独立插件验收](standalone-verification-2026-11-08.md) 证明官方宿主上的只读交接 |
| B E23/E25 | 通过 | E23 路由与图快照；E25 页面错误、零请求、修正后执行 |
| C E24/E28 | 通过（420px 完整可读性为已知限制） | E24 条件/长文/历史/键盘；E28 文件、跨 run/工作区、行号、中文/空格、缺失文件、双主题 |
| D 两轮返工与 E15 | 通过 | 6 次请求、迭代 0/1/2；第一轮闸门在第三个角色阻塞时 Summary 为 0 |
| E 记录与 T-10 | 通过 | 文档检查 21/21；[执行记录](acceptance-summary-2026-11-08.md) 与 F-A 重评分 |

E23/E24 口径修正：原“E24 文件类场景未覆盖”与“E25 浏览器错误展示未覆盖”已由 E28/E25 补齐；“T-10 单 Agent 通过”仅指控制组任务内容，F-A 按冻结验收失败。

### 2026-11-08 后续检查结果

| 检查 | 结果 |
| --- | --- |
| 迁移分支 `tsc -b tsconfig.host.json` | exit 0 |
| 受影响包（sandbox-policy/subagent/agent-flow-runtime） | 562/562 |
| Web L1 + session isolation | 20/20 |
| keyless snapshot | 239 通过，2 跳过；四个 subagent headless 夹具按官方 0.2.2 的事件顺序刷新（仅顺序变化） |
| `pnpm run build` + 四个 `pnpm pack` | exit 0；tarball 内容见候选包记录 |
| `test:docs` | 迁移分支 21/21，旧交接工作树 20/20 |
| `pnpm run lint` | 0 error（1 条既有 warning） |

## 附：证据路径

- 单 Agent 基线 NDJSON：`/tmp/t10-run.jsonl`
- F-A runner 结果：`/tmp/t10-fa.out`，错误输出 `/tmp/t10-fa.err`
- 单 Agent Session：`~/.dsh/sessions/--Users-lzy-Code-deepseek-harness--/session-67a4dd30-df89-41c8-97ca-a2631c4c95a8/`
- 交接基线探针与既有报告：`handoff/agent-flow/2026-11-07/references/`
