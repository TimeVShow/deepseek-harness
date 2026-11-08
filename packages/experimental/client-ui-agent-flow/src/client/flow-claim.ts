/**
 * The composer workflow claim shared by the mounted selector and its vertical
 * integration tests: the claim's token, localized copy, submit call, and
 * scoped begin-command dispatch.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandClaim, SubmitOutcome, TokenSpan } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { FlowDocument, FlowRun } from '@deepseek-ai/dsh-experimental-agent-flow/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/** Claim-name prefix marking a composer claim as the workflow selector's. */
export const FLOW_CLAIM_PREFIX = 'agent-flow/'

/** Localized composer copy one claim needs. */
export interface FlowClaimCopy {
  /** The visible token for one selected flow, before its trailing space. */
  token(flow: FlowDocument): string
  hint: string
  /**
   * Standing warning for a flow that will not receive the message this claim
   * submits; the claim hint prepends it because the host claim has no separate
   * warning field. Absent when the flow reads the run input.
   */
  warning?: string
  emptyInput: string
  startFailed(message: string): string
}

/** Production start/observe operations one claim uses. */
export interface FlowClaimStart {
  start(sessionId: SessionId, request: { flowId: FlowDocument['id']; input: string }): Promise<RemoteResult<FlowRun>>
  noteStarted(run: FlowRun): void
}

/**
 * Build the command claim one flow selection enters.
 * @param sessionId - session whose composer carries the claim.
 * @param flow - selected flow.
 * @param copy - localized token, hint, and error copy.
 * @param operations - start call and local run publication.
 * @returns the claim handed to the scoped begin-command event.
 */
export function createFlowClaim(
  sessionId: SessionId,
  flow: FlowDocument,
  copy: FlowClaimCopy,
  operations: FlowClaimStart,
): CommandClaim {
  return {
    name: `${FLOW_CLAIM_PREFIX}${String(flow.id)}`,
    token: `${copy.token(flow)} `,
    hint: copy.warning === undefined ? copy.hint : `${copy.warning}\n${copy.hint}`,
    submit: async (args): Promise<SubmitOutcome> => {
      const input = args.trim()
      if (input === '') return { kind: 'error', text: copy.emptyInput }
      const result = await operations.start(sessionId, { flowId: flow.id, input })
      if (!result.ok) return { kind: 'error', text: copy.startFailed(result.error.message) }
      operations.noteStarted(result.value)
      return { kind: 'success' }
    },
  }
}

/**
 * Dispatch one claim through the scoped begin-command waterfall.
 * @param owner - scoped context whose listeners own the input machine.
 * @param claim - claim to apply.
 * @param span - replace range in the draft.
 * @returns whether the input machine accepted the claim.
 */
export function beginFlowClaim(owner: Context, claim: CommandClaim, span: TokenSpan): boolean {
  return owner.bail(owner, 'slash/input-begin-command', { claim, span }) === true
}
