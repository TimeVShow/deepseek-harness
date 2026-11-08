---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-08-sandbox-root-and-flow-source

English | [中文](2026-11-08-sandbox-root-and-flow-source.zh.md)

## Summary

Adds the sandbox/root session event and the agent-flow message source kind.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing records remain valid: neither addition rewrites an existing representation. sandbox/root is a new log-only event that changes a session's workspace-write boundary; it is required on read, so a build without it refuses to resume that session instead of silently widening the boundary, and this build replays it from the log. The agent-flow source kind is a new variant of the merge-extensible message-source map written only by the experimental flow runtime; history projection treats every non-user source as runtime-injected context, so a reader that does not know the variant still reconstructs the same conversation.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/sandbox/sandbox-policy/tests packages/subagent/subagent/tests: sandbox-policy 30 tests and subagent 5 sandbox-root tests passed; pnpm exec vitest run packages/experimental/agent-flow-runtime/tests: 83 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
