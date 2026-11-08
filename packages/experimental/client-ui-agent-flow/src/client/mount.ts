/**
 * Browser mount for the Agent Flow panel: it mounts this package's generated
 * Remote contribution itself (the stable API-Remotes assembly never names an
 * experimental package), then contributes the **Agent Flow** entry to the
 * sidebar and the graph-editor page it opens.
 * @module
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
// The `file` entry of `SidebarRightResourceParamsMap`, which types the reveal
// line `openResource` receives below.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
/* Type-only: the claim types plus the scoped input-event merges the selector's
   begin/consume dispatches type against. */
import type { TokenSpan } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-experimental-agent-flow/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import type {
  AgentTemplate,
  AgentTemplateDraft,
  AgentTemplateId,
  FlowDocument,
  FlowDraft,
  FlowId,
  FlowRunId,
} from '@deepseek-ai/dsh-experimental-agent-flow/types'
import canvasStyles from '@xyflow/react/dist/style.css?inline'
import { AgentFlowPage } from './AgentFlowPage.tsx'
import { AgentFlowPanelIcon } from './AgentFlowPanelIcon.tsx'
import { NodeActivityTracker } from './activity-tracker.ts'
import { FlowRunProgress } from './FlowRunProgress.tsx'
import { beginFlowClaim, createFlowClaim } from './flow-claim.ts'
import { FlowSelect } from './FlowSelect.tsx'
import { AgentFlowController, type AgentFlowView, type FlowLockReason } from './controller.ts'
import { en, NS, zh } from './locales.ts'
import type { OpenFileOptions } from './RunResults.tsx'

/**
 * Loader-facing services: they must exist before this plugin activates. The
 * Remote namespaces this plugin reads are narrower runtime injections declared
 * in `mountAgentFlowPanel` — `remote.agentFlows` only exists after this plugin
 * mounts its own contribution, so it cannot sit here.
 */
export const inject = ['remote', 'slots', 'locale', 'uiWorkspace', 'sidebarRight', 'sessions', 'uiSession', 'layout']

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'agent-flow' as MainPanelId

export { FLOW_CLAIM_PREFIX } from './flow-claim.ts'

/** Plain data and callbacks the page and the sidebar entry receive. */
export interface AgentFlowInjected {
  /** The panel's observable snapshot, bound to `useAgentFlow`. */
  hooks: { agentFlow: AgentFlowController['state'] }
  load: () => Promise<void>
  setView: (view: AgentFlowView) => void
  selectFlow: (id: FlowId | undefined) => void
  updateDraft: (mutate: (draft: FlowDocument) => void) => void
  createFlow: (templateId?: AgentTemplateId) => Promise<void>
  saveFlow: (draft: FlowDraft) => Promise<FlowDocument>
  deleteFlow: (id: FlowId) => Promise<void>
  saveTemplate: (draft: AgentTemplateDraft) => Promise<AgentTemplate>
  deleteTemplate: (id: AgentTemplate['id']) => Promise<void>
  selectRun: (id: FlowRunId | undefined) => void
  cancelRun: (sessionId: SessionId, runId: FlowRunId) => Promise<void>
  concludeConversation: (sessionId: SessionId, runId: FlowRunId) => Promise<void>
  /**
   * Open one produced file through the panel's resource action. A reveal line
   * a Markdown destination carried travels as the file resource's navigation
   * parameter, not as part of the address. While this panel owns the main
   * area the sidebar has no session surface, so the file opens in the run's
   * parent conversation: the open lands once that conversation's seat mounts.
   * A waiting open belongs to this plugin's lifetime — unloading drops it —
   * and repeating an identical request while one waits is a no-op; a refused
   * navigation cancels the waiting open and rethrows.
   */
  openFile: (sessionId: SessionId, path: string, options?: OpenFileOptions) => void
  openSession: (sessionId: SessionId) => void
}

/** The page's injected face. */
export type AgentFlowFace = AgentFlowInjected

/** Plain data and callbacks the composer workflow selector receives. */
export interface FlowSelectInjected {
  /** The shared snapshot (flow roster and in-flight runs), bound to `useAgentFlow`. */
  hooks: { agentFlow: AgentFlowController['state'] }
  /** Re-read every list (the roster can change in the panel while a session lives). */
  refresh: () => Promise<void>
  /**
   * Claim the session's input for one flow: the editor gains the flow's
   * token and the next submitted message starts a run with the message as
   * its input. Covers an active claim's token when the span says so.
   * @param flow - flow to select.
   * @param span - replace range: the live caret, or the active claim's token.
   * @returns whether the input machine accepted the claim.
   */
  claimFlow: (flow: FlowDocument, span: TokenSpan) => boolean
  /**
   * Drop the selector's active claim by consuming its token.
   * @param span - the claim token's range.
   * @returns whether the token was consumed.
   */
  clearFlow: (span: TokenSpan) => boolean
  /** Open the panel's Runs tab (the in-flight indicator's destination). */
  openRuns: () => void
}

/** Plain data and callbacks the flow-progress dock entry receives. */
export interface FlowProgressInjected {
  /** The shared snapshot (run roster and sync state), bound to `useAgentFlow`. */
  hooks: { agentFlow: AgentFlowController['state'] }
  /** Open the panel's Runs tab with one run's record open. */
  openRun: (runId: FlowRunId) => void
  /** Open one session in the workspace. */
  openSession: (sessionId: SessionId) => void
  /**
   * Cancel one in-flight run through its parent session. The roster owns the
   * outcome: the entry stays in its cancelling posture until a read reports
   * the run settled, so it never claims a cancellation that did not converge.
   * @param sessionId - session that started the run.
   * @param runId - run identity.
   */
  cancelRun: (sessionId: SessionId, runId: FlowRunId) => Promise<void>
  /** Quiet period in ms after which a running run shows the stall notice. */
  stallNoticeMs: number
}

/** Panel options resolved from the plugin's validated Config. */
export interface FlowPanelOptions {
  /** Quiet period in ms after which a running run shows the stall notice. */
  stallNoticeMs: number
}

/**
 * Surface one thrown value's message.
 * @param error - the thrown value.
 * @returns its message, or its string form.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read the validation problems a rejected save carries, in host order.
 * @param error - the thrown value.
 * @returns one message per problem, or an empty list.
 */
export function problemsOf(error: unknown): readonly string[] {
  const details = (error as { details?: { problems?: readonly { code: string; message: string }[] } }).details
  return (details?.problems ?? []).map(problem => problem.message)
}

/** Register dictionaries, the controller, and every UI surface. */
function registerUi(ctx: ClientContext, options: FlowPanelOptions): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-agent-flow: dictionaries')
  /* The graph library ships its base stylesheet as text; the panel owns the
     element that carries it, so unloading the plugin removes it too. */
  ctx.effect(() => {
    const element = document.createElement('style')
    element.textContent = canvasStyles
    document.head.append(element)
    return () => { element.remove() }
  }, 'ui-agent-flow: canvas styles')
  const t = ctx.locale.bind(NS)
  /* A concluded conversation's block states what the flow moved on to: the
     live successors by name, or the run's settled outcome. */
  const lockReasonText = (reason: FlowLockReason): string => {
    const live = reason.successors.filter(successor => successor.live).map(successor => successor.name)
    if (live.length > 0) return t('composer.locked.continuing', { names: live.join(t('common.separator')) })
    return reason.runStatus === 'completed' || reason.runStatus === 'failed' || reason.runStatus === 'cancelled'
      ? t(`composer.locked.${reason.runStatus}`)
      : t('composer.locked')
  }
  const controller = new AgentFlowController(
    ctx.remote,
    (sessionId) => { ctx.uiWorkspace.openSession(sessionId) },
    (sessionId, reason) => { ctx.conversation.blocks.set(sessionId, { reason: lockReasonText(reason) }) },
  )
  ctx.effect(() => () => { controller.dispose() }, 'ui-agent-flow: controller')
  /* Node Sessions the roster marks active stay retained in the background, so
     the progress card reads a live phase without the user opening a node, and
     a node that settles stops its traffic. */
  const tracker = new NodeActivityTracker(
    ctx.sessions,
    ctx.uiSession.sessionStatus,
    (sessionId, observation) => { controller.noteActivity(sessionId, observation) },
  )
  const stopTracking = controller.state.subscribe(() => {
    tracker.sync(controller.state.getSnapshot().runs)
  })
  ctx.effect(() => () => { stopTracking(); tracker.dispose() }, 'ui-agent-flow: activity tracker')
  /* A file open that waits for the run's conversation to mount belongs to this
     plugin's lifetime: unloading drops the waiting requests instead of firing
     them into an inactive context later. Normal page switches never cancel
     one — the switch the open itself asked for is what the request waits for. */
  const pendingOpens = new Map<string, () => void>()
  ctx.effect(() => () => {
    for (const stop of [...pendingOpens.values()]) stop()
    pendingOpens.clear()
  }, 'ui-agent-flow: pending file opens')
  /* Reading the roster at mount, not only when the panel opens, is what makes a
     concluded conversation's composer block apply from app start. A mount that
     races the connection fails that read, so reload once the transport is up. */
  void controller.load()
  const connection = ctx.get('connection') as
    | { state?: { getSnapshot(): string | undefined; subscribe(listener: () => void): () => void } }
    | undefined
  if (connection?.state !== undefined) {
    if (connection.state.getSnapshot() === 'connected') void controller.load()
    else {
      const stop = connection.state.subscribe(() => {
        if (connection.state?.getSnapshot() === 'connected') void controller.load()
      })
      ctx.effect(() => stop, 'ui-agent-flow: load on connect')
    }
  }
  const face: AgentFlowInjected = {
    hooks: { agentFlow: controller.state },
    load: async () => { await controller.load() },
    setView: (view) => { controller.setView(view) },
    selectFlow: (id) => { controller.selectFlow(id) },
    updateDraft: (mutate) => { controller.updateDraft(mutate) },
    createFlow: async (templateId) => { await controller.createFlow(templateId) },
    saveFlow: async draft => await controller.saveFlow(draft),
    deleteFlow: async (id) => { await controller.deleteFlow(id) },
    saveTemplate: async draft => await controller.saveTemplate(draft),
    deleteTemplate: async (id) => { await controller.deleteTemplate(id) },
    selectRun: (id) => { controller.selectRun(id) },
    cancelRun: async (sessionId, runId) => { await controller.cancelRun(sessionId, runId) },
    concludeConversation: async (sessionId, runId) => { await controller.concludeConversation(sessionId, runId) },
    openFile: (sessionId, path, options) => {
      const url = fileAddressFor(sessionId, controller.cwdOf(sessionId), path)
      const open = () => {
        if (options?.line === undefined) ctx.sidebarRight.openResource(url)
        else ctx.sidebarRight.openResource(url, { params: { line: options.line } })
      }
      if (ctx.sidebarRight.mounted.getSnapshot() === sessionId) {
        open()
        return
      }
      /* This panel replaces the conversation, so while it is on screen the
         sidebar holds no session surface to open into; the switch below mounts
         the run's own conversation, whose seat publishes its binding after
         that commit, and the open lands then. Repeating an identical request
         is a no-op: the one waiting entry already carries it and the switch it
         asked for is under way, while a different file or reveal line waits
         alongside it. Another session mounting leaves every request waiting. */
      const key = `${String(sessionId)} ${url} ${options?.line ?? ''}`
      if (pendingOpens.has(key)) return
      const stop = ctx.sidebarRight.mounted.subscribe(() => {
        if (ctx.sidebarRight.mounted.getSnapshot() !== sessionId) return
        pendingOpens.delete(key)
        stop()
        open()
      })
      pendingOpens.set(key, stop)
      try {
        ctx.uiWorkspace.openSession(sessionId)
      } catch (error) {
        pendingOpens.delete(key)
        stop()
        throw error
      }
    },
    openSession: (sessionId) => { ctx.uiWorkspace.openSession(sessionId) },
  }
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => face,
  }, AgentFlowPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 30,
    label: () => t('panel.title'),
    locale: NS,
  }, AgentFlowPanelIcon))

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: PANEL_ID,
    order: 30,
    locale: NS,
    inject: (sessionId: SessionId): FlowSelectInjected => ({
      hooks: { agentFlow: controller.state },
      refresh: face.load,
      claimFlow: (flow, span) => {
        const actx = ctx.sessions.scope(sessionId)
        if (actx === undefined) return false
        const claim = createFlowClaim(sessionId, flow, {
          token: candidate => t('selector.token', { name: candidate.name }),
          hint: t('selector.hint'),
          emptyInput: t('selector.emptyInput'),
          startFailed: message => t('error.start', { message }),
        }, {
          start: (id, request) => ctx.remote.agentFlows.start(id, request),
          noteStarted: (run) => { controller.noteStarted(run) },
        })
        return beginFlowClaim(actx, claim, span)
      },
      clearFlow: (span) => {
        const actx = ctx.sessions.scope(sessionId)
        if (actx === undefined) return false
        return actx.bail(actx, 'slash/input-consume-token', { guard: { kind: 'span', span } }) === true
      },
      openRuns: () => {
        controller.setView('runs')
        controller.selectRun(undefined)
        ctx.layout.selectPanel(PANEL_ID)
      },
    }),
  }, FlowSelect))

  /* The progress card docks above the composer in every session the run
     touches: the parent that started it and the sessions its nodes opened.
     The session identity arrives through the slot's session scope seat. */
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: PANEL_ID,
    order: 20,
    locale: NS,
    inject: (): FlowProgressInjected => ({
      hooks: { agentFlow: controller.state },
      openRun: (runId) => {
        controller.setView('runs')
        controller.selectRun(runId)
        ctx.layout.selectPanel(PANEL_ID)
      },
      openSession: (target) => { ctx.uiWorkspace.openSession(target) },
      cancelRun: async (parent, runId) => { await controller.cancelRun(parent, runId) },
      stallNoticeMs: options.stallNoticeMs,
    }),
  }, FlowRunProgress))
}

/**
 * Mount this experimental namespace without adding it to the stable API Remotes.
 * @param ctx - client runtime owning the Remote, dictionaries, and slots.
 * @param contribution - generated Agent Flow Remote definitions.
 * @param options - panel options resolved from the plugin's validated Config.
 * @returns disposer joining UI and Remote withdrawal.
 */
export async function mountAgentFlowPanel(
  ctx: ClientContext,
  contribution: TypertRemoteContribution,
  options: FlowPanelOptions,
): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(
    ['remote.agentFlows', 'remote.session', 'slots', 'locale', 'uiWorkspace', 'sidebarRight', 'sessions', 'uiSession',
      'layout', 'conversation'],
    (child) => { registerUi(child, options) },
  )
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await disposeRemote()
    throw error
  }
  return async () => { await ui.dispose(); await disposeRemote() }
}
