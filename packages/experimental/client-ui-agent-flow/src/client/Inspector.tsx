/**
 * Property inspector for the selected node or edge: identifiers, agent
 * template and instruction, input summaries, edge kinds, and routing words. Every edit
 * mutates the draft through the callback the page owns.
 */

import type { ReactNode } from 'react'
import type {
  AgentTemplate,
  FlowDocument,
  FlowEdge,
  FlowNode,
} from '@deepseek-ai/dsh-experimental-agent-flow/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { canSetEdgeKind, isRoutableEdge, missingInteractiveRequest, setEdgeKind } from './graph.ts'
import type { CanvasSelection } from './Canvas.tsx'
import type { NS } from './locales.ts'
import styles from './AgentFlowPage.module.css'

/** Inputs the inspector needs besides the draft it edits. */
export interface InspectorProps extends PropsLocale<typeof NS> {
  readonly document: FlowDocument
  readonly selection: CanvasSelection
  readonly onMutate: (mutate: (draft: FlowDocument) => void) => void
  readonly onDeleteNode: (id: string) => void
  readonly onDeleteEdge: (index: number) => void
  readonly templates: readonly AgentTemplate[]
}

/** Apply one edit to the selected node, re-narrowing the live draft. */
function editNode<K extends FlowNode['kind']>(
  draft: FlowDocument,
  id: string,
  kind: K,
  mutate: (node: Extract<FlowNode, { kind: K }>) => void,
): void {
  const target = draft.nodes.find(candidate => candidate.id === id && candidate.kind === kind)
  /* v8 ignore next 2 -- the draft can change between render and commit; the rendered node has this kind. */
  if (target === undefined) return
  mutate(target as Extract<FlowNode, { kind: K }>)
}

/** Apply one edit to the selected edge in the live draft. */
function editEdge(draft: FlowDocument, index: number, mutate: (edge: FlowEdge) => void): void {
  const target = draft.edges[index]
  /* v8 ignore next 2 -- the draft can change between render and commit; the selection points at a live edge. */
  if (target === undefined) return
  mutate(target)
}

/**
 * Render the property form for the current selection.
 * @param props - draft, selection, mutation callbacks, templates, and copy.
 * @returns the inspector body.
 */
export function Inspector({
  document,
  selection,
  onMutate,
  onDeleteNode,
  onDeleteEdge,
  templates,
  t,
}: InspectorProps): ReactNode {
  if (selection === undefined) return <p className={styles.hint}>{t('inspect.empty')}</p>

  if (selection.kind === 'edge') {
    const edge = document.edges[selection.index]
    if (edge === undefined) return <p className={styles.hint}>{t('inspect.empty')}</p>
    const routable = isRoutableEdge(document, selection.index)
    const fromStart = document.nodes.find(node => node.id === edge.from)?.kind === 'start'
    const update = (result: string | undefined): (void) => {
      onMutate((draft) => {
        editEdge(draft, selection.index, (edge) => {
          if (result === undefined) delete edge.result
          else edge.result = result
        })
      })
    }
    return (
      <div className={styles.form}>
        <h3 className={styles.formTitle}>{t('inspect.edgeTitle')}</h3>
        <p className={styles.hint}>{edge.from} → {edge.to}</p>
        <label className={styles.field}>
          <span>{t('inspect.edgeKind')}</span>
          <select
            value={edge.kind}
            onChange={(event) => {
              const kind = event.target.value === 'input' ? 'input' : 'execution'
              onMutate((draft) => { setEdgeKind(draft, selection.index, kind) })
            }}
          >
            <option value="execution" disabled={!canSetEdgeKind(document, selection.index, 'execution')}>
              {t('edge.execution')}
            </option>
            <option value="input" disabled={!canSetEdgeKind(document, selection.index, 'input')}>
              {t('edge.input')}
            </option>
          </select>
        </label>
        <p className={styles.hint}>
          {t(edge.kind === 'execution'
            ? fromStart ? 'inspect.executionStartHint' : 'inspect.executionHint'
            : fromStart ? 'inspect.inputStartHint' : 'inspect.inputHint')}
        </p>
        {!routable ? null : (
          <>
            <label className={styles.field}>
              <span>{t('inspect.result')}</span>
              <input
                value={edge.result ?? ''}
                onChange={(event) => {
                  const word = event.target.value.trim()
                  update(word === '' ? undefined : word)
                }}
              />
            </label>
            <p className={styles.hint}>{t('inspect.resultHint')}</p>
          </>
        )}
        <Button variant="outline" size="sm" className={styles.danger} onClick={() => { onDeleteEdge(selection.index) }}>
          {t('inspect.deleteEdge')}
        </Button>
      </div>
    )
  }

  const node: FlowNode | undefined = document.nodes.find(candidate => candidate.id === selection.id)
  if (node === undefined) return <p className={styles.hint}>{t('inspect.empty')}</p>
  const rename = (title: string): (void) => {
    onMutate((draft) => {
      editNode(draft, node.id, node.kind, (target) => { target.title = title === '' ? undefined : title })
    })
  }
  return (
    <div className={styles.form}>
      <h3 className={styles.formTitle}>{t('inspect.title')}</h3>
      <p className={styles.hint}>{t(`node.${node.kind}`)}</p>
      <label className={styles.field}>
        <span>{t('inspect.id')}</span>
        <input value={node.id} readOnly />
      </label>
      <label className={styles.field}>
        <span>{t('inspect.title.label')}</span>
        <input value={node.title ?? ''} onChange={(event) => { rename(event.target.value) }} />
      </label>
      {node.kind === 'agent' ? (
        <>
          <label className={styles.field}>
            <span>{t('inspect.template')}</span>
            <select
              value={node.templateId}
              onChange={(event) => {
                const templateId = event.target.value as AgentTemplate['id']
                onMutate((draft) => { editNode(draft, node.id, 'agent', (target) => { target.templateId = templateId }) })
              }}
            >
              {templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
            </select>
          </label>
          <label className={styles.field}>
            <span>{t('inspect.instruction')}</span>
            <textarea
              rows={6}
              value={node.instruction}
              onChange={(event) => {
                const instruction = event.target.value
                onMutate((draft) => { editNode(draft, node.id, 'agent', (target) => { target.instruction = instruction }) })
              }}
            />
          </label>
          <p className={styles.hint}>{t('inspect.instructionHint')}</p>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={node.interactive === true}
              onChange={(event) => {
                const checked = event.target.checked
                onMutate((draft) => {
                  /* One flow carries one conversational node, so choosing this
                     node clears whichever other node held the mark. */
                  for (const candidate of draft.nodes) {
                    if (candidate.kind === 'agent') delete candidate.interactive
                  }
                  if (checked) editNode(draft, node.id, 'agent', (target) => { target.interactive = true })
                })
              }}
            />
            <span>{t('inspect.interactive')}</span>
          </label>
          <p className={styles.hint}>{t('inspect.interactiveHint')}</p>
          {node.interactive === true && missingInteractiveRequest(document)
            ? <p className={styles.warning}>{t('inspect.interactiveNoRequest')}</p>
            : null}
          <h3 className={styles.formTitle}>{t('inspect.inputs')}</h3>
          <p className={styles.hint}>{t('inspect.inputsHint')}</p>
          <InputSummary document={document} nodeId={node.id} templates={templates} t={t} />
          <p className={styles.hint}>{t('inspect.executionAllHint')}</p>
        </>
      ) : null}
      {node.kind === 'condition' ? <p className={styles.hint}>{t('inspect.conditionHint')}</p> : null}
      {node.kind === 'join' ? <p className={styles.hint}>{t('inspect.joinHint')}</p> : null}
      <Button variant="outline" size="sm" className={styles.danger} onClick={() => { onDeleteNode(node.id) }}>
        {t('inspect.deleteNode')}
      </Button>
    </div>
  )
}

/** Read-only sources selected through the graph's execution and input edges. */
function InputSummary({ document, nodeId, templates, t }: Pick<InspectorProps, 'document' | 'templates' | 't'> & {
  readonly nodeId: string
}): ReactNode {
  const sources = document.edges.filter(edge => edge.to === nodeId
    && (edge.kind === 'input' || document.nodes.find(node => node.id === edge.from)?.kind !== 'start'))
  if (sources.length === 0) return <p className={styles.hint}>{t('inspect.inputsEmpty')}</p>
  return (
    <ul className={styles.inputs}>
      {sources.map((edge, index) => {
        const source = document.nodes.find(node => node.id === edge.from)
        const title = source?.kind === 'start'
          ? t('inspect.userInput')
          : source?.title ?? (source?.kind === 'agent'
            ? templates.find(template => template.id === source.templateId)?.name : undefined) ?? edge.from
        return <li key={index}>{title} · {t(edge.kind === 'input' ? 'edge.input' : 'edge.execution')}</li>
      })}
    </ul>
  )
}
