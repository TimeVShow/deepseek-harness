# Agent Note: Agent Flow entry nodes read the run request by default

Status: implemented

English | [中文](2026-11-08-agent-flow-entry-input-default.zh.md)

## Problem

A run's original request previously reached only nodes with an explicit Start input edge. A flow whose Start executed the first agent directly therefore opened that agent — including an interactive conversation — without the message the user sent to start the run. Requiring a separate input line for the entry consumed user attention and produced silent runs that looked misconfigured.

## Decision

`GraphExecutor.readsUserInput` treats every direct execution successor of the Start node as an entry node and gives it the run's original request by default. An explicit Start input edge still adds the request to any other node. The resolved fact is recorded in the run's `userInput` field. Input edges remain non-scheduling references; save-time validation and scheduling are unchanged.

The editor's missing-input warning and the composer claim warning are removed because the condition no longer exists. Explicit Start input edges remain available for non-entry nodes. The default applies to every direct Start successor, including parallel entry branches.

## Verification

`packages/experimental/agent-flow-runtime/tests/graph.spec.ts` asserts that the entry node receives the request while later nodes do not, and that an interactive entry opens with the request without an explicit input edge. `packages/experimental/agent-flow-runtime/tests/full-chain.host.spec.ts` covers the same rule through the generated Remote composition. The Web L1 lane still covers entry flows with explicit input lines.

## Alternatives considered

**Keep the explicit input line as the only source.** This preserves the original rule but makes the common case require graph editing for no product benefit; users already supplied the input when starting the run.

**Inject the request into every node.** That would leak the request into downstream tasks and contradict the rule that a task outputs only its own result and explicit references.

**Auto-add an input edge when starting a run.** That would mutate or branch the saved document and make the graph disagree with its snapshot; the runtime can supply the request without changing the document.

## Consequences

Every flow now starts with its request visible to the entry task, including the interactive entry. Non-entry nodes still need an explicit Start input edge to read the request. The rule reverses the earlier explicit-input default; the editor no longer warns about a missing entry input line.
