/**
 * Browser entry for the optional Agent Flow Remote contribution, its panel,
 * and the flow-progress dock. The Config schema validates the deployment's
 * progress-surface tunables from cordis.yml and defaults the rest.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import agentFlowRemote from '@deepseek-ai/dsh-experimental-agent-flow/remote'
import { mountAgentFlowPanel, type FlowPanelOptions } from './mount.ts'

export { inject } from './mount.ts'

/** Plugin configuration: the progress surface's quiet-period threshold. */
export interface Config {
  /**
   * Quiet period in ms after which a running run's progress card shows "no
   * new recorded activity". The clock reads the newest business signal — a
   * recorded run transition or an observed node-Session event — never
   * transport freshness. It bounds a display notice only; it never fails,
   * retries, or cancels the run.
   */
  stallNoticeMs: number
}

/** Deployment defaults for deployments that configure nothing. */
const DEFAULT_STALL_NOTICE_MS = 600_000

export const Config = z.object({
  stallNoticeMs: z.number()
    .step(1)
    .min(5_000)
    .max(86_400_000)
    .default(DEFAULT_STALL_NOTICE_MS),
})

/**
 * Resolve panel options from a raw config through the Config schema, applying
 * the schema defaults exactly as the Loader does. The explicit resolve step
 * keeps direct callers (tests, host harnesses) on the same defaults.
 * @param config - raw config the Loader parsed, or nothing.
 * @returns the validated options.
 * @throws when the config fails the schema.
 */
export function resolvePanelConfig(config?: Partial<Config>): FlowPanelOptions {
  const result = Config['~standard'].validate(config ?? {})
  /* v8 ignore next -- the schema validates synchronously, like every Loader config */
  if ('then' in result) throw new TypeError('Async config validation is not supported')
  if (result.issues) throw new Error(result.issues.map(issue => issue.message).join('; '))
  return result.value as Config
}

/**
 * Activate the Agent Flow panel and the flow-progress dock.
 * @param ctx - client runtime.
 * @param config - validated config the Loader parsed, absent for direct callers.
 * @returns complete UI and Remote disposer.
 */
export async function apply(ctx: Context, config?: Partial<Config>): Promise<() => Promise<void>> {
  return await mountAgentFlowPanel(ctx, agentFlowRemote, resolvePanelConfig(config))
}
