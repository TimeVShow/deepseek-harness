---
description: "用一个实验性 bundle 启用编写式固定多 Agent 工作流——流程文档、图运行时与 Web 画布面板。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-agent-flow-profile

[English](README.md) | 中文

## 概述

本 bundle 向 dsh profile 增加一层：保存 agent 模板、经校验流程文档与运行记录的 Agent Flow 服务；通过 profile 的 subagent provider 执行文档的图运行时；以及在画布上编辑图并启动运行的 Web 面板。已发布的 profile 都不包含它，因此只有添加该层后 profile 才获得固定工作流，移除它会同时撤回三行。该层只改变组合：它自身不注册面向模型的工具、提示词或会话事件。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 安装到 profile

把该层加入一个已初始化的 profile。在源码 checkout 中，按路径安装：

```sh
dsh plugin --profile web add /abs/path/to/packages/experimental/agent-flow-profile
dsh --profile web --dump-config
```

从已发布的包，按名称安装，并以同样方式移除：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-experimental-agent-flow-profile
dsh plugin --profile web remove @deepseek-ai/dsh-experimental-agent-flow-profile
```

profile 必须已包含 `@deepseek-ai/dsh-base`，本层消费它的存储三件套与 `spawn` subagent provider。两种形式都在本 checkout 上实测过：安装会把 bundle 链接进 profile 的依赖并列入 `dsh.profile.bundles`，随后 dump 会在该层标题下显示 `agent-flow`、`agent-flow-runtime` 与 `ui-agent-flow` 三行。

### 你将获得什么

该层增加三行。`agent-flow` 在 `ctx.agentFlows` 之后拥有模板、文档与运行；`agent-flow-runtime` 注册解释文档的 `graph` 执行器；`ui-agent-flow` 增加 **Agent Flow** 侧栏入口及其面板。在 Web 或 Desktop 的 Plugins 页启用该 bundle 以激活面板，即使 bundle 处于禁用状态，面板也会从本包 `package.json.icon` 声明读取其[图标](icon.svg)。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 —— 点击展开</summary>

本包的运行时内容就是它的 `dsh.bundle.patch` 文档：一个包含三行及其配置默认值的 `insert` 列表。因为 bundle 是插入行而非替换行，profile 自己的 patch 层仍可按 id 覆盖这三行中的任意一行，且这些行保留基础层的存储与 subagent 接线。服务行选择的执行器名必须与运行时行注册的名字一致；两者默认都是 `graph`。运行时行命名节点 agent 所用的 subagent provider，基础层将其注册为 `spawn`。

| 行 | 包 | 职责 |
|---|---|---|
| `agent-flow` | [`dsh-experimental-agent-flow`](../agent-flow/README.zh.md) | 模板、经校验文档、运行记录、执行器注册表 |
| `agent-flow-runtime` | [`dsh-experimental-agent-flow-runtime`](../agent-flow-runtime/README.zh.md) | 图调度与节点 agent 委派 |
| `ui-agent-flow` | [`dsh-experimental-client-ui-agent-flow`](../client-ui-agent-flow/README.zh.md) | 画布面板、模板表单、运行控制 |

不发布运行时 invariant 伴随包，因为本 bundle 只携带 patch 文档，没有运行时代码。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Profile 与 bundle](../../../docs/architecture.zh.md#profiles-and-bundles)——层如何叠加、patch 如何定位某一行。
- [dsh-experimental-agent-flow](../agent-flow/README.zh.md)——服务及其校验规则。
- [dsh-experimental-agent-flow-runtime](../agent-flow-runtime/README.zh.md)——调度、汇聚与失败语义。
- [Agent Flow 子系统](../../../docs/subsystems/agent-flow.zh.md)——flow 类型与执行器接缝。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本 bundle 自身不注册面向模型的贡献。

#### KV Cache 影响

无直接影响；一次运行产生的任何模型可见使用都由运行时的节点 agent 拥有。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制描述该层目前做不到或需要特殊运维注意的地方。它们是当前包约束，不是任务 backlog。

- **无模型侧触发**——bundle 不添加工具，因此运行只能从面板或宿主代码启动。
- **执行器与运行时名称必须一致**——服务的 `executor` 值与运行时的注册名是两个独立配置字段。
- **所有节点 agent 共用一个 provider**——运行时行的 `provider` 适用于全部节点；按节点选择 provider 需要该层尚未暴露的模板级覆盖。
- **无稳定性承诺的实验原型**——本 bundle 公开发布，但契约在孵化期内可自由变更。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

None.

</details>