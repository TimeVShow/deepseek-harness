---
description: "Registers the Agent Flow graph interpreter: schedules validated flow documents node by node, runs each worker node through a configured subagent provider, and opens a root Session for the node that clarifies the request with the user."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-agent-flow-runtime

English | [中文](README.zh.md)

## Summary

`dsh-experimental-agent-flow-runtime` turns saved flow documents into running agents: it schedules the graph node by node, routes a `condition` node on the `Result: <word>` line of the agent feeding it, and waits at joins. A worker node runs once as a subagent child; the node marked `interactive` instead opens a root Session the user joins and stays `conversing` between turns until one closes with its Result word. Parallel node agents stay within a concurrency bound, and `maxIterations` bounds total agent executions. Each node outcome lands in the durable run record. Published experimentally, with no stability promise.

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

Mount this package beside `dsh-experimental-agent-flow` and a subagent provider, then start runs through `ctx.agentFlows`; this package supplies the executor those runs need.

### When to choose it

Choose it when workflows are authored ahead of time as documents and must run the same way each time. Avoid it when the model should orchestrate freely per request; mount the `dsh-workflow` script engine instead. The runtime needs a subagent provider for its worker nodes, so mount one whose name matches this package's `provider` config, and it needs `agents` plus `agentDefaultModel` for the node that talks to the user.

### Minimal configuration

`dsh-base` already composes a subagent provider under the name `spawn`, an agent factory, and a default model selection, so the additive rows are the Agent Flow service and this runtime:

```yaml
# agent flow documents, runs, and the graph interpreter over the base subagent provider
- name: '@deepseek-ai/dsh-experimental-agent-flow'
- name: '@deepseek-ai/dsh-experimental-agent-flow-runtime'
```

Every value is configurable; `executor` must match the service's own `executor` value:

| Field | Default | Meaning |
|---|---|---|
| `executor` | `'graph'` | Registry name to register under; the service's `executor` config selects it. |
| `provider` | `'spawn'` | Subagent provider name each worker node starts on. |
| `maxConcurrentAgents` | `4` | Maximum node agents running at the same time. |
| `maxConversationTurns` | `16` | Maximum turns one interactive node may take before its run fails. |

The generated [configuration catalog](../../../docs/config-catalog.md) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

A failed iteration-record append fails the run at run level and leaves the previous execution's record in place. Unloading the runtime cancels and settles every run it still owns before its registration is released. Every node waits for all effective execution predecessors and requires at least one actual arrival. Unselected conditional branches are excluded; input edges never activate work. A condition chooses one route and transparently transfers its incoming task result. An all join merges the completed branch results with their source identities. A serial loop consumes fresh internal arrivals each round, retains completed external dependencies, and receives the just-completed review at its return entry. Loop exits remain unresolved while the loop continues, so an outside merge cannot run early. Completion requires a successful end and no unresolved effective work.

`agent` nodes acquire a concurrency slot, resolve their execution handoffs and required input references, record the exact source node executions, then read the template and assemble the prompt. A Start execution successor (an entry node) reads the run's original request by default; an explicit input edge from start adds it to any other node. Each task outputs only its final explanation and artifact paths. Worker nodes use `ctx.subagents.startActivation` and dispose their child after settlement. An interactive node opens an ordinary root Session through `ctx.agents.create`, with its template persona in the opening prompt and route overrides applied to the parent composition. The opening turn logs runtime rules as `agent-flow` context and the original request as its human message. A cancellation raised from inside those insertions — for example by a synchronous `agent/inbox/inserted` listener — keeps the remaining message out of the inbox, so no turn starts after it and the run settles `cancelled` without an outside cancellation of the live Agent. Its settled conversation stays readable and has a process-local `agent/pre-step` lock against further human prompts.

The final assistant text, files, and Session id are persisted per task execution. An agent feeding a condition must end with a valid `Result: <word>`; an interactive node without a condition uses `done`. A turn without a Result leaves an interactive node `conversing` until the human replies or the turn budget expires. The prompt asks for user agreement, but runtime completion depends on the Result line; this is not an enforced human authorization state. `concludeConversation` submits one closing instruction and consumes its registration. Model failure, node failure, and caller cancellation stop remaining work and record unreached nodes as skipped. Every interactive exit — Result, failure, or cancellation — cancels remaining runtime-owned turns and waits for its live Session to reach quiescence, so the run never publishes a terminal status while an owned turn or tool still runs.

| File | Owns |
|---|---|
| `src/index.ts` | The function plugin: config validation and executor registration |
| `src/executor.ts` | Graph scheduling, node delegation, run settlement |
| `src/conversation.ts` | The interactive node's root Session: creation, publication, turn observation |
| `src/prompt.ts` | Fixed prompt assembly and Result-line parsing |

No runtime invariant companion is published because the interpreter owns no durable stream of its own; it reads and writes records that the Agent Flow service validates.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-experimental-agent-flow](../agent-flow/README.md) — the documents, templates, and run records this executor drives.
- [Agent Flow subsystem](../../../docs/subsystems/agent-flow.md) — the flow types and the executor seam contract.
- [Subagent subsystem](../../../docs/subsystems/subagent.md) — the delegation seam each node agent starts on.
- [dsh-workflow](../../workflow/workflow/README.md) — the script engine for model-authored orchestration.

-----

<a id="model-experience"></a>
## Model Experience

### Worker node delegation

#### What the model sees

Nothing in the session that started the run. Each worker `agent` node delivers its assembled prompt as a fresh user message to its own child agent, composed with that node's template persona and route; the child's final text returns to the run record, never to the starting session's conversation.

#### Token effect

The parent session gains no tokens from a run. Every assembled node prompt, tool interaction, and child output consumes tokens inside that node's own child session.

#### KV Cache effect

Independent of the parent: the runtime never touches the starting session's request prefixes, so provider cache reuse there is unaffected. Each child session builds its own prefix from the node prompt and its template's persona.

### Interactive node conversation

#### What the model sees

One ordinary root Session of its own, joined to the run's parent composition, so it sees that composition's system prompt with the template's persona folded into the opening user message instead of a persona section. Every later user message in that Session is the human's own reply, delivered by the product's composer rather than by this runtime.

#### Token effect

The parent session gains no tokens. The conversation's turns accumulate in the interactive Session like any human conversation: each reply re-sends the whole prefix, so a long clarification grows quadratically in billed tokens.

#### KV Cache effect

Ordinary append-only growth in the interactive Session, so provider prefix caching applies turn over turn. The starting session's prefixes are untouched.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what the runtime cannot do yet or where it needs special operational care. They are current package constraints, not a task backlog.

- **Host-side start** — this runtime exposes no model-facing trigger; a Host integration such as the Agent Flow canvas starts runs.
- **Templates are read when a node starts** — editing a template changes nodes that have not begun yet; a run pins its graph, not its templates.
- **Routing is exact-match on the final line** — an agent feeding a condition node whose final message lacks a `Result: <word>` line, or prints a word outside that node's vocabulary, fails the node and with it the run.
- **The first node failure fails the run** — there is no failure-routing edge, retry policy, or resume; interrupted runs settle and are not restartable from the first failed node.
- **Supported graph subset** — parallel DAGs and serial condition loops are supported; `any` and parallel branching or merging inside a loop are rejected.
- **Local artifact paths** — artifact discovery reads the Host filesystem; a remote execution environment needs a separate file-reference design.
- **The lock does not survive a restart** — it is process state over a live agent scope, so a resumed conversation Session is writable again while the run records that concluded it stay durable.
- **Experimental prototype with no stability promise** — the package is public, but its contracts can change freely while it incubates.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
