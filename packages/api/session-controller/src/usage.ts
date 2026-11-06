/**
 * The session-usage seam. A plugin that starts durable, non-conversation work
 * inside a Session — for example an orchestration run persisted under that
 * Session's identity — reports it here, so Session summaries and blank-session
 * adoption can tell "no ordinary chat turns" apart from "reusable as a new
 * conversation". The provider owns the durable facts and keeps its own
 * vocabulary out of this interface.
 * @module @deepseek-ai/dsh-api-session-controller/src/usage
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'

/**
 * Answers whether one Session carries recorded plugin usage that occupies it
 * beyond its ordinary turn history.
 */
export interface SessionUsage {
  /**
   * Whether the named Session is occupied by durable plugin usage and must not
   * be adopted as another conversation's blank starting point.
   * @param sessionId - durable Session identity.
   * @returns true when recorded usage occupies the Session.
   */
  isOccupied(sessionId: SessionId): boolean
  /**
   * Optional change feed. A provider that occupies a Session while Hosts are
   * live reports it here so summaries refresh without waiting for the next
   * list read. Every reported identity must already answer `isOccupied` true.
   * @param listener - called once per newly occupied Session.
   * @returns a disposer that removes the listener.
   */
  subscribe?(listener: (sessionId: SessionId) => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Optional plugin-provided Session usage facts. Absent while no plugin
     * owns durable non-conversation Session usage; read through
     * {@link sessionUsageOf} or `ctx.get`.
     */
    sessionUsage: SessionUsage
  }
}

/**
 * Read the mounted session-usage provider.
 * @param ctx - Host context whose service store may hold the provider.
 * @returns the provider, or undefined when no plugin owns usage facts.
 */
export function sessionUsageOf(ctx: Context): SessionUsage | undefined {
  return ctx.get('sessionUsage')
}
