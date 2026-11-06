# Agent Note: Derive the Agent Flow progress card from run records only

Status: implemented

English | [中文](2026-11-04-agent-flow-progress-card.zh.md)

## Problem

A run's node executions open their own Sessions, and the client moves the user into the conversing one. From inside that Session nothing tied the user back to the run: `FlowSelect` matched only a run's parent session id, so the in-flight indicator, the flow panel, and any progress display lost the run the moment the user sat in a node Session — and a reload lost it everywhere. When a node then stayed quiet for tens of minutes (the run that motivated this card shows a node sitting on its second step for half an hour), the user had no signal at all, and the tempting fallbacks — treating quiet as failure, auto-retrying, or showing a fabricated percentage — would each fabricate state the durable record does not contain.

## Decision

`packages/experimental/client-ui-agent-flow` registers a fourth composer surface, the `conversation.input.dock` flow-progress card, and one module owns what any session-related display may claim: `run-view.ts` projects every fact from the durable run record, never from component-local inference.

The association rule is the card's and the selector's shared entry point: a run involves its parent session and every session a node execution recorded as its `agentSessionId`. Both surfaces address sessions through that rule, so a user inside a node Session keeps the indicator and the card, and a reload recovers both from the record alone.

The card shows what the record carries, no more: phase (running, waiting for your reply, completed, failed, cancelled), elapsed time, one line per live or immediately-startable node execution with its round number and the live predecessors it waits on — a skipped branch leaves the wait set, and a node's first entry does not wait on the rework condition edge that only routes later rounds back — plus the single most recent recorded transition with its age. A run quiet past the configured `stallNoticeMs` (default ten minutes) shows a notice naming the last known activity; the notice claims no fault, because a quiet record is not evidence of one. While a roster read fails, the card marks itself as last-known state and keeps the previous lists; the mark clears on the next successful read. **Cancel** appears only while the run is running and its parent session still has a live agent, and the card states the outcome through the run's own recorded status — it never reports a claimed cancellation.

The block a concluded conversation's composer receives carries the same discipline: it names the run's live execution successors when any remain, otherwise the run's recorded outcome. The structural end node is not a successor, so a settled run reads as completed rather than as "still continuing".

## Testing

The client suite covers the association rule for parent and node sessions, live-first ordering, execution-edge-only predecessors with skipped exits, the ready/waiting/settled projection, round numbering, phase mapping, activity tie and unparseable-timestamp handling, the stall threshold with a frozen clock, the last-known mark clearing on recovery, the run picker, the cancel posture persisting until the roster confirms settlement, inline cancel failure, and the config bounds of `stallNoticeMs`.

## Alternatives considered

**Auto-fail or auto-retry a quiet run.** The record cannot distinguish a stuck model from a long legitimate step; an automatic verdict would fabricate a failure the run authority never recorded, and a retry could duplicate side effects. The card reports the quiet period and leaves the verdict — and the cancel entry — to the user.

**Report progress percentages.** The record carries no total work estimate; any percentage would be invented. Node lines with wait sets state exactly what is known.

**Store the association on the Session or through a live registry.** The durable run record already holds both directions (`parentSessionId`, per-node `agentSessionId`); a second store would drift from it and would not survive a reload.

**Treat the composer block as a toast.** The block is surface-tied state that must persist until the run settles, so it stays a persistent registry entry like the other composer blocks.

## Consequences

The card never lies about progress, but it also cannot explain a quiet node: the most it can say is that no new activity was recorded, which is exactly the honest bound. Runs whose node Sessions were opened by another client still associate correctly, because the rule reads the record, not the acting client. The `stallNoticeMs` field is display configuration only; it must never grow into a timeout that fails runs.
