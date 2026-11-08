# Agent Note：Agent Flow 节点目录即沙箱根

状态：已实施

[English](2026-11-08-agent-flow-node-directories-are-sandbox-roots.md) | 中文

## 问题

运行的各节点在 `.dsh/flows/<run>/<iteration>-<node>` 下自己的迭代目录中工作，但官方宿主的沙箱根是会话不可变的 header cwd。工作子级继承了父会话的 header cwd，交互对话记录的是工作区，因此下游节点可以通过文件工具或任意子进程覆盖、删除、重命名或替换上游交付物。最初的修复通过新的宿主接口（`sandbox/root` 与 `sandboxRoot`）收窄根目录；官方宿主并不提供它们，独立安装插件时无法保证该边界。

## 决策

每个节点会话不可变的 header cwd 就是它的迭代目录，宿主现有的 sandbox policy 已把这个值当作 `workspace-write` 根：

- 工作节点运行在每节点一个的 **carrier 会话**下，创建时 `meta.cwd = <迭代目录>`。carrier 组合运行父会话的 preset 与路由，启动现有的 subagent 子级，并随子级一起处置；子级继承 carrier 的 header cwd，因此其文件工具与子进程以迭代目录为写根，它自己派生的子级也继承同一根。
- 交互对话把迭代目录记录为自己的 header cwd。只有目录等于工作区根时它才加入工作区；节点目录不能成为工作区成员，运行记录用 id 定位该会话。

Flow 包不再调用 `sandboxPolicy.setRoot`，也不再传 `request.sandboxRoot`。这两项宿主新增仍可供 fork 内其他使用方使用，但 Agent Flow 路径不需要修改宿主，四个包可以原样安装到官方 `0.2.2-rc.1` 宿主。

## 验证

`packages/experimental/agent-flow-runtime/tests/graph.spec.ts` 断言 carrier 的 `cwd`/`origin`/`parentSession`/`delegationDepth`、交互对话的 header cwd 以及子级请求目录。`apps/web/tests/agent-flow-l1-identity.e2e.ts` 的 E26/E27 在交付版 Web 组合中由工作节点和交互节点各发起六次真实 Bash 写入：会话 header cwd 为节点目录，所有工具结果都是 `STEP-DENIED`，上游文件保持原字节。

在官方宿主上，四个候选 tarball 安装进全新的 `0.2.2-rc.1` profile，使用官方 `subagent` 与 `sandbox-policy`。播种的 writer→checker 流程与交互入口流程都把节点会话 header cwd 记录为迭代目录，并各自得到六次拒绝（`STEP-DENIED`）；`original.txt` 与 `upstream.txt` 保持不变。官方子级继承 `cwd: parentHeader.cwd`，这正是 carrier 足够的原因。

## 考虑的替代方案

**宿主提供根覆盖（`sandbox/root` + `sandboxRoot`）。** 能约束 fork 的子级，但官方宿主既无事件也无能力，独立安装会静默放宽边界。仅保留为 fork 可用 seam，Flow 包不再使用。

**哈希校验或只读文件模式。** 这是检测而非强制；受限进程以同一用户运行，可以改回权限。

**把每个工作节点都改成 root 会话而不是 subagent 子级。** 这样可以去掉 carrier，但会失去 subagent 管理器的结果投递、委派策略以及脚本化节点行为的测试夹具；改动规模超过边界本身。

**通过自定义 subagent provider 把节点目录写进子级 header cwd。** 管理器用父会话构造子级 header，provider 只能提供 seed，无法改变沙箱根。

## 后果

工作节点与交互节点共享同一条无需宿主改动的边界规则。每个工作迭代新增一个隐藏的空 carrier 会话；它随子级处置，并作为 subagent 来源记录不进入侧栏。节点会话不是工作区成员，因此侧栏不列出它们；运行记录、进度卡与结果页用 id 定位。`workspace-write` 下平台临时区域仍可写，因此位于系统临时目录的工作区无法演示拒绝——验收通道使用 HOME 下的工作区。
