---
description: "Durable agent templates and validated flow-graph documents for deployments and maintainers composing canvas-authored fixed multi-agent workflows, with persisted runs and an executor seam."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-agent-flow

English | [中文](README.zh.md)

## Summary

`dsh-experimental-agent-flow` stores the fixed multi-agent workflows a user authors: agent templates defining a persona and a model route, plus validated flow documents that connect them into one directed graph. Saving a flow rejects the complete graph at once with every violation, and starting a run persists it before execution begins. It ships no execution engine of its own — a runtime package registers one, and without it starting a run fails loudly. It is published under its experimental name, carries no stability promise, and needs durable storage to activate.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Add this package to a composition when users author agent templates and fixed workflow graphs once, then start runs of them repeatedly with a different input message. It owns documents and run records only; a separate runtime package must register an executor for runs to execute.

Starting a run occupies the parent Session durably: the service records the Session and answers the session controller's usage seam, so New Session never reclaims that Session as a blank conversation, and the run's results stay with the Session's own history. Occupation survives restarts and outlives the run record.

### When to choose it

Choose it when the workflow itself is fixed data — nodes, condition routing words, and instructions authored ahead of time — rather than decided by the model at run time. Avoid it when the model should orchestrate freely; mount the `dsh-workflow` script engine instead. Both choices need the storage trio (`dsh-storage`, a backend, `dsh-storage-domain`) to activate.

### Minimal configuration

The shipped `dsh-base` bundle already composes the storage hub, the JSON backend, and the domain form, so the additive row is one entry:

```yaml
# agent flow documents and runs over the base storage trio
- name: '@deepseek-ai/dsh-experimental-agent-flow'
```

Every limit is optional and validated at startup:

| Field | Default | Meaning |
|---|---|---|
| `executor` | `'graph'` | Registry name `start` selects; a run fails loudly when unregistered. |
| `maxFlows` | `100` | Maximum saved flow documents. |
| `maxTemplates` | `100` | Maximum saved agent templates. |
| `maxRuns` | `1000` | Maximum persisted runs; oldest settled runs drop beyond it. |

The generated [configuration catalog](../../../docs/config-catalog.md) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The zod schemas in `src/spec.ts` validate templates, documents, and runs at storage. Every edge declares `execution` or `input`. Execution edges define reachability and scheduling; input edges reference results guaranteed available on the target path, and a connection is redundant only when every activation path already hands its result off. `src/graph.ts` analyzes the complete execution graph, and `src/validation.ts` accepts parallel DAGs and single-entry serial condition loops. It rejects unconditional cycles, parallel branching or merging inside a loop, unresolved references, and redundant result connections. Ordinary tasks with several execution predecessors use all semantics without requiring a join node. Saves report all structural problems together.

The service opens the per-record `agent_flow` storage domain. One mutation queue covers reference checks, count limits, writes, run admission, and settlement. Executor results remain owned until their terminal write succeeds; subsequent reads, cancellation, or shutdown can retry that write. Activation marks ownerless interrupted runs failed without executing them again. The registered executor receives durable node-update operations and cancellation; disposing its registration cancels and settles every run it still owns, and service unload then closes storage. A completed terminal write closes any node left pending by a failed skip write. `concludeConversation` asks the owning engine to finish an open clarification and reports `agent-flow/not-conversing` when none is open. Session occupation persists one `usage` row per parent Session and answers from an in-memory set rebuilt at activation, which also backfills the row for a parent proved only by its runs. The row outlives run eviction: before retention deletes the last run proving one Session, it writes that row, and a failed write keeps the run so a restart cannot lose the fact. A newly occupied Session is also reported to the seam's change feed, so live Session lists refresh it immediately.

| File | Owns |
|---|---|
| `src/index.ts` | Service, remotes, executor registry, run lifecycle |
| `src/spec.ts` | Zod record schemas, persisted types, domain declaration |
| `src/types.ts` | Branded ids, drafts, executor seam contracts |
| `src/validation.ts` / `src/graph.ts` | Graph validation and shared execution analysis |

No runtime invariant companion is published because the service owns no diverging observations: every record crosses one storage-domain schema, and the run lifecycle is asserted by the package suite.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-storage-domain](../../storage/storage-domain/README.md) — the domain form this package opens and its backend routing.
- [dsh-experimental-agent-team](../../experimental/agent-team/README.md) — the sibling experimental seam for cooperative agents without a fixed graph.
- [dsh-typert-protocol](../../typert/protocol/README.md) — the `@Remote` method and error vocabulary the remotes use.
- [Extension cookbook](../../../docs/cookbook/extension-cookbook.md) — maps features to capability seams and step-by-step guides.

-----

<a id="model-experience"></a>
## Model Experience

### Durable workflow documents

#### What the model sees

Nothing. The package registers no tools, injects no prompts, and appends no session events; templates, flows, and run records live behind `ctx.agentFlows` as storage-domain data, which reaches a model only if a future consumer renders it through its own documented surface.

#### Token effect

Zero: no text from this package enters any model request.

#### KV Cache effect

Independent: document and run reads and writes never touch request prefixes, so nothing here can invalidate provider cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what the package cannot do yet or where it needs special operational care. They are current package constraints, not a task backlog.

- **No execution engine ships here** — this package owns documents and runs; until a runtime package registers the configured executor, `start` rejects every request with `agent-flow/executor-missing`.
- **No model-facing trigger** — runs start host-side only; the model cannot invoke a flow, and no tool exists to read one.
- **No run authority beyond the parent session** — only a live Agent of the session that started a run may cancel it or end its clarification; other callers resolve the run as not-found.
- **Occupation answers only after activation** — between Host boot and this service's activation, session summaries report the parent Session as unoccupied.
- **Explicit conversion for legacy graphs** — missing edge kinds, `context.sources`, and `any` joins fail schema validation; activation refuses the domain and retains its records. Export and review the affected graphs before rewriting them with explicit execution and input edges.
- **Single-process change visibility** — `domain/changed` is in-process; a second host process observes no changes.
- **Experimental prototype with no stability promise** — the package is public, but its contracts can change freely while it incubates.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
