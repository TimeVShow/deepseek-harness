/**
 * Agent delivery contract errors.
 *
 * @module @deepseek-ai/dsh-agent/errors
 */

/**
 * Delivery rejected because the machine's lifecycle disposal owns its inbox.
 * Teardown-aware callers treat this refusal as the end of best-effort
 * delivery — the input must not be reported as a transport failure.
 */
export class AgentDeliveryClosedError extends Error {
  /**
   * @param agentId - identity of the agent that no longer accepts delivery.
   */
  constructor(agentId: string) {
    super(`agent "${agentId}" disposal has begun; it no longer accepts input`)
    this.name = 'AgentDeliveryClosedError'
  }
}
