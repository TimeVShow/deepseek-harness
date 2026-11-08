/**
 * The composer tool-row workflow selector. Picking a flow claims the session's
 * input with a decorated token (the input machine's claim seam), so the next
 * submitted message starts a run of that flow with the message as its input
 * instead of reaching the agent. The token is prepended to any draft text
 * already typed, because the command claim must lead the draft. The selection
 * is derived from the input machine's published claim — deleting the token
 * from the draft exits the selection, exactly like picking "no workflow".
 */

import { useState, type ReactNode } from 'react'
import {
  IconBranchOutlineRegular, IconChevronDownOutlineRegular, Menu, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
/* Type-only: pulls the conversation-owned slot declaration, the session
   standard props, and the claim types into this package's Client face. */
import type { InputState, TokenSpan } from '@deepseek-ai/dsh-client-ui-conversation/client'
import clsx from 'clsx'
import { FLOW_CLAIM_PREFIX, type FlowSelectInjected } from './mount.ts'
import { runInvolvesSession } from './run-view.ts'
import { NS } from './locales.ts'
import css from './FlowSelect.module.css'

/** Menu row ids reserved for actions; every other row id is a flow id. */
const NONE_ROW = 'selector.none'
const RUNS_ROW = 'selector.runs'

/** Complete props derived from the slot, the injected face, and locale. */
export type FlowSelectProps =
  PropsRuntime<'conversation.input.left'>
  & InjectFace<FlowSelectInjected>
  & PropsLocale<typeof NS>

/** The claim's flow id and token when the active claim is this selector's, else undefined. */
function ownClaim(claim: InputState['claim']): { readonly id: string; readonly token: string } | undefined {
  if (claim === undefined || !claim.name.startsWith(FLOW_CLAIM_PREFIX)) return undefined
  return { id: claim.name.slice(FLOW_CLAIM_PREFIX.length), token: claim.token }
}

/** The span covering one claim token; a fresh claim replaces it, keeping any typed input. */
function tokenSpan(token: string, draftRev: number): TokenSpan {
  return { start: 0, end: token.length, draftRev }
}

export function FlowSelect({
  useInput, useAgentFlow, refresh, claimFlow, clearFlow, openRuns, sessionId, t,
}: FlowSelectProps): ReactNode {
  const claim = useInput(state => state.claim)
  const draftRev = useInput(state => state.draftRev)
  const busy = useInput(state => state.phase === 'adjudicating' || state.phase === 'submitting')
  const flows = useAgentFlow(state => state.flows)
  /* A run is this session's when the session started it or when one of the
     run's node executions opened inside it — the conversational node's
     session keeps its in-flight indicator after the node concluded. */
  const running = useAgentFlow(state =>
    state.runs.some(run => run.status === 'running' && runInvolvesSession(run, sessionId)))
  const [open, setOpen] = useState(false)
  const [claimError, setClaimError] = useState(false)

  const own = ownClaim(claim)
  const selected = flows.find(flow => flow.id === own?.id)
  /* A claimed flow the roster no longer lists (deleted underneath the open
     claim) still names itself through its token. */
  const label = selected?.name ?? own?.token.trim() ?? t('selector.label')

  const items: MenuEntry[] = []
  if (flows.length === 0) {
    items.push({ type: 'label', id: 'selector.empty', text: t('selector.empty') })
  } else {
    items.push({ id: NONE_ROW, label: t('selector.none') })
    for (const flow of flows) items.push({ id: flow.id, label: flow.name })
  }
  if (running) {
    items.push(
      { type: 'separator', id: 'selector.separator' },
      { id: RUNS_ROW, label: t('selector.openRuns'), icon: <StateDot state="ongoing" size={10} /> },
    )
  }
  if (claimError) items.push({ type: 'label', id: 'selector.claimFailed', text: t('selector.claimFailed') })

  const choose = (id: string): void => {
    if (id === RUNS_ROW) {
      setOpen(false)
      openRuns()
      return
    }
    if (id === NONE_ROW) {
      setOpen(false)
      /* Clearing lifts only this selector's claim; a foreign command claim is
         its owner's to exit. */
      if (own !== undefined) clearFlow(tokenSpan(own.token, draftRev))
      return
    }
    const flow = flows.find(candidate => candidate.id === id)
    /* The guard is for the row shape `find` cannot promise; the menu's flow
       rows ARE `flows`, so an emitted id is always one of them. */
    /* v8 ignore next */
    if (flow === undefined) return
    /* A command claim must lead the draft: replace an active claim's token, or
       insert at the start so text typed before picking the flow survives. */
    const span = claim !== undefined ? tokenSpan(claim.token, draftRev) : { start: 0, end: 0, draftRev }
    const accepted = claimFlow(flow, span)
    setClaimError(!accepted)
    setOpen(!accepted)
  }

  return (
    <Menu
      open={open}
      items={items}
      selectedId={own?.id ?? NONE_ROW}
      onSelect={choose}
      onClose={() => { setOpen(false) }}
      side="top"
      portal
      anchor={
        <button
          type="button"
          className={css.trigger}
          aria-label={running ? `${label} · ${t('selector.running')}` : label}
          disabled={busy}
          onClick={() => {
            const next = !open
            /* The roster changes in the panel; every opening reads it fresh. */
            if (next) {
              setClaimError(false)
              void refresh()
            }
            setOpen(next)
          }}
        >
          <span className={css.triggerIcon} aria-hidden>
            <IconBranchOutlineRegular />
            {running && <StateDot state="ongoing" size={8} className={css.live} />}
          </span>
          <span className={css.triggerLabel}>{label}</span>
          <span className={clsx(css.chevron, open && css.chevronOpen)} aria-hidden>
            <IconChevronDownOutlineRegular />
          </span>
        </button>
      }
    />
  )
}
