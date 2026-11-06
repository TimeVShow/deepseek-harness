/** Snapshot-only tool driving saved graphs through the real service, loop, and spawn provider. */

import { basename, join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AgentTemplateId, FlowId } from '@deepseek-ai/dsh-experimental-agent-flow'
import type { FlowRun, FlowRunId } from '@deepseek-ai/dsh-experimental-agent-flow'

export const name = 'snapshot-agent-flow'
export const inject = ['tools', 'agents', 'agentFlows']

/** Install one test tool; its caller remains the real model-invoked parent Agent. */
export function apply(ctx: Context): void {
  const prompts = new Map<string, string>()
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user' || prompts.has(session.id)) return
    prompts.set(session.id, event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
  })
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'snapshot_run_flow',
    description: 'Run the saved design, implementation, and review handoff fixture.',
    parameters: { request: { type: 'string', required: true } },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { runId: { type: 'string', required: true }, summary: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
      presentationMeta: (_args, value) => ({ runId: value.runId }),
    },
    execute: async (args, exec) => {
      const parent = exec.agent
      if (parent === undefined || ctx.agents.requireInitiator() !== parent) throw new Error('snapshot flow requires the exact calling Agent')
      const template = await ctx.agentFlows.saveTemplate({ id: AgentTemplateId('snapshot-worker'), name: 'Snapshot worker' })
      const flow = await ctx.agentFlows.saveFlow({
        id: FlowId('snapshot-handoff'), name: 'Snapshot handoff', maxIterations: 3,
        nodes: [
          { kind: 'start', id: 'start' },
          { kind: 'agent', id: 'design', templateId: template.id, instruction: 'Prepare the design and hand off DESIGN_READY.' },
          { kind: 'agent', id: 'implement', templateId: template.id, instruction: 'Implement the design and hand off IMPLEMENTATION_READY.' },
          { kind: 'agent', id: 'review', templateId: template.id, instruction: 'Review the implementation against the design and hand off REVIEW_APPROVED.' },
          { kind: 'end', id: 'end' },
        ],
        edges: [
          { kind: 'execution', from: 'start', to: 'design' },
          { kind: 'execution', from: 'design', to: 'implement' },
          { kind: 'execution', from: 'implement', to: 'review' },
          { kind: 'execution', from: 'review', to: 'end' },
          { kind: 'input', from: 'start', to: 'design' },
          { kind: 'input', from: 'design', to: 'review' },
        ],
      })
      const completed = Promise.withResolvers<FlowRun>()
      let id: FlowRunId | undefined
      const read = (): void => {
        if (id === undefined) return
        void ctx.agentFlows.readRun(id).then((run) => {
          if (run.status !== 'running') completed.resolve(run)
        }, completed.reject)
      }
      const stop = ctx.on('domain/changed', (change) => {
        if (change.domain === 'agent_flow' && change.table === 'runs' && change.key === id) read()
      })
      const abort = (): void => { completed.reject(new Error('snapshot flow caller cancelled')) }
      exec.signal.addEventListener('abort', abort, { once: true })
      try {
        const started = await ctx.agentFlows.start(parent, { flowId: flow.id, input: args.request, signal: exec.signal })
        id = started.id
        read()
        const run = await completed.promise
        if (run.status !== 'completed') throw new Error(`snapshot flow failed: ${run.error ?? run.status}`)
        const evidence = await Promise.all(run.nodeRuns.filter(node => node.agentSessionId !== undefined).map(async (node) => {
          const prompt = prompts.get(node.agentSessionId!)
          if (prompt === undefined) throw new Error(`snapshot flow did not observe ${node.nodeId}'s logged input`)
          return {
            node: node.nodeId, iteration: node.iteration, status: node.status,
            inputs: node.inputs, userInput: node.userInput,
            requestSection: prompt.includes('## User request\n'),
            originalRequest: prompt.includes(args.request),
            handoffs: ['design', 'implement', 'review'].filter(source => prompt.includes(`## Handoff from ${source}\n`)),
            files: await Promise.all((node.files ?? []).map(async file => ({ name: basename(file), content: await readFile(file, 'utf8') }))),
          }
        }))
        const cwd = parent.session.header.cwd
        if (cwd === undefined) throw new Error('snapshot flow parent has no cwd')
        await writeFile(join(cwd, 'flow-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
        return { runId: String(run.id), summary: 'Completed design → implementation → review; verified logged inputs and persisted execution references.' }
      } finally {
        stop()
        exec.signal.removeEventListener('abort', abort)
      }
    },
  })))
}
