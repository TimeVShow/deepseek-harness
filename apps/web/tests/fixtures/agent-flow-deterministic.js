/**
 * Deterministic agent-flow executor for the session-isolation e2e lane:
 * completes one run's agent node without model calls or spawned Agents, so
 * the run's durable usage facts — not a paid provider — drive navigation.
 */

export const name = 'agent-flow-deterministic'

/** Provide the executor after the agent-flow service has activated. */
export const inject = ['agentFlows']

/**
 * Register the default `graph` executor: every non-terminal node succeeds
 * immediately and the run settles as completed.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 */
export function apply(ctx) {
  ctx.effect(() => {
    const unregister = ctx.agentFlows.registerExecutor({
      name: 'graph',
      async execute(controller) {
        for (const entry of controller.run.nodeRuns) {
          if (entry.nodeId === 'start' || entry.nodeId === 'end') continue
          await controller.updateNodeRun(entry.nodeId, {
            status: 'succeeded',
            handoff: 'deterministic handoff',
          })
        }
        return { stopReason: 'completed' }
      },
      cancel: () => {},
      concludeConversation: () => false,
    })
    return () => { void unregister() }
  }, 'agent-flow-deterministic: executor')
}
