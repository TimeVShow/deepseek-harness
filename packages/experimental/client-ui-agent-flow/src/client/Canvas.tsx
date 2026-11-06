/**
 * The graph canvas: flow documents rendered as draggable nodes and connectable
 * edges, with the property inspector beside them. All document mutation flows
 * back through `onMutate`; positions are applied locally while dragging and
 * persisted on drop.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Background,
  BaseEdge,
  Controls,
  getBezierPath,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type Node,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react'
import type { FlowDocument, FlowNode } from '@deepseek-ai/dsh-experimental-agent-flow/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { autoLayout, connectNodes, edgeKey, removeEdge, removeNode, type Point } from './graph.ts'
import { Inspector, type InspectorProps } from './Inspector.tsx'
import type { NS } from './locales.ts'
import styles from './AgentFlowPage.module.css'

/** Data one canvas node carries into its card. */
interface FlowNodeData extends Record<string, unknown> {
  readonly kind: FlowNode['kind']
  readonly label: string
  readonly title: string
  readonly subtitle?: string
  /** Whether this is the node the user talks to; the card marks it visibly. */
  readonly interactive: boolean
  /** Localized mark naming the conversational role, absent on every other node. */
  readonly badge?: string
}

type FlowCanvasNode = Node<FlowNodeData, 'flow'>

/** One node card: kind badge, display name, and the handles the kind allows. */
function FlowNodeCard({ data }: NodeProps<FlowCanvasNode>): ReactNode {
  return (
    <div className={styles.node} data-kind={data.kind} data-interactive={data.interactive || undefined}>
      {data.kind === 'start' ? null : <Handle type="target" position={Position.Left} />}
      <span className={styles.nodeKind}>{data.label}</span>
      {data.badge === undefined ? null : <span className={styles.nodeBadge}>{data.badge}</span>}
      <span className={styles.nodeTitle}>{data.title}</span>
      {data.subtitle === undefined ? null : <span className={styles.nodeSubtitle}>{data.subtitle}</span>}
      {data.kind === 'end' ? null : <Handle type="source" position={Position.Right} />}
    </div>
  )
}

const nodeTypes: NodeTypes = { flow: FlowNodeCard }

type FlowCanvasEdge = Edge<{ readonly parallel: boolean }>

/** Separate a start pair's input curve so both connections remain selectable. */
function FlowConnection({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data,
  label, markerEnd, style,
}: EdgeProps<FlowCanvasEdge>): ReactNode {
  let [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  if (data?.parallel === true) {
    const reach = Math.max(40, Math.abs(targetX - sourceX) / 2)
    path = `M ${sourceX},${sourceY} C ${sourceX + reach},${sourceY + 48} ${targetX - reach},${targetY + 48} ${targetX},${targetY}`
    labelX = (sourceX + targetX) / 2
    labelY = (sourceY + targetY) / 2 + 36
  }
  return <BaseEdge
    id={id}
    path={path}
    label={label}
    labelX={labelX}
    labelY={labelY}
    labelStyle={{ fill: 'var(--dsw-alias-label-primary)' }}
    labelBgStyle={{ fill: 'var(--dsw-alias-bg-module-platform)' }}
    /* v8 ignore start -- this document always gives every edge both an arrow and a stroke. */
    {...markerEnd === undefined ? {} : { markerEnd }}
    {...style === undefined ? {} : { style }}
    /* v8 ignore stop */
    interactionWidth={24}
  />
}

const edgeTypes: EdgeTypes = { flow: FlowConnection }

/** Selection the inspector edits. */
export type CanvasSelection =
  | { readonly kind: 'node'; readonly id: string }
  | { readonly kind: 'edge'; readonly index: number }
  | undefined

/** Inputs the canvas needs beyond the document it edits. */
export interface CanvasProps extends PropsLocale<typeof NS> {
  readonly document: FlowDocument
  readonly selection: CanvasSelection
  readonly onSelect: (selection: CanvasSelection) => void
  readonly onMutate: (mutate: (draft: FlowDocument) => void) => void
  readonly templates: InspectorProps['templates']
}

/**
 * Render the canvas and inspector for one document.
 * @param props - document, selection, mutation callback, and localized copy.
 * @returns the canvas area.
 */
export function Canvas({ document, selection, onSelect, onMutate, templates, t }: CanvasProps): ReactNode {
  const layout = useMemo(() => autoLayout(document), [document])
  const [dragged, setDragged] = useState<Record<string, Point>>({})

  // A document switch starts from the stored layout, not the previous drag state.
  useEffect(() => { setDragged({}) }, [document.id])

  const nodes = useMemo<FlowCanvasNode[]>(() => document.nodes.map((node) => {
    const interactive = node.kind === 'agent' && node.interactive === true
    return {
      id: node.id,
      type: 'flow',
      /* v8 ignore next 1 -- autoLayout places every node of the document. */
      position: dragged[node.id] ?? layout.get(node.id) ?? { x: 0, y: 0 },
      data: {
        kind: node.kind,
        label: t(`node.${node.kind}`),
        title: node.title ?? node.id,
        interactive,
        ...node.kind === 'agent' ? { subtitle: node.instruction.slice(0, 40) } : {},
        ...interactive ? { badge: t('node.interactive') } : {},
      },
      selected: selection?.kind === 'node' && selection.id === node.id,
    }
  }), [document, dragged, layout, selection, t])

  const edges = useMemo<FlowCanvasEdge[]>(() => document.edges.map((edge, index) => {
    const input = edge.kind === 'input'
    const fromStart = document.nodes.find(node => node.id === edge.from)?.kind === 'start'
    const label = input && fromStart ? t('inspect.userInput') : t(input ? 'edge.input' : 'edge.execution')
    const selected = selection?.kind === 'edge' && selection.index === index
    const color = selected ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)'
    return {
      id: edgeKey(index),
      type: 'flow',
      source: edge.from,
      target: edge.to,
      label: edge.result === undefined ? label : `${label} · ${edge.result}`,
      ariaLabel: t('canvas.edgeAria', { kind: label, from: edge.from, to: edge.to }),
      data: { parallel: input && fromStart && document.edges.some(other =>
        other.kind === 'execution' && other.from === edge.from && other.to === edge.to) },
      markerEnd: { type: MarkerType.ArrowClosed, color },
      style: { stroke: color, strokeWidth: selected ? 2.5 : 2, ...input ? { strokeDasharray: '7 5' } : {} },
      selected,
    }
  }), [document, selection, t])

  const connect = (connection: Connection): (void) => {
    let index: number | undefined
    onMutate((draft) => {
      if (connectNodes(draft, connection.source, connection.target)) index = draft.edges.length - 1
    })
    if (index !== undefined) onSelect({ kind: 'edge', index })
  }

  return (
    <div className={styles.canvasRow}>
      <div className={styles.canvasArea}>
        <div className={styles.legend} aria-label={t('canvas.legend')}>
          <span><span className={styles.legendLine} aria-hidden />{t('edge.execution')}</span>
          <span><span className={styles.legendLine} data-kind="input" aria-hidden />{t('edge.input')}</span>
        </div>
        <div className={styles.canvas}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onConnect={connect}
            onNodeClick={(_event, node) => { onSelect({ kind: 'node', id: node.id }) }}
            onEdgeClick={(_event, edge) => { onSelect({ kind: 'edge', index: Number(edge.id.slice(1)) }) }}
            onPaneClick={() => { onSelect(undefined) }}
            onNodeDrag={(_event, node) => { setDragged(current => ({ ...current, [node.id]: node.position })) }}
            onNodeDragStop={(_event, node) => {
              onMutate((draft) => {
                const target = draft.nodes.find(candidate => candidate.id === node.id)
                if (target !== undefined) target.position = node.position
              })
            }}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      </div>
      <aside className={styles.inspector}>
        <Inspector
          document={document}
          selection={selection}
          onMutate={onMutate}
          onDeleteNode={(id) => { onMutate((draft) => { removeNode(draft, id) }); onSelect(undefined) }}
          onDeleteEdge={(index) => { onMutate((draft) => { removeEdge(draft, index) }); onSelect(undefined) }}
          templates={templates}
          t={t}
        />
      </aside>
    </div>
  )
}
