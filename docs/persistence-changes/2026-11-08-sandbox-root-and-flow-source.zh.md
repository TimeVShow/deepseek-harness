---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-08-sandbox-root-and-flow-source

[English](2026-11-08-sandbox-root-and-flow-source.md) | 中文

## 概述

新增 sandbox/root 会话事件与 agent-flow 消息来源。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-08-sandbox-root-and-flow-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "b29787abd31999b49045aada1e41d98e31f64fa8d04a25408d2e618230f306b5"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "68ba7a9a5cc76e29ce70756778d21bfd8e0cf5b9142795f7e8b570f951a80b4d"
    decision: same-version
  - root: "event:sandbox/root"
    previous: null
    after: "226871117618d52878d4c45da2a7d460caec83061a8191e5b63c7059c63af141"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "b012e3f16b75ea8c5992d8279c34a397bc8805269a9fff1f8e5e09cdaa0b3ccc"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "5b526a11392ef8da66929a5f889e653a27655b9fd89068fd5d9dda2846937f33"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录保持有效：两项新增都不改写既有表示。sandbox/root 是新的仅日志事件，用于收窄会话的 workspace-write 边界；读取方必须识别它，未识别的构建会拒绝恢复该会话，而不会静默放宽边界，本构建从日志重放该事件。agent-flow 来源是可合并扩展的消息来源映射的新变体，仅由实验性 Flow 运行时写入；历史投影把一切非 user 来源视为运行时注入上下文，因此不认识该变体的读取方仍会重建相同的对话。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/sandbox/sandbox-policy/tests packages/subagent/subagent/tests：sandbox-policy 30 个测试、subagent 5 个 sandbox-root 测试通过；pnpm exec vitest run packages/experimental/agent-flow-runtime/tests：83 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
