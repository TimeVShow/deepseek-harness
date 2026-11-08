# Agent Note: Agent Flow node directories are sandbox roots

Status: implemented

English | [中文](2026-11-08-agent-flow-node-directories-are-sandbox-roots.zh.md)

## Problem

A run's nodes worked in their own iteration directories under `.dsh/flows/<run>/<iteration>-<node>`, but the sandbox root on the official host is the Session's immutable header cwd. Worker children inherited the flow Session's header cwd, and an interactive conversation recorded the workspace, so a downstream node could overwrite, delete, rename, or replace an upstream deliverable through the file tools or any subprocess. The first fix narrowed the root through new host interfaces (`sandbox/root` and `sandboxRoot`); the official host does not ship them, so a standalone plugin install could not enforce the boundary.

## Decision

Every node Session's immutable header cwd is its iteration directory, which the host's existing sandbox policy already uses as the `workspace-write` root:

- A worker runs under a per-node **carrier Session** created with `meta.cwd = <iteration dir>`. The carrier composes the run parent's preset and route, starts the existing subagent child, and is disposed with the child; the child inherits the carrier's header cwd, so its file tools and subprocesses are rooted at the iteration directory, and its own delegated children inherit the same root.
- An interactive conversation records the iteration directory as its own header cwd. It joins the workspace only when its directory is the workspace root; a node directory cannot be a workspace member, and the run record addresses the Session by id.

The flow packages no longer call `sandboxPolicy.setRoot` or pass `request.sandboxRoot`. Those host additions remain available to other consumers in the fork, but the Agent Flow path needs no host modification, so the four packages install onto the official `0.2.2-rc.1` host unchanged.

## Verification

`packages/experimental/agent-flow-runtime/tests/graph.spec.ts` asserts the carrier's `cwd`/`origin`/`parentSession`/`delegationDepth`, the interactive conversation's header cwd, and the child request directory. `apps/web/tests/agent-flow-l1-identity.e2e.ts` E26/E27 drive six real Bash writes from a worker and an interactive node in the shipped Web composition: the Session header cwd is the node directory, every tool result reports `STEP-DENIED`, and the upstream file keeps its bytes.

On the official host, the four candidate tarballs installed into a fresh `0.2.2-rc.1` profile with the official `subagent` and `sandbox-policy`. A seeded writer→checker flow and an interactive entry flow each recorded their node Session header cwd as the iteration directory and six denied writes (`STEP-DENIED`); `original.txt` and `upstream.txt` stayed intact. The official child inherits `cwd: parentHeader.cwd`, which is what makes the carrier sufficient.

## Alternatives considered

**Host-provided root override (`sandbox/root` + `sandboxRoot`).** It confines the fork's children, but the official host has neither event nor capability, so a standalone install silently widens the boundary. Kept only as an available fork seam, not used by the flow packages.

**Hash checks or read-only file modes.** Detection, not enforcement; the sandboxed process runs as the same user and can restore modes.

**Run every worker as a root Session instead of a subagent child.** It removes the carrier, but loses the subagent manager's result delivery, delegation policies, and the test fixtures that script node behavior; the rewrite is larger than the boundary needs.

**Record the node directory as the child header cwd through a custom subagent provider.** The manager builds the child header from the parent; providers can only supply a seed, so this cannot change the sandbox root.

## Consequences

Worker and interactive nodes share one boundary rule that needs no host change. Each worker adds one hidden, empty carrier Session per iteration; it is disposed with the child and stays out of the sidebar as a subagent-origin record. Node Sessions are not workspace members, so the workspace sidebar does not list them; the run record, progress card, and results page address them by id. Platform temporary areas remain writable under `workspace-write`, so a workspace itself residing in the system temp directory cannot demonstrate the denial — the acceptance lanes use a HOME-based workspace.
