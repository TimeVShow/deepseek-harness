---
description: "Use and debug the experimental Web Agent Flow panel: flow list and graph canvas, agent forms, a chat-record run view with file links and cancellation, the session composer's workflow selector and flow-progress card, and the node that clarifies the request with the user."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-agent-flow

English | [中文](README.zh.md)

## Summary

This package adds an **Agent Flow** sidebar entry opening a panel for authoring multi-agent workflows and watching their runs, plus a composer workflow selector. A user edits flow graphs and their agents on the canvas, marks the one node that clarifies the request with them, and opens each run as a chat record: one message per node execution with its status, handoff, files, and conversation. Picking a flow claims the next message as that run's input, then follows the run into its conversation. Reads and writes go through the `agentFlows` Remote namespace it mounts itself.

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

Enable this package through [`@deepseek-ai/dsh-experimental-agent-flow-profile`](../agent-flow-profile/README.md), which supplies the flow service, the graph runtime, and this panel together. The Web Client loader mounts the `/client` export; the root Host export is inert. The panel reads one optional configuration field: `stallNoticeMs` (default 600000, range 5000–86400000) is how long a running run's progress card may show no new business signal — no recorded transition and no event from the node Sessions this client observes — before it notes the quiet period; the card never fails, retries, or cancels a run on its own.

### Author a flow and watch its runs
1. Open **Agent Flow** from the sidebar and choose **New flow**, which scaffolds a starter agent template and a `start → step → end` graph.
2. Drag nodes to move them and drag between their handles to connect them. New connections default to **Execution**: solid arrows decide order and pass the source's result. A task with multiple execution predecessors waits for every branch; it does not need an extra join node. An execution connection from **start** starts the task; an entry task also receives the run's original request by default.
3. Click a connection to choose **Execution** or **Input** in its inspector. Dashed **Input** arrows reference an existing result without starting the target or adding a wait. Inputs can reference a task, condition, or join; they target tasks only. To include the original user request in a non-entry task, connect **start** to it as an **Input** connection; entry tasks already receive it by default. Each start-to-task pair can carry one of each type; other pairs carry one connection. The node's **Input sources** summary shows the selected sources; unconnected ancestors never contribute their full context.
4. Tick **Talks with the user** on the one node that clarifies the request before handing off. Its card carries a **Conversational** mark, ticking another node moves the mark, and the Host rejects a flow whose conversational node has no execution connection directly from **start**.
5. Add a **condition** node to branch. It reads the `Result: <word>` line of the one agent feeding it and activates only the outgoing execution edge whose word matches, so every one of those edges carries a word. It produces nothing itself and forwards that agent's handoff, so a route back into a loop still carries the verdict that chose it.
6. Save. The Host validates the whole graph and the panel lists every problem it found.
7. Switch to **Runs** and open a run. The page leads with the result rather than the transcript: the run's status, start and duration, the current node while it executes, and how many files it produced; the original request stays folded until asked for. One result card per work node follows, showing its latest round, status, result mark, and final summary rendered as Markdown (a long summary starts collapsed). A file link inside a summary opens the right sidebar's preview: a relative destination resolves against that round's working directory, and a `#L24` fragment reveals the line; while the panel is on screen the main area first switches to the run's conversation, whose sidebar the preview opens in. Condition nodes never appear as cards or status-line entries — they are execution control, not deliverables — though a failed condition still names the failed step in the overview. A node's produced files are compact rows — name, project-relative path, **Preview** through the right sidebar, and **Copy path** for the absolute address — with documents and project entries first, at most six before **View all files**, and dependency, environment, and cache directories such as `.venv` or `node_modules` behind their own switch; the switch recognizes Windows drive and UNC addresses the same way, and opening or copying always uses the recorded address unchanged. Earlier rounds of a reworked node sit behind **earlier rounds**; **View execution** opens the node's child session. A completed run never claims a review passed: only the record's status and the nodes' own result marks are shown. While a conversational node waits for the user the whole run reads as **Clarifying** rather than running, and the node itself reads **Conversing**, says so, opens the conversation rather than a child session, and offers **End the clarification** for a dialogue that will not converge — it asks that node to stop asking and state its Result word, leaving the run executing. Once the node settles, its session's composer goes inert with the reason as its placeholder. The list polls while any run is in flight, and a running run can be cancelled while its parent session is live.

### Start a run from the composer

The session composer's tool row carries a **Workflow** selector. Picking a flow claims the composer with a localized `flow:<name> ` token; the message submitted after it starts a run of that flow, bound to the current session, with the message text as the run's input. Once that run's conversational node opens its session, the client moves the user into it, so the clarification continues where the flow put it; a run this client did not start never moves the user. An empty input refuses to start. Deleting the token from the draft exits the selection, exactly like choosing **No workflow** in the menu. While a run is in flight for the session, the selector shows a live indicator whose menu entry opens the panel's **Runs** tab. The roster refreshes each time the menu opens, and with no flows the menu points at panel creation instead.

### Track a run above the composer

Every session a run involves — the one that started it and every session one of its node executions opened — keeps a **flow-progress** card above the composer until the run settles, so a user moved into a node's conversation still sees the run and can reach it after a reload. The card combines the durable run records with the live activity of the node Sessions this client observes. It shows the phase (running, waiting for your reply, completed, failed, cancelled), the elapsed time, one line per node execution that is live or immediately startable with its round number, and a status word: a live node reads its actual stage — preparing, waiting for the response, reasoning, writing, running tools — with the age of its newest signal, a blocked node names what it waits on, and a node this client cannot observe reads its recorded status. When several runs involve the session, a picker in the card chooses which one to show instead of taking one at random. **View current node** opens the conversing node's session, or the live node's session when none converses, and reads **View the reasoning** while that node is reasoning; the session it opens is the ordinary conversation, where the reasoning disclosure the chat already owns is collapsed until the reader opens it. Each node line with a session of its own carries a **Details** entry for that node, so parallel nodes and earlier rounds stay reachable without taking the picker away from the run. **View full flow** opens the run record in the panel. **Cancel** appears only while the run is running and its parent session still has a live agent; it states its outcome through the run's own recorded status, never a claimed cancellation. The card waits for the user only when the run's conversational node is genuinely idle: while that Session is working on a reply, or a submitted message has not landed, the card reads as running and its node line shows the stage the stream reports. Only a node that is still executing is judged: one with no business signal for `stallNoticeMs` is named in the notice, node by node, so a busy branch cannot hide a quiet one. A settled execution keeps its last observation for reading but never raises the notice, a reasoning or tool stream that keeps arriving never raises it, a node the run waits on is idle by design, and a node whose own follow stream failed reads as disconnected rather than as quiet. The notice appears only while the run itself is executing. While a roster read fails, the card marks itself as last-known state and keeps the previous lists; the mark clears on the next successful read.

### Manage agents

The **Agents** tab lists every agent with the number of flows referencing it, and when none exist it prompts to create the first one. An agent holds a persona and a model route. The model is picked from a dropdown of the system's configured models — no free text — and saving requires a choice; a saved route that later leaves the catalog stays selectable, so editing never rewrites it. A node's agent is fully determined by its template plus the node's instruction, and the Host reads the template when the node starts.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`mount.ts` mounts this package's generated Remote contribution and then registers four surfaces through `ctx.slots.inject`: a keyed `main` panel entry, its `sidebar.panellist` entry, the composer's `conversation.input.left` workflow selector, and the composer's `conversation.input.dock` flow-progress card. Which sessions the card and the selector's in-flight flag address is one rule in `run-view.ts`: a run involves its parent session and every session a node execution recorded as its agent session, and every recorded fact the card shows — phase, node lines, last transition, the block reason for a concluded conversation — derives from the run record through that module. A second, independent source feeds the card's live half: `activity-tracker.ts` retains exactly the sessions of node executions the roster reports as running or conversing, folds their ordered event feed through `activity.ts` into a stage, a business timestamp, the open tool calls, and the user-facing live state, and publishes that observation into the controller's `nodeActivity`, never the reasoning text itself. The fold reads assistant stream chunks (reasoning, text, tool-call) and durable turn, step, message, and tool events, so the phase follows the model without a second protocol and without copying content; the tracker releases a Session when its execution settles or its run does, and unloads with the panel. Observations publish on a change of stage, open tools, or live state, and otherwise at most once per second of new signal, so a token stream costs one render per second rather than one per chunk. The card derives its phase from the record plus that live state: a `conversing` node whose Session is actually working, or whose user reply has not landed, no longer reads as waiting for the user, and the stall notice measures the newest business timestamp across both sources, so sustained reasoning is not mistaken for silence. The run page projects the same records through `results-view.ts`: work nodes group at their latest round, structural start and end nodes collapse to one status line, conditions never become results — they stay off the cards and out of the status line while their failures still surface through the overview — and a node's file list is split for display — documents and project entries first, at most six before the full list, dependency, environment, and cache directories hidden behind a switch — without rewriting the record the runtime hands to later nodes. Handoffs render through the shared Markdown component with a file-open delegate, so a destination resolves against its round's working directory and opens the panel's resource address with its reveal line; every file action reuses the same address, so the sidebar owns loading and failure, and while the panel is on screen the open first switches to the run's conversation because the sidebar binds a session surface only there; that waiting open belongs to the plugin's lifetime — unloading drops it and a refused switch cancels it — and repeating the identical request folds into the one already waiting. The controller owns one snapshot store published through the inject `hooks` compartment, so components read with the standard `useAgentFlow` selector and never reach `ctx`; it also polls the run list while any run is in flight and stops when none is. It reads the roster once at mount, before any panel opens, because that read is what raises a concluded conversation's composer block through `ctx.conversation.blocks`; the block is derived from the durable run records, so it survives a reload. The selector derives its selection from the input machine's published claim — picking a flow dispatches the scoped begin-command event with a claim whose submit starts the run through the Remote namespace and folds it into the store at once, so the in-flight indicator never waits for a poll. That fold also records the run as one this client started; each poll then follows it into its conversational node's session the first time that session appears, and drops the intent when the run settles or turns out to have no conversational node. Graph geometry lives in `graph.ts`: node positions persist on the document, and nodes without one use their shortest execution distance from start. Each reachable id is visited once, so cyclic and unfinished drafts remain bounded; input edges stay visible without changing the layout. Every connection has a type label, an arrowhead, and a wide hit area. The start pair’s input curve is separated from its execution curve so either can be selected. Canvas edits mutate the draft through one callback, so a save always sends the complete document the Host validates. A new flow writes a neutral `start → Starter agent → end` graph; the entry role and graph are chosen in the canvas, and the shared Starter template is created only when absent. A refresh commits only when it is the newest; it merges runs this client confirmed while the response was in flight and never moves a terminal run back to running, and it drops observations no retained run can address any more. Poll ticks that arrive during a slow refresh coalesce into one follow-up, so a response slower than the poll interval still commits instead of being superseded forever. Saving an agent form adopts its assigned id, and the flow name edits the draft directly, so a save response cannot roll back later edits.

| File | Owns |
|---|---|
| `src/client/index.ts` | Browser entry: contribution import and apply |
| `src/client/mount.ts` | Remote mount, dictionaries, panel, sidebar, selector, progress-card registration, and the activity tracker's lifecycle |
| `src/client/controller.ts` | Snapshot store, Remote calls, run polling, sync state, published node activity |
| `src/client/run-view.ts` | Run↔session association and the record-only projections the card reads |
| `src/client/results-view.ts` | Result grouping, overview facts, and the artifact display projection for one run |
| `src/client/RunResults.tsx` | The run results page: overview, result cards, handoff Markdown, and file rows |
| `src/client/status.ts` | Run and node status labels and tones shared by the list and the results page |
| `src/client/time.ts` | Duration and relative-time wording shared by the card and the results page |
| `src/client/activity.ts` | The per-Session activity fold and the waiting-for-user decision |
| `src/client/activity-tracker.ts` | Retain/release of active node Sessions and throttled observation publication |
| `src/client/graph.ts` | Document-to-canvas mapping and draft edits |
| `src/client/Canvas.tsx` | Canvas, node cards, connect and drag handling |
| `src/client/Inspector.tsx` | Node and edge property forms |
| `src/client/FlowSelect.tsx` | The composer tool-row workflow selector |
| `src/client/FlowRunProgress.tsx` | The composer flow-progress card |
| `src/client/AgentFlowPage.tsx` | The panel: tabs, lists, agent form, chat-record run view |

No runtime invariant companion is published because the panel owns no host state; it renders one snapshot store over Remote reads.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-experimental-agent-flow](../agent-flow/README.md) — the documents, templates, and runs this panel reads and writes.
- [dsh-experimental-agent-flow-runtime](../agent-flow-runtime/README.md) — the graph interpreter that executes a run.
- [Agent Flow subsystem](../../../docs/subsystems/agent-flow.md) — the flow types and the executor seam.
- [Web client architecture](../../../docs/subsystems/web-client.md) — slots, props shares, and the object layer this panel builds on.

-----

<a id="model-experience"></a>
## Model Experience

None, as this browser panel registers no model-facing input.

#### KV Cache effect

No direct effect; the runtime's node agents and ordinary conversation submission own any model-visible use.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what the panel cannot do yet or where it needs special operational care. They are current package constraints, not a task backlog.

- **Run records poll while the live stage streams** — the run roster and its node executions refresh on an interval while a run is in flight, so a run that settles between polls appears late and the move into a conversation lands on a poll tick rather than at once; the stage of a node Session this client observes comes from that Session's own event feed between polls, and a Session the client cannot resolve reads its recorded status until the next poll. A failed read keeps the last good lists marked as last-known state instead of clearing the card.
- **A step without a new request header reads as preparing** — the Session log records a request header when it first appears or changes, not once per call, so after a turn's first step a later step can read **Preparing** until its first streamed output arrives. The log carries no per-request dispatch event the client could read instead.
- **A file opens beside the run's conversation, not beside the panel** — while the panel owns the main area the right sidebar holds no session surface, so **Preview** and handoff file links switch the main area to the run's parent conversation and open the preview there; the panel keeps the same run open for the way back. An in-panel preview needs a session surface a main panel can open into, which the sidebar does not offer.
- **Reasoning detail opens the node's conversation** — the card's entries open the node's Session in the main conversation, where the existing reasoning disclosure shows the stream; there is no reasoning pane beside the current conversation. An in-page view needs a Session-preview tab type in the right sidebar, which this package does not register yet.
- **No node-level retry or resume** — a failed run is terminal; the graph must be started again from the beginning.
- **Single-session parent** — one run's node agents share the parent session's lineage and workspace.
- **Experimental prototype with no stability promise** — the package is public, but its contracts can change freely while it incubates.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
