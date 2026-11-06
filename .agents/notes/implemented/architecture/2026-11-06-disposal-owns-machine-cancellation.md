# Agent Note: Disposal owns machine cancellation

Status: implemented

English | [中文](2026-11-06-disposal-owns-machine-cancellation.zh.md)

## Problem

Host teardown unloads every plugin fiber, and Cordis `_unload` (vendor/cordis/src/fiber.ts) runs a fiber's top-level effect disposers in parallel, each after one `await Promise.resolve()`. In the agent-loop plugin fiber, the `inbox` projection registration's disposer releases the factory's projection key concurrently with the FactoryOwnership disposer that cancels and drains every machine. An `Agent.cancel()` from an outside owner landing after that release — a subagent run abort fired by a sibling plugin's own unload, reaching `child.cancel({ kind: 'parent' })` while the child machine still drains — executed `inbox.clear()` against the released projection and threw `agent "<id>" cannot read inbox state: its projection registration is not active` synchronously out of `AbortController.abort()`. The same parallel release also broke the disposal cancel itself: `machine.cancel({ kind: 'disposed' })` threw before aborting the phase, so the machine never drained and the held model request never settled. Failures were intermittent because the interleaving depends on which fibers the Host unloads in which order and how many microtasks each disposer chain consumes before another plugin's unload reaches its abort.

## Decision

Cancellation ownership transfers to disposal, and the transfer is code-sequenced inside the memoized machine `dispose`, not in fiber effects. `ReactLoopAgent.beginDisposal()` is the transfer: it latches a private flag and clears a latched wake on the active phase. `dispose()` calls it at its first synchronous statement, so every continuation the unload wave can schedule after the ownership disposer — including another fiber's executor abort — observes the transfer; the machineReady wait re-arms it when teardown outran the lifecycle effect minting the machine. `cancel()` with any cause other than `disposed` returns once disposal has begun; the disposal's own disposed-cause cancel still clears the inbox and aborts the phase. `runMaintenance`, `send`, and the wake latch keep their existing rules: wakes never latch behind a `disposed` reason, and input submitted after disposal begins remains the sender's bug with its existing error.

The disposal cancel is liveness-guarded rather than trusting the registration: `dispose()` reads `stateOf(session, 'inbox')` immediately before cancelling, with no await between the read and the cancel, and passes `keepInbox` when the factory's release already removed the key. The skipped durable clear is unobservable because the session leaves with the machine; the phase still aborts and the machine still drains. `Agent.cancel()`'s Service Definition contract and the agent-loop README state the transfer; the illegal-lifecycle error for stray reads after release is unchanged.

Effect-based ordering cannot own this seam. `sessionProjections.register()` creates its own top-level effect on the plugin fiber, so wrapping it cannot defer the release, and a wrapper disposer runs one microtask after the registration and loses to the synchronous release. Machine scope fibers are themselves top-level effects of the plugin fiber and unwind in the same parallel wave, and every fiber in the Host unloads transitively, so no fiber lifetime survives the machine drain to sequence it. Only the memoized dispose — plain code the ownership disposer invokes — can order the cancel-ownership arming against the release.

## Verification

`packages/core/agent-loop/tests/scope-lifecycle.spec.ts` pins the interleaving deterministically: a `hang-slow` model request keeps a turn in flight, `loopFiber.dispose()` starts the unload wave, and after the wave releases the projection (asserted through `stateOf`) an outside `agent.cancel({ kind: 'parent' })` lands inside the still-pending drain. The test asserts the cancel does not throw, no unhandled rejection is recorded, the turn ends `{ kind: 'aborted', reason: { kind: 'disposed' } }`, the machine reaches idle, and the unload completes. Against the pre-fix source the same test fails with the exact production error. The agent-loop suite, the subagent driver suites, and the web L1 acceptance group run green with the host-failure watchers (`unhandledRejection` and `uncaughtException`) asserting empty after every case.

## Alternatives considered

**Treat a released projection as an empty inbox in `stateOf`.** That swallows the illegal-lifecycle error for genuine stray access; `send()` after teardown is a sender bug that must stay loud.

**Catch and log the disposal-cancel failure.** The phase would never abort, the machine would never drain, and the held model request would leak. Fixing ownership is the review's principle; masking the read is not.

**Retry or disable same-Session multi-run to hide the race.** The race belongs to teardown, not run multiplicity, and masking it would leave every teardown with an in-flight subagent at risk.

## Consequences

External cancellation is advisory while a machine tears down: only the disposed-cause cancel affects the machine, so the turn-ending cause during teardown is stable regardless of which outside aborts race it. Host and plugin teardown with in-flight subagent runs no longer produces the inbox projection error, and disposal drains the machine even when the factory's projection release has already run. Registration-like effects that must outlive a parallel teardown seam need the same code-sequenced ownership rather than reliance on effect order.
