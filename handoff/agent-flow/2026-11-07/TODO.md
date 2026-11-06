# Agent Flow 换机交接清单 · 2026-11-07

接手顺序为恢复本次工作树、复跑无 key 基线、补同一编辑器的并发启动回归、完成固定两轮评审与 E23–E25 验收。上一轮 inbox 关闭期间收到外部输入、提交事件的两个读数不一致，这两项已独立复测通过。当前可换机继续开发，项目级验收仍有待办。

## 1. 新电脑从仓库接手

- [ ] 检出包含本清单与配套修复的提交，进入仓库根目录。核对新增文件 `packages/core/agent/src/errors.ts` 与 AgentLoop、subagent、Web 测试的改动已一并提交。
- [ ] 如需核对 2026-11-07 验收时的源码，可执行以下命令。校验值对应当时的 27 个源码与测试等文件，后续开发可能更新这些文件。

```bash
handoff_dir="$PWD/handoff/agent-flow/2026-11-07"
shasum -a 256 -c "$handoff_dir/source-files.sha256"
```

需要从旧基线还原当时的未提交工作树时，可使用[原始换机包](agent-flow-handoff-2026-11-07.zip)。包内保留了增量 Git bundle、完整补丁、校验清单及原始还原步骤。检出已经包含修复的提交后即可直接执行下列安装步骤。

- [ ] 安装项目支持的 Node（`^22.19.0 || >=24`）和 `pnpm 11.7.0`。本次使用 Node `v26.10.0`。在仓库根目录构建本机产物并安装 Chromium。Linux 缺少系统依赖时，Playwright 的安装命令可加 `--with-deps`。

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm --filter @deepseek-ai/dsh-web-frontend exec playwright install chromium
```

- [ ] 复跑下一节的自动化测试。手工打开 GUI 前按 `packages/experimental/agent-flow-profile/README.md` 在新机的 web profile 添加本地插件，并使用 `dsh --profile web --dump-config` 核对服务、runtime 与 UI 三个插件都已挂载。使用新电脑实际的 checkout 路径。自动测试使用各自的临时 profile 和 mock。
- [ ] 若需要在新机查看旧的真实 Flow 记录，另迁移对应的 Agent Flow 存储、Session 和工作区生成的 `.dsh/flows/<runId>/` 文件。历史记录中可能有旧机绝对路径，迁移后抽查一个 Review 文档能否打开。开发交接包未包含真实聊天、凭据、node_modules 或本机 profile。新跑的 demo 可用新建工作区。

## 2. 本轮复核结果

| 项目 | 当前证据 |
| --- | --- |
| 关闭后的外部投递、持久化清理、事件读数 | 上轮 3 个失败探针本次 3/3 通过。工具还在退出时拒绝外部投递，重开 Session 后该标记不进入下一请求。卸载完成后旧句柄同样拒绝投递。提交事件内的 Agent 与 projection 读数相同。 |
| 核心、subagent 与卡片 | 核心 inbox、resume、scope-lifecycle、cancel、agent 和进度卡片组件共 201 项通过。AgentLoop contract 和 subagent 相关套件共 369 项通过。 |
| 浏览器身份、并发与重连 | 无 key 的 L1 文件 11/11 通过。E01 已完成运行的卡片在同目录普通对话隐藏，返回原会话恢复。E07 并发澄清、E08 双页同会话按请求摘要选中并取消、E17 多轮及推理/写作/工具阶段、E19 断线重连、E20 刷新均在本文件有证据。 |
| 同一编辑器第二次提交 | 把 E08 的第二页换成原页，其他断言保持，独立临时用例通过 1 次。当前正式 E08 使用同一 Session 的两个页，不覆盖编辑器实例在第二次认领 Flow 时的状态。 |
| 工具收尾语义 | 独立 JSONL 探针确认：工具在关闭期间结束，post-execute 明确返回的 additionalContexts 可保留到 nextStep，重开 Session 后会进入下一次 mock 请求。现有 contract 测试刻意保留该行为。架构记录结尾关于恢复后队列一定为空的措辞需要收窄。 |

在仓库根目录复跑。脚本文件来自解压目录，当前 checkout 下创建的临时 spec 运行后会删除。

```bash
python3 "$handoff_dir/references/disposal-mirror-probes-2026-11-07.py"
pnpm exec vitest run packages/core/agent-loop/tests/{cancel,inbox,resume,scope-lifecycle}.spec.ts packages/core/agent/tests/agent.spec.ts packages/experimental/client-ui-agent-flow/tests/progress.client.spec.tsx
pnpm exec vitest run packages/core/agent-loop/tests/contract-regressions.spec.ts packages/subagent/subagent/tests
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/agent-flow-l1-identity.e2e.ts
```

## 3. 剩余实施与验收，按优先级执行

| 顺序 | 待办与责任范围 | 完成标准 |
| --- | --- | --- |
| 1 · 复现稳定性 | [ ] 客户端测试负责人把 E08「同页、同 Session、同一 Flow 连续提交两次」纳入正式浏览器用例，保留已有双页用例。 | 第一条阻塞时从同一输入框重新选择 Flow，以不同请求摘要启动第二条。以用户看得到的文字选择并取消第一条，第二条继续完成。检查 Host 错误、页面错误、两条 run 身份及无额外普通 turn。如编辑器转换连锁问题再现，保留触发动作和错误堆栈。 |
| 2 · 关闭契约 | [ ] 核心维护者修订架构记录的中英文 Consequences，明确外部投递与已接受的工具结果上下文分别如何处理。 | `beginDisposal` 之后外部投递失败，关闭前未处理的外部输入被清理；已执行工具在收尾时产生的 additionalContexts 可以保留。补一个跨 JSONL 恢复和实际 mock 请求的工具结果用例。保留崩溃恢复语义。位置见 `packages/core/agent-loop/src/agent.ts`、`tests/contract-regressions.spec.ts` 及 2026-11-06 的架构记录。 |
| 3 · E15 两轮并行评审 | [ ] 运行时负责人实现固定图验收：三角色第一轮 → 汇总 1 → 三角色第二轮 → 汇总 2。 | 用闸门控制完成顺序，核对第二轮的三个请求都读到汇总 1，汇总 2 等三个有效前驱且只启动一次。循环内并行继续在校验阶段拒绝。 |
| 4 · E23 / E25 配置与路由 | [ ] Host + 客户端负责人验证保存重开、节点模型路由、改图、模板删除及非法配置。 | 从适配器收到的真实请求参数验证每个节点的 provider/model。既有 run 固定图；模板在节点启动时读取的行为单独验证。非法输入在可确定时明确报错，无静默换模型，无额外请求；退出流程选择后普通对话可用。 |
| 5 · E24 与身份矩阵收尾 | [ ] GUI 负责人覆盖交付页面、工作区切换及文件归属；核对 E04、E08、E22 未完成的浏览器子场景。 | 运行中切到同目录普通对话无旧卡片；不同 Flow 历史来回切换、另一工作区重复同一 Flow 时结果和文件地址各自正确。搜索、归档后能返回原运行。检查中文/空格/同名/缺失文件、行链接、长 Markdown、键盘、窄屏和两种主题；结果页隐藏条件节点。提供页面实操记录和 GIF。 |
| 6 · 集成收尾 | [ ] 在新机干净构建上复核类型检查、相应 keyless snapshot、改动涉及的双语文档和打包加载。 | 记录分支、提交、实际命令、失败与截图。历史 GIR-004 类型问题、GIR-005 空输入提示边角、O-001 清理风险及旧 replay 超时按当时的反例核对，已有覆盖可直接引用；单独记录仍可复现的项。 |
| 7 · T-10 产品验证 | [ ] 先冻结脚本控制集和模型配置，再按预算执行公开任务与自有需求，做质量与成本对照。 | 初始范围为约 30 个控制场景、固定抽取的 20–30 个 SWE-Bench Pro V2 公开任务、10–20 个自有需求。比较单强、单低成本、多 Agent 全强、多 Agent 混合四组，记录成功率、含重试总成本、耗时、人工接管和流程违规。真实模型运行单独确认预算。 |

## 4. 已有产品决议与后置事项

固定图支持并行 DAG、串行返工，直连多个执行前驱默认等待所有有效前驱，也可显式 all 汇合。执行线交接结果；输入线只引用该路径上已有结果。Agent 默认不接收原始用户输入，需要时显式连线。工作区同目录不能作为结果卡片的关联条件。

- [ ] 后续单独讨论 AF-006 强制人工确认、AF-008 模板及有效模型路由冻结、AF-009 远程工作区产物交接和断点续跑。当前中断收敛与新 Session 的恢复测试并不代表 Flow 自动续跑。
- [ ] 后续产品场景保留角色级权限（例如开发可运行但不能修改测试）及多角色讨论、汇总、用户裁决。近期的两轮固定 DAG 用例是可先交付的会议场景。

完整场景与原验收标准见 [E01–E25 测试计划](references/agent-flow-e2e-test-plan-2026-11-05.md)。T-10 的抽样与评分细则见 [历史总清单](references/implementation-todo.md)。历史报告保留当时结论，当前接手状态以本清单为准。所有源码位置均相对于新机仓库根目录。
