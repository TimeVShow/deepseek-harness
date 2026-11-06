/**
 * The Agent Flow panel: flows with their graph editor, agent templates, and
 * run history for one session.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  AgentTemplate,
  AgentTemplateDraft,
  AgentTemplateId,
  FlowDocument,
  FlowRun,
} from '@deepseek-ai/dsh-experimental-agent-flow/types'
import type { PropsHooks, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { Canvas, type CanvasSelection } from './Canvas.tsx'
import { addAgentNode, addConditionNode, addJoinNode, nextNodeId } from './graph.ts'
import { NS, RUN_PHASE_LABEL_KEYS } from './locales.ts'
import { runPhaseOf } from './run-view.ts'
import { RunResults } from './RunResults.tsx'
import { RUN_STATUS_TONES } from './status.ts'
import { messageOf, problemsOf, type AgentFlowInjected } from './mount.ts'
import type { AgentFlowView } from './controller.ts'
import styles from './AgentFlowPage.module.css'

/** Literal locale keys for views, run statuses, and node statuses. */
const VIEW_KEYS: Readonly<Record<AgentFlowView, 'panel.nav.agents' | 'panel.nav.flows' | 'panel.nav.runs'>> = {
  agents: 'panel.nav.agents',
  flows: 'panel.nav.flows',
  runs: 'panel.nav.runs',
}
/** Props the panel receives: the main-slot owner share, its remote face, and copy. */
export type AgentFlowPageProps =
  PropsRuntime<'main'>
  & PropsLocale<typeof NS>
  & PropsHooks<AgentFlowInjected['hooks']>
  & Omit<AgentFlowInjected, 'hooks'>

/** One template being edited in the Templates tab. */
interface TemplateForm {
  readonly id?: AgentTemplate['id']
  readonly name: string
  readonly persona: string
  readonly provider: string
  readonly model: string
}

const EMPTY_TEMPLATE: TemplateForm = { name: '', persona: '', provider: '', model: '' }

/** Turn one template record into its editable form. */
function formOf(template: AgentTemplate): TemplateForm {
  return {
    id: template.id,
    name: template.name,
    persona: template.persona ?? '',
    provider: template.provider ?? '',
    model: template.model ?? '',
  }
}

/** Build one save request from the form. */
function draftOf(form: TemplateForm): AgentTemplateDraft {
  return {
    ...form.id === undefined ? {} : { id: form.id },
    name: form.name.trim(),
    ...form.persona.trim() === '' ? {} : { persona: form.persona },
    /* The save button is disabled until a model is chosen, so both fields are set. */
    provider: form.provider.trim(),
    model: form.model.trim(),
  }
}

/** The model select's value: the template's route, or `''` while none is chosen. */
function modelKeyOf(form: TemplateForm): string {
  return form.provider === '' || form.model === '' ? '' : `${form.provider}/${form.model}`
}

/** Split one `${provider}/${model}` select value back into the form's two fields. */
function modelFieldsOf(value: string): Pick<TemplateForm, 'provider' | 'model'> {
  const at = value.indexOf('/')
  return { provider: value.slice(0, at), model: value.slice(at + 1) }
}

/** Count the agent nodes in `flows` that reference one agent. */
function referenceCount(flows: readonly FlowDocument[], templateId: AgentTemplate['id']): number {
  let total = 0
  for (const flow of flows) {
    for (const node of flow.nodes) {
      if (node.kind === 'agent' && node.templateId === templateId) total += 1
    }
  }
  return total
}

/**
 * Render the Agent Flow panel.
 * @param props - main-panel owner share, remote face, and localized copy.
 * @returns the panel element.
 */
export function AgentFlowPage({ useAgentFlow, t, ...face }: AgentFlowPageProps): ReactNode {
  const snapshot = useAgentFlow(state => state)
  const { load } = face
  const [selection, setSelection] = useState<CanvasSelection>(undefined)
  const [problems, setProblems] = useState<readonly string[]>([])
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [templateForm, setTemplateForm] = useState<TemplateForm>(EMPTY_TEMPLATE)
  const [savingTemplate, setSavingTemplate] = useState(false)
  const [entryTemplateId, setEntryTemplateId] = useState<AgentTemplateId | ''>('')
  /** Identity of the form being edited; field edits do not change it. */
  const formSeq = useRef(0)
  const savingTemplateRef = useRef(false)

  /** Replace the edited template and start a new form identity. */
  const openTemplate = (form: TemplateForm): void => {
    formSeq.current += 1
    setTemplateForm(form)
  }

  useEffect(() => { void load() }, [load])
  useEffect(() => { setProblems([]) }, [snapshot.selectedFlowId])
  /* The chosen entry agent can disappear while this selector is hidden on
     another tab. Clearing the stale id keeps creation from submitting one the
     roster no longer has, and returns the choice to the user. */
  useEffect(() => {
    if (entryTemplateId === '') return
    if (snapshot.templates.some(template => template.id === entryTemplateId)) return
    setEntryTemplateId('')
  }, [entryTemplateId, snapshot.templates])

  const run = async (action: () => Promise<void>, key: 'error.load' | 'error.save' | 'error.cancel' | 'error.conclude'): Promise<void> => {
    setProblems([])
    setNotice(undefined)
    try {
      await action()
    } catch (error) {
      const details = problemsOf(error)
      if (details.length === 0) setNotice(t(key, { message: messageOf(error) }))
      else setProblems(details)
    }
  }

  const header = (
    <header className={styles.header}>
      <h1 className={styles.title}>{t('panel.title')}</h1>
      <nav className={styles.tabs}>
        {(['agents', 'flows', 'runs'] as readonly AgentFlowView[]).map(view => (
          <button
            type="button"
            key={view}
            className={styles.tab}
            data-active={snapshot.view === view}
            onClick={() => { face.setView(view) }}
          >
            {t(VIEW_KEYS[view])}
          </button>
        ))}
      </nav>
      <Button variant="ghost" size="sm" onClick={() => { void run(load, 'error.load') }}>
        {t('common.refresh')}
      </Button>
    </header>
  )

  const banner = (
    <>
      {snapshot.status === 'loading' ? <p className={styles.hint}>{t('common.load')}</p> : null}
      {snapshot.error === undefined ? null : <p className={styles.error}>{t('error.load', { message: snapshot.error })}</p>}
      {notice === undefined ? null : <p className={styles.error}>{notice}</p>}
      {problems.length === 0 ? null : (
        <div className={styles.problems}>
          <strong>{t('flows.problems')}</strong>
          <ul>{problems.map(problem => <li key={problem}>{problem}</li>)}</ul>
        </div>
      )}
    </>
  )

  if (snapshot.view === 'agents') {
    const modelKey = modelKeyOf(templateForm)
    const knownModels = new Set(snapshot.modelGroups.flatMap(group => group.models.map(model => `${model.provider}/${model.model}`)))
    /* A saved route the current catalog no longer offers stays selectable, so
       the form displays it and saving keeps it instead of rewriting the agent. */
    const pinned = modelKey !== '' && !knownModels.has(modelKey) ? modelKey : undefined
    return (
      <div className={styles.page}>
        {header}
        {banner}
        <div className={styles.split}>
          <section className={styles.list}>
            <Button variant="primary" onClick={() => { openTemplate(EMPTY_TEMPLATE) }}>
              {t('agents.create')}
            </Button>
            {snapshot.templates.length === 0 ? (
              <div className={styles.empty}>
                <p className={styles.hint}>{t('agents.empty')}</p>
                <Button variant="primary" onClick={() => { openTemplate(EMPTY_TEMPLATE) }}>
                  {t('agents.emptyAction')}
                </Button>
              </div>
            ) : null}
            {snapshot.templates.map(template => (
              <button
                type="button"
                key={template.id}
                className={styles.row}
                onClick={() => { openTemplate(formOf(template)) }}
              >
                <span className={styles.rowTitle}>{template.name}</span>
                <span className={styles.rowMeta}>
                  {template.model ?? t('common.none')}
                  {' · '}
                  {t('agents.referenced', { count: referenceCount(snapshot.flows, template.id) })}
                </span>
              </button>
            ))}
          </section>
          <section className={styles.detail}>
            <h2 className={styles.formTitle}>{t('agents.heading')}</h2>
            <label className={styles.field}>
              <span>{t('common.name')}</span>
              <input value={templateForm.name} onChange={(event) => { setTemplateForm({ ...templateForm, name: event.target.value }) }} />
            </label>
            <label className={styles.field}>
              <span>{t('agents.persona')}</span>
              <textarea
                rows={4}
                value={templateForm.persona}
                onChange={(event) => { setTemplateForm({ ...templateForm, persona: event.target.value }) }}
              />
            </label>
            <label className={styles.field}>
              <span>{t('agents.model')}</span>
              <select
                value={modelKey}
                onChange={(event) => { setTemplateForm({ ...templateForm, ...modelFieldsOf(event.target.value) }) }}
              >
                <option value="" disabled>{t('agents.modelPlaceholder')}</option>
                {pinned === undefined ? null : (
                  <option value={pinned}>{t('agents.modelPinned', { model: pinned })}</option>
                )}
                {snapshot.modelGroups.map(group => (
                  <optgroup key={group.provider} label={group.providerLabel}>
                    {group.models.map(model => (
                      <option key={model.model} value={`${model.provider}/${model.model}`}>{model.label}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            {snapshot.modelGroups.length === 0 ? <span className={styles.hint}>{t('agents.modelEmpty')}</span> : null}
            <div className={styles.actions}>
              <Button
                variant="primary"
                disabled={modelKey === '' || savingTemplate}
                onClick={() => {
                  if (savingTemplateRef.current) return
                  savingTemplateRef.current = true
                  setSavingTemplate(true)
                  const seq = formSeq.current
                  void run(async () => {
                    try {
                      const saved = await face.saveTemplate(draftOf(templateForm))
                      /* Adopt the assigned id without discarding edits typed
                         while the save was in flight. */
                      if (formSeq.current === seq) setTemplateForm(current => ({ ...current, id: saved.id }))
                      setNotice(t('flows.saved'))
                    } finally {
                      savingTemplateRef.current = false
                      setSavingTemplate(false)
                    }
                  }, 'error.save')
                }}
              >
                {t('common.save')}
              </Button>
              {templateForm.id === undefined ? null : (
                <Button
                  variant="outline"
                  className={styles.danger}
                  onClick={() => {
                    void run(async () => {
                      await face.deleteTemplate(templateForm.id as AgentTemplate['id'])
                      openTemplate(EMPTY_TEMPLATE)
                    }, 'error.save')
                  }}
                >
                  {t('common.delete')}
                </Button>
              )}
            </div>
          </section>
        </div>
      </div>
    )
  }

  if (snapshot.view === 'runs') {
    /* Cancelling and ending a clarification both go through the run's parent
       session; once that session no longer owns a live Agent either call would
       fail, so hide both. */
    const drivable = (stored: FlowRun): boolean =>
      stored.status === 'running'
      && snapshot.sessions.some(session => session.id === stored.parentSessionId && session.live)
    const cancel = (stored: FlowRun): void => {
      void run(async () => { await face.cancelRun(stored.parentSessionId, stored.id) }, 'error.cancel')
    }
    const conclude = (stored: FlowRun): void => {
      void run(async () => { await face.concludeConversation(stored.parentSessionId, stored.id) }, 'error.conclude')
    }
    const selected = snapshot.runs.find(candidate => candidate.id === snapshot.selectedRunId)
    if (selected !== undefined) {
      const conversing = selected.nodeRuns.some(entry => entry.status === 'conversing')
      return (
        <div className={styles.page}>
          {header}
          {banner}
          <RunResults
            run={selected}
            templates={snapshot.templates}
            sessions={snapshot.sessions}
            canCancel={drivable(selected)}
            canConclude={drivable(selected) && conversing}
            onBack={() => { face.selectRun(undefined) }}
            onCancel={() => { cancel(selected) }}
            onConclude={() => { conclude(selected) }}
            onOpenSession={(sessionId) => { face.openSession(sessionId) }}
            onOpenFile={(sessionId, path, options) => { face.openFile(sessionId, path, options) }}
            t={t}
          />
        </div>
      )
    }
    return (
      <div className={styles.page}>
        {header}
        {banner}
        <section className={styles.list}>
          <h2 className={styles.formTitle}>{t('runs.heading')}</h2>
          {snapshot.runs.length === 0 ? <p className={styles.hint}>{t('runs.empty')}</p> : null}
          {snapshot.runs.map(stored => (
            <article className={styles.run} key={stored.id}>
              <button type="button" className={styles.row} onClick={() => { face.selectRun(stored.id) }}>
                <span className={styles.rowTitle}>{stored.snapshot.name}</span>
                <span className={styles.rowMeta}>{stored.input}</span>
                <Tag tone={RUN_STATUS_TONES[runPhaseOf(stored)]}>{t(RUN_PHASE_LABEL_KEYS[runPhaseOf(stored)])}</Tag>
              </button>
              {drivable(stored) ? (
                <Button variant="outline" size="sm" onClick={() => { cancel(stored) }}>
                  {t('runs.cancel')}
                </Button>
              ) : null}
            </article>
          ))}
        </section>
      </div>
    )
  }

  const draft = snapshot.draft
  if (draft !== undefined) {
    const addKind = (kind: 'agent' | 'join' | 'condition'): (void) => {
      const existing = snapshot.templates[0]?.id
      if (kind !== 'agent' || existing !== undefined) {
        const templateId = existing as AgentTemplate['id']
        const id = nextNodeId(draft, kind)
        face.updateDraft((current) => {
          if (kind === 'agent') addAgentNode(current, templateId)
          else if (kind === 'join') addJoinNode(current)
          else addConditionNode(current)
        })
        setSelection({ kind: 'node', id })
        return
      }
      /* An agent node needs a template; create the starter one first. */
      void run(async () => {
        const template = await face.saveTemplate({ name: 'Starter agent', persona: 'You complete one step of a fixed workflow.' })
        const id = nextNodeId(draft, 'agent')
        face.updateDraft((current) => { addAgentNode(current, template.id) })
        setSelection({ kind: 'node', id })
      }, 'error.save')
    }
    return (
      <div className={styles.page}>
        {header}
        {banner}
        <div className={styles.editorBar}>
          <Button variant="ghost" size="sm" onClick={() => { face.selectFlow(undefined) }}>
            {t('flows.backToList')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => { addKind('agent') }}>
            {t('canvas.add.agent')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => { addKind('join') }}>
            {t('canvas.add.join')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => { addKind('condition') }}>
            {t('canvas.add.condition')}
          </Button>
          <input
            className={styles.name}
            value={draft.name}
            onChange={(event) => {
              const name = event.target.value
              face.updateDraft((current) => { current.name = name })
            }}
          />
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              void run(async () => {
                await face.saveFlow(draft)
                setNotice(t('flows.saved'))
              }, 'error.save')
            }}
          >
            {t('flows.save')}
          </Button>
        </div>
        <p className={styles.hint}>{t('canvas.hint')}</p>
        <Canvas
          document={draft}
          selection={selection}
          onSelect={setSelection}
          onMutate={face.updateDraft}
          t={t}
          templates={snapshot.templates}
        />
      </div>
    )
  }

  return (
    <div className={styles.page}>
      {header}
      {banner}
      <section className={styles.list}>
        {snapshot.templates.length === 0 ? null : (
          <label className={styles.field}>
            <span>{t('flows.entryAgent')}</span>
            <select
              aria-label={t('flows.entryAgent')}
              value={entryTemplateId}
              onChange={(event) => { setEntryTemplateId(event.target.value as AgentTemplateId) }}
            >
              <option value="" disabled>{t('flows.entryAgentPlaceholder')}</option>
              {snapshot.templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
            </select>
          </label>
        )}
        <Button
          variant="primary"
          disabled={snapshot.templates.length > 0
            && !snapshot.templates.some(template => template.id === entryTemplateId)}
          onClick={() => {
            /* Only an id the roster still lists reaches creation: a template
               deleted while this tab was hidden leaves no entry agent to send,
               and no templates means the neutral Starter. */
            const chosen = snapshot.templates.find(template => template.id === entryTemplateId)?.id
            void run(async () => {
              await face.createFlow(chosen)
            }, 'error.save')
          }}
        >
          {t('flows.create')}
        </Button>
        {snapshot.flows.length === 0 ? <p className={styles.hint}>{t('flows.empty')}</p> : null}
        {snapshot.flows.map(flow => (
          <article className={styles.flow} key={flow.id}>
            <button type="button" className={styles.row} onClick={() => { face.selectFlow(flow.id) }}>
              <span className={styles.rowTitle}>{flow.name}</span>
              <span className={styles.rowMeta}>
                {t('flows.nodes', { count: flow.nodes.length })}
              </span>
            </button>
            <Button
              variant="outline"
              size="sm"
              className={styles.danger}
              onClick={() => {
                void run(async () => { await face.deleteFlow(flow.id) }, 'error.save')
              }}
            >
              {t('common.delete')}
            </Button>
          </article>
        ))}
      </section>
    </div>
  )
}
