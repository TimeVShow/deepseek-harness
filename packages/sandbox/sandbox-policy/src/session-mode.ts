/**
 * Per-session sandbox overrides: the session log as the store. A runtime switch
 * (a UI policy control, a test scenario, or a delegated node's own directory) is
 * recorded as one `sandbox/mode` or `sandbox/root` event on the session it
 * applies to; `effective = projection state ?? the session header cwd ?? the
 * deployment default`, so an override survives restart by replay, two sessions
 * can never see each other's state, and there is no external config store. The
 * events are log-only (the `approval/*` precedent): the policy owner projects
 * the folds into each model request, while enforcing tools report
 * operation-specific boundary markers. EXECUTION honors the same folds through
 * `ctx.sandboxPolicy.resolve()` — it stamps the mode and root together onto each
 * capability call, weakest-precedence beneath an escalation grant.
 *
 * The overrides are policy state shared by every enforcing family (bash and
 * filesystem alike), so they live here in the policy package rather than in any
 * one capability's seam.
 *
 * @module dsh-sandbox-policy/session-mode
 */

import { isAbsolute } from 'node:path'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The session's sandbox mode was switched — log-only (like `approval/*`;
     * NOT a surface event, carries no `surfaceOp`): durable and replayable,
     * never in the model transcript. The LAST such event is the session's
     * override (folded by the sandboxMode projection unit). `source: 'delegation'` marks
     * an override seeded into a child; an absent source is a runtime switch.
     */
    'sandbox/mode': {
      mode: SandboxMode
      /** Marks an override seeded into a child at delegation. */
      source?: 'delegation'
    }
    /**
     * The session's `workspace-write` root was narrowed — log-only, durable,
     * and replayed like `sandbox/mode`. The LAST such event is the session's
     * root override (folded by the sandboxWorkspace projection unit); without
     * one the immutable header cwd remains the boundary. `source: 'delegation'`
     * marks a root inherited by a child, keeping a delegated agent inside its
     * parent's scope.
     */
    'sandbox/root': {
      /** Absolute execution-world directory every confined write must stay under. */
      root: string
      /** Marks a root inherited by a child at delegation. */
      source?: 'delegation'
    }
  }
}

/** Every {@link SandboxMode}, for option advertisement and runtime validation of untrusted mode strings. */
export const SANDBOX_MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']

/**
 * THE write path for a session's sandbox-mode override: appends exactly one
 * `sandbox/mode` event — the switch IS its event; nothing mutates mode state
 * out of band. Takes effect on the session's next confined call (bash or fs)
 * — consumers read the shared projection state.
 * @param session - the session the override belongs to.
 * @param mode - the mode every subsequent confined call in this session runs
 *   under (until the next switch).
 */
export function setSandboxMode(session: Session, mode: SandboxMode): void {
  session.append('sandbox/mode', { mode })
}

/**
 * THE write path for a session's sandbox workspace root: appends exactly one
 * `sandbox/root` event — the narrowing IS its event; nothing mutates the root
 * out of band. Takes effect on the session's next confined call (bash or fs) —
 * consumers read the shared projection state.
 * @param session - the session the override belongs to.
 * @param root - the absolute directory every subsequent confined write in this
 *   session must stay under (until the next switch).
 * @throws when the root is not an absolute execution-world path.
 */
export function setSandboxRoot(session: Session, root: string): void {
  if (!isAbsolute(root) || root.includes('\0')) {
    throw new Error('sandbox-policy: sandbox root must be an absolute execution-world path without NUL bytes')
  }
  session.append('sandbox/root', { root })
}
