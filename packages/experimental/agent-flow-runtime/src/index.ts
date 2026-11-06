/**
 * Registers the Agent Flow graph interpreter on `ctx.agentFlows`: one executor
 * that schedules validated flow documents, drives their worker nodes through the
 * subagent seam, and opens a root Session for the node that talks to the user.
 * @module @deepseek-ai/dsh-experimental-agent-flow-runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { GraphExecutor } from './executor.ts'

export const name = 'agent-flow-runtime'
export const inject = ['agentFlows', 'subagents', 'agents', 'agentDefaultModel']

/** Plugin configuration: registry and subagent selection with the run bounds. */
export interface Config {
  /** Registry name the executor registers under; must match the service's `executor` config. */
  executor: string
  /** Subagent provider name used for node agents. */
  provider: string
  /** Maximum concurrently running node agents. */
  maxConcurrentAgents: number
  /** Maximum turns one interactive node may take before its run fails. */
  maxConversationTurns: number
}

/** Deployment defaults for deployments that configure nothing. */
const DEFAULTS = {
  executor: 'graph',
  provider: 'spawn',
  maxConcurrentAgents: 4,
  maxConversationTurns: 16,
} as const

export const Config = z.object({
  executor: z.string().default(DEFAULTS.executor),
  provider: z.string().default(DEFAULTS.provider),
  maxConcurrentAgents: z.number().step(1).min(1).default(DEFAULTS.maxConcurrentAgents),
  maxConversationTurns: z.number().step(1).min(1).default(DEFAULTS.maxConversationTurns),
})

/**
 * Register the graph executor; the registration unwinds with this plugin.
 * @param ctx - plugin context carrying the Agent Flow, subagent, agent, and model services.
 * @param config - executor and subagent selection with the run bounds.
 */
export function apply(ctx: Context, config: Config): void {
  const executor = config.executor.trim()
  const provider = config.provider.trim()
  if (!executor) throw new Error('executor must not be an empty name')
  if (!provider) throw new Error('provider must not be an empty name')
  ctx.effect(() => {
    const unregister = ctx.agentFlows.registerExecutor(new GraphExecutor(ctx, {
      executor,
      provider,
      maxConcurrentAgents: config.maxConcurrentAgents,
      maxConversationTurns: config.maxConversationTurns,
    }))
    return async () => { await unregister() }
  }, 'agentFlowRuntime.executor()')
}
