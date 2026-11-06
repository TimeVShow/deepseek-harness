/**
 * Status labels and tones shared by the runs list and the run results page, so
 * one execution status reads the same wherever it appears.
 * @module
 */

import type { TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import { RUN_PHASE_LABEL_KEYS } from './locales.ts'

/** Node execution status → label key. */
export const NODE_STATUS_KEYS = {
  pending: 'runs.node.pending',
  running: 'runs.node.running',
  conversing: 'runs.node.conversing',
  succeeded: 'runs.node.succeeded',
  failed: 'runs.node.failed',
  skipped: 'runs.node.skipped',
} as const

/** Run phase → tone; a conversational wait reads as a warning. */
export const RUN_STATUS_TONES: Readonly<Record<keyof typeof RUN_PHASE_LABEL_KEYS, TagTone>> = {
  running: 'info',
  clarifying: 'warning',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
}

/** Node execution status → tone. */
export const NODE_STATUS_TONES: Readonly<Record<keyof typeof NODE_STATUS_KEYS, TagTone>> = {
  pending: 'neutral',
  running: 'info',
  conversing: 'warning',
  succeeded: 'success',
  failed: 'danger',
  skipped: 'quiet',
}
