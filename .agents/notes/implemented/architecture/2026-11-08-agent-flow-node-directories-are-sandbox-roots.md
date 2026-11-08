# Agent Note: Agent Flow node directories are sandbox roots

Status: implemented

English | [中文](2026-11-08-agent-flow-node-directories-are-sandbox-roots.zh.md)

## Problem

A run's nodes worked in their own iteration directories under `.dsh/flows/<run>/<iteration>-<node>`, but their file-effect boundary was the parent workspace: a worker child inherited the parent Session header cwd, and the interactive conversation recorded the workspace too. A downstream node could therefore overwrite, delete, rename, or replace an upstream deliverable through the file tools or any subprocess, including a same-byte write. Prompt guidance and end-of-run hash checks cannot make that read-only.

## Decision

Sandbox policy gains a per-session `sandbox/root` override beside `sandbox/mode`. `SandboxPolicyService.setRoot` appends the event, the `sandboxRoot` projection folds it, and `resolve()` uses the last override before the immutable header cwd. The event is log-only, survives restart by replay, and leaves the header cwd as the Session's workspace identity, so workspace membership and Session listing are unchanged.

`SubagentStartRequest.sandboxRoot` carries the same boundary into an in-process child. The manager writes it before the first request, and a backend that cannot honor it (any out-of-process one) refuses the request through the `sandboxRoot` capability instead of silently widening it. Delegation also inherits the parent's override under `source: 'delegation'`, so a node's own children cannot escape its directory.

The runtime scopes every agent node to its iteration directory. A worker passes that directory as `request.sandboxRoot`; an interactive conversation records the workspace as its header cwd but sets the node directory as its working directory and sandbox root. Both apply only when the deployment mounts sandbox policy; without it there are no confined writes to narrow.

## Verification

`packages/sandbox/sandbox-policy/tests/policy.spec.ts` covers resolution precedence, replay, and rejection of a relative root. `packages/subagent/subagent/tests/sandbox-root.spec.ts` covers the child event, delegation inheritance, the unsupported-backend refusal, and the missing-service failure. `packages/experimental/agent-flow-runtime/tests/graph.spec.ts` asserts the worker `sandboxRoot` and the interactive conversation's working directory and resolved root. `apps/web/tests/agent-flow-l1-identity.e2e.ts` E26 runs a real Bash overwrite attempt from a downstream node in the shipped Web composition: the upstream file keeps its bytes and the tool result records the denial.

## Alternatives considered

**Check hashes after the run.** Detection, not enforcement; the overwritten file has already replaced the upstream deliverable.

**Make delivered files read-only on disk.** The sandboxed process runs as the same user and can restore the mode, and the grant covers the parent workspace anyway.

**Record the node directory as the child Session header cwd.** This narrows the boundary because sandbox policy already reads the header, but it breaks workspace attachment and bootstrap grouping: a Session whose canonical cwd differs from the workspace path cannot be a member.

**Treat the Session working directory as the boundary.** A `cd` would then change permissions, including widening them when the new directory lies outside the workspace.

## Consequences

Worker and interactive nodes now share one boundary rule, and upstream deliverables stay readable but unwritable. The `sandbox/root` event is required on read, so a build without it refuses to resume such a Session rather than silently widening the boundary; this is a host addition that the fork release must list. Platform temporary areas remain writable under `workspace-write`, so a workspace itself residing in the system temp directory cannot demonstrate the denial — the Web acceptance lane uses a HOME-based workspace. A deployment that does not mount sandbox policy keeps its existing behavior: nodes are not confined.
