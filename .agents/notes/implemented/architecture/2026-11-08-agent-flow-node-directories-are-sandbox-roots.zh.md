# Agent Note：Agent Flow 节点目录即沙箱根

状态：已实施

[English](2026-11-08-agent-flow-node-directories-are-sandbox-roots.md) | 中文

## 问题

运行的各节点在 `.dsh/flows/<run>/<iteration>-<node>` 下自己的迭代目录中工作，但文件操作边界是父工作区：工作节点继承了父会话的 header cwd，交互对话也记录工作区。下游节点因此可以通过文件工具或任意子进程覆盖、删除、重命名或替换上游交付物，包括同字节写入。提示词引导和运行后的哈希校验都无法保证只读。

## 决策

sandbox policy 在 `sandbox/mode` 之外新增逐会话的 `sandbox/root` 覆盖。`SandboxPolicyService.setRoot` 追加该事件，`sandboxRoot` 投影折叠它，`resolve()` 在不可变 header cwd 之前采用最后一次覆盖。事件仅进入日志，通过回放跨重启保留，并保留 header cwd 作为会话的工作区标识，因此工作区成员关系与会话列表不变。

`SubagentStartRequest.sandboxRoot` 把同一界限传给进程内子级。管理器在首次请求前写入它；无法履行的后端（任何进程外后端）会通过 `sandboxRoot` 能力拒绝请求，而不是静默放宽。委派还会以 `source: 'delegation'` 继承父级覆盖，因此节点自己派生的子级无法逃出它的目录。

运行时把每个 agent 节点限定在其迭代目录内。工作节点把该目录作为 `request.sandboxRoot` 传入；交互对话把工作区记录为 header cwd，但把节点目录设为工作目录与沙箱根。两者都只在部署挂载 sandbox policy 时生效；没有它就没有可收窄的受限写入。

## 验证

`packages/sandbox/sandbox-policy/tests/policy.spec.ts` 覆盖解析优先级、回放以及相对根目录的拒绝。`packages/subagent/subagent/tests/sandbox-root.spec.ts` 覆盖子级事件、委派继承、不支持后端时的拒绝以及缺少服务时的失败。`packages/experimental/agent-flow-runtime/tests/graph.spec.ts` 断言工作节点的 `sandboxRoot` 以及交互对话的工作目录和解析出的根。`apps/web/tests/agent-flow-l1-identity.e2e.ts` 的 E26 在交付版 Web 组合中由下游节点发起真实 Bash 覆盖尝试：上游文件保持原字节，工具结果记录拒绝。

## 考虑的替代方案

**运行后校验哈希。** 这是检测而非强制；被覆盖的文件已经替换了上游交付物。

**把交付文件设为磁盘只读。** 受限进程以同一用户运行，可以改回权限，而且授权本来就覆盖父工作区。

**把节点目录记录为子会话 header cwd。** 由于 sandbox policy 已读取 header，这会收窄边界，但会破坏工作区挂载与 bootstrap 分组：canonical cwd 与工作区路径不同的会话无法成为成员。

**把会话工作目录当作边界。** 这样 `cd` 会改变权限，包括在新目录位于工作区之外时放宽权限。

## 后果

工作节点与交互节点现在共享同一条界限规则，上游交付物可读但不可写。`sandbox/root` 事件在读取时是必需的，因此不认识它的构建会拒绝恢复该会话，而不是静默放宽边界；这是 fork 发布必须列出的宿主新增项。`workspace-write` 下平台临时区域仍可写，因此位于系统临时目录中的工作区无法演示拒绝——Web 验收通道改用 HOME 下的工作区。未挂载 sandbox policy 的部署保持原有行为：节点不受限制。
