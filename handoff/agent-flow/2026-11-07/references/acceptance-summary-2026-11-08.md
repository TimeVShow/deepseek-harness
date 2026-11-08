# A–E 执行记录与判定 · 2026-11-08

本记录汇总 [V1.0 发布交接](v1-release-handoff-2026-11-08.md) A–E 的执行结果，并修正 [原测试报告](test-report-2026-11-08.md) 中 E23/E24 的覆盖口径与 T-10 的判定。每条检查给出通过、失败或跳过，证据路径保持可复查。

## 1. 结论

| 项 | 状态 | 结论 |
| --- | --- | --- |
| 只读交接（发布阻断项） | 通过（配套 fork） | E26/E27 六种写入全部拒绝；官方宿主不生效，见 [只读交接验收](read-only-handoff-acceptance-2026-11-08.md) |
| A 宿主适配与安装包 | 通过（独立插件） | 四个候选包在官方 CLI 全新 profile 安装并跑通脚本模型 Flow；节点 header cwd = 迭代目录，官方宿主上工作/交互节点六种写入全部拒绝，见 [独立插件验收](standalone-verification-2026-11-08.md) |
| B 配置与模型路由（E23/E25） | 通过 | E23 路由与图快照、E25 页面错误与修正后执行 |
| C 结果、文件与工作区（E24/E28） | 通过（420px 完整可读性为已知限制） | 同运行/跨运行/跨工作区文件、行号链接、中文与空格名、缺失文件、历史轮次、双主题 |
| D 并行与多轮返工 | 通过 | 连续两次退回的 6 次请求与迭代 0/1/2；E15 第一轮闸门 |
| E 验收与记录 | 通过 | 文档检查 21/21；T-10 F-A 冻结判定经重放仍为失败（CASE 标记为任务要求） |

## 2. 每项检查

### A · 宿主适配与安装包

- 通过：`pnpm run build` exit 0；四个 `pnpm pack` tarball 含 JS、类型、Remote 客户端、bundle patch、图标；依赖已解析为 `0.2.2-rc.1`。
- 通过：空环境安装官方 CLI `0.2.2-rc.1`，全新 `DSH_HOME` 与 `web` profile，候选包以 `file:` 安装；`--dump-config` 出现 `agent-flow`、`agent-flow-runtime`、`ui-agent-flow` 三行。
- 通过：官方 CLI 启动 Web，页面创建中性 Flow，从 composer 用脚本模型完成运行；刷新后重开同一运行仍显示 `Completed` 与交付文本（`.artifacts/fresh-flow-*.png`）。
- 失败（范围限制）：全新环境解析到官方 `subagent`/`sandbox-policy`，只读交接 seam 不存在，上游写入不会被拒绝。发布范围标为配套 fork；官方宿主只读签收未完成。

### B · E23 / E25

- 通过（E23）：从脚本模型收到的真实请求验证每个节点的 provider/model；已启动 run 保留图快照；未启动节点按启动时读取模板；改图后新 run 使用新模板。
- 通过（E25）：未知 provider 的 run 失败、wire 请求数为 0、结果页显示 `missing-provider`；修正模板后一次提交只执行预期节点且请求数为 1；退出 Flow 选择后普通消息正常。
- 口径修正：原报告“E25 浏览器错误展示未覆盖”已由 E25 覆盖；`service.spec.ts` 仍负责保存/删除/非法记录的确定性错误。

### C · E24 / E28

- 通过（E24）：条件节点无卡片、工作节点各一张卡、长 Markdown 展开、历史轮次展开后两轮正文各自独立、420px 与深色下请求开关可键盘操作。
- 通过（E28，新增）：真实 `write` 工具生成同名 `RESULT.md`；两次运行与两个工作区分别打开各自文件；Markdown 行链接定位到第 3 行；中文与空格文件名；删除后显示 `workspace-file/not-found`；返回按钮清除结果面板；浅色与深色截图。
- 已知限制：420px 视口下左侧应用栏仍占宽，结果面板被裁切（`.artifacts/agent-flow-e28-results-light.png`）；键盘仍可到达内容。完整窄屏适配未在本次修改壳层。
- 跳过：GIF 录屏未生成；`.artifacts/` 下的页面截图与可重放用例作为操作记录。

### D · 并行与多轮返工

- 通过：`rejected → rejected → approved`，6 次节点请求，writer/reviewer 迭代 0/1/2，第三轮 reviewer 读到第三版稿件、第三轮 writer 读到第二次退回意见，End 只成功一次。
- 通过：E15 第一轮两个角色已 `succeeded`、第三个仍阻塞时 Summary 请求为 0；释放第三个后 summary 1 恰好一次，第二汇总仍只一次。

### E · T-10 与记录

- **CASE 标记是任务要求。** 测试计划要求所有节点在最终说明中保留本次 CASE 标识；F-A 的 writer 交接未保留 `[CASE:T10-FA-01]`，因此原运行 `writerOk: false`、`accepted: false` 是有效失败，而不是夹具噪声。
- **冻结判定重放。** 用原输出 `t10-fa-original-2026-11-08.out` 与判定脚本 `t10-fa-judgment-2026-11-08.py` 重算：内容检查（三标题、66 词、`T10-DONE`、`CHECK-PASS`/`T10-CHECKED`、无工具、单请求、flash 路由）全部通过，`case_retained` 为 false，`accepted` 仍为 false；重评分保存在 `t10-fa-rescore-2026-11-08.json`，与原记录并存。
- **后续要求。** 若要让 F-A 可接受，节点指令必须显式要求保留 CASE 标识；任务内容本身已通过，不应把该失败解释为模型质量问题。
- 通过：`pnpm run test:docs` 21/21（旧交接工作树 20/20）；`tsc -b` exit 0；`pnpm run lint` 0 error（1 条既有 warning）；受影响包 562/562；Web L1 + isolation 20/20。
- 通过：keyless snapshot 239 通过、2 跳过。四个 `subagent-*` headless 夹具按官方 0.2.2 的事件顺序刷新（policy 事件先于 preset 链，仅顺序变化，无新增事件）；`-t agent-flow` 无匹配用例，本分支没有 Flow 快照。
- 已处理：`verify-repository-references` 排除冻结的 `handoff/` 快照，保留历史提交号的可追溯性。

## 3. E23/E24 口径修正摘要

| 原报告表述 | 修正 |
| --- | --- |
| “E24 文件类场景未覆盖” | 已由 E28 覆盖：同名文件、跨 run/工作区、行号、中文/空格、缺失文件、返回、双主题 |
| “E24 结果页（部分）” | E24 覆盖条件节点、长 Markdown、历史轮次、键盘与 420px；E28 覆盖文件与工作区 |
| “E25 浏览器错误展示未覆盖” | E25 已覆盖页面错误、无模型请求、修正后单次执行、普通聊天 |
| “T-10 单 Agent 真实运行通过” | 单 Agent 控制组按任务内容通过；F-A 按冻结验收失败（CASE 未保留），两者不构成四组配置对照 |
