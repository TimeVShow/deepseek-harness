# Agent Note: Give Agent Flow its own service seam over storage-domain

Status: implemented

English | [中文](2026-09-24-agent-flow-plugin-seams.zh.md)

## Problem

Users need fixed multi-agent workflows: agent types they author once, wired into a flowchart-style graph whose routing they control, executed repeatedly with different inputs. The harness already provides the agent base (the subagent seam composes children with persona, model route, tool scoping, and output schema), and it provides a workflow engine — but that engine executes model-authored JavaScript orchestration scripts, not user-authored graph data, and one context can load only one `WorkflowEngine` provider. The choice of where the new capability attaches must not modify the agent base, displace the script engine, or imply a stability promise while the surface incubates.

## Decision

`packages/experimental/agent-flow` owns the durable data and the orchestration lifecycle under the service key `ctx.agentFlows`, as a `TypertRemoteService` with CRUD remotes for templates, flow documents, and runs. The complete seam has three roles:

- **Service Definition** — this package. It validates the complete execution graph, explicit input references, and template references, accepting parallel DAGs and serial condition loops while rejecting unsupported combinations. The [subsystem reference](../../../../docs/subsystems/agent-flow.md) owns the graph vocabulary.
- **Provider** — `packages/experimental/agent-flow-runtime` registers the `graph` interpreter through `registerExecutor(executor)`; the `executor` config selects it. Documents and runs stay independent of the engine, and `start` fails loudly with `agent-flow/executor-missing` until a provider mounts.
- **Consumer** — `packages/experimental/client-ui-agent-flow` edits documents on a canvas, edits templates, and starts or cancels runs through the remotes; the runtime reads templates through the same namespace and persists every node outcome through the run controller. Its progress card adds live activity from the Sessions those executions open: the client retains only the Sessions of running or conversing node executions, folds their ordered Session event feed into a stage, a business timestamp, and the open tool calls without copying message text, and releases each one when its execution or run settles. The waiting decision reads the record's `conversing` state together with that live state, so a node working on a reply is not reported as waiting for the user. A model-facing tool has not shipped.

Records persist in one per-record `agent_flow` storage-domain unit. One service queue serializes reference checks, limits, writes, run admission, and settlement. A run binds the document snapshot taken at start and persists before execution. Terminal-write failure retains its outcome for a later reconciliation; activation marks interrupted ownerless runs failed without rerunning them. Fiber unload aborts work, awaits settlement writes, and closes the unit in one sequenced effect because independent effect disposers run concurrently.

Agent templates supply `persona`, `provider`, and `model` overrides through the runtime. The document service does not import the subagent provider. Runs carry `parentSessionId`, and only a live Agent of that Session may cancel or conclude the run.

Run detail lives in the storage domain. The document service registers no model-facing tool or Session event; the runtime submits task prompts through normal Agent APIs, so node Sessions log the exact model-visible inputs. No `SessionEventMap` or SDK format change is required. The browser panel mounts the generated Remote contribution itself, and `packages/experimental/agent-flow-profile` composes all three rows as an opt-in bundle.

## Testing

The package suite covers CRUD races with storage gates, count and reference guards, explicit graph validation, run ownership, cancellation, retention, terminal-write failures, and interrupted activation. The runtime suite observes node prompts, exact source executions, all-predecessor scheduling, conditional exclusions, serial review iterations, sibling cancellation, and retained completed records at the execution cap. The client suite covers bounded cyclic layout and execution/input line editing. A real AgentLoop lifecycle suite covers ordinary cancellation, a controller failure after opening, a queued conclude on normal completion, and provider unload; every terminal write waits for the live turn and tool to reach quiescence. Runtime and client suites also cover a failed iteration append, a failed skip write, refresh ordering, slow-refresh coalescing, executor admission versus unregistration, form identity adoption, interactive message sources, and explicit entry-agent selection. The live-activity chain is pinned keylessly end to end: ordered Session events enter the shared client feed, the tracker folds them, the controller publishes the observation, and the rendered card shows the stage — covering reasoning that outlasts the stall threshold, a submitted reply that has not landed, a question asked inside an open turn, and the release that follows settlement.

## Alternatives considered

**Implement a second `WorkflowEngine` provider.** The workflow seam admits one provider per context; loading a graph interpreter would displace `workflow-ptc`, changing existing behavior the constraint forbids. The script model also has no place to hold user-authored graph documents.

**Extend Agent Teams.** Teams coordinate free-form cooperation through a live roster and task board inside one session; a fixed authored graph is different data with different durability needs, and coupling them would force one stability track.

**Author flows as preset or bundle YAML.** Presets are deployment configuration composed by the Loader, read-only in the Web client; user-authored documents need runtime CRUD over durable storage, which is the storage-domain's contract.

**Journal runs as session events.** That is the right shape when runs are model-visible or must replay from the log. With no model-facing surface, it would cost `SessionEventMap` and TypeScript/Python SDK dual updates for data the storage domain already owns. A later model-facing trigger adds events in that milestone, not retroactively here.

## Consequences

The executor is swappable without changing document ownership, and the Web UI consumes remotes independently of the provider. Run detail is read from storage rather than reconstructed from the Session log. Legacy graphs require explicit conversion when they fail the active schema; original records remain on disk. Cancellation authority stays with the parent Session. This experimental API has no stability promise.
