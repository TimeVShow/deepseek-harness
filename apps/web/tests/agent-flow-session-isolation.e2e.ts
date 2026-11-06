/**
 * A Session that recorded an Agent Flow run keeps its own history through the
 * shipped Web composition: startup and the New Session button claim a fresh or
 * truly-blank Session instead of the occupied parent, restoring the parent's
 * saved selection opens it directly, and its run stays queryable.
 */

import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-experimental-agent-flow'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./fixtures/agent-flow-session-isolation.overlay.yml', import.meta.url))
const INSTALL_ANCHORS = [
  fileURLToPath(new URL('../../../packages/experimental/agent-flow-profile/package.json', import.meta.url)),
]
const FLOW_PARENT = SessionId('flow-parent')

describe('web e2e: agent-flow session isolation', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let runId: string
  const tripwires: ReturnType<typeof watchConsole>[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, extraInstallAnchors: INSTALL_ANCHORS })
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const handle = await scaffold.ctx.agents.create({
      sessionId: FLOW_PARENT,
      meta: { cwd: scaffold.workspaceCwd },
      agentOptions: scaffold.ctx.agentDefaultModel.currentSelection(),
    })
    await workspace.attachSession(FLOW_PARENT)
    const template = await scaffold.ctx.agentFlows.saveTemplate({ name: 'Deterministic worker' })
    const flow = await scaffold.ctx.agentFlows.saveFlow({
      name: 'Deterministic flow',
      nodes: [
        { kind: 'start', id: 'start' },
        { kind: 'agent', id: 'task', templateId: template.id, instruction: 'finish deterministically' },
        { kind: 'end', id: 'end' },
      ],
      edges: [
        { kind: 'execution', from: 'start', to: 'task' },
        { kind: 'execution', from: 'task', to: 'end' },
      ],
    })
    const started = await scaffold.ctx.agentFlows.start(handle.agent, {
      flowId: flow.id,
      input: 'isolation probe',
      signal: new AbortController().signal,
    })
    runId = String(started.id)
    const deadline = Date.now() + 60_000
    while ((await scaffold.ctx.agentFlows.readRun(started.id)).status !== 'completed') {
      if (Date.now() > deadline) throw new Error('deterministic run did not complete in 60s')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    await handle.dispose()
    expect(scaffold.ctx.get('sessionUsage')?.isOccupied(FLOW_PARENT)).toBe(true)
    browser = await chromium.launch()
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  async function openPage(saved?: SessionId): Promise<Page> {
    const page = await newEnglishPage(browser)
    tripwires.push(watchConsole(page))
    if (saved !== undefined) {
      await page.addInitScript((id) => {
        localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id }))
      }, saved)
    }
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[data-composer-input]').first().waitFor({ timeout: 30_000 })
    return page
  }

  async function selected(page: Page): Promise<string | undefined> {
    return page.evaluate(() => {
      const value = localStorage.getItem('dsh.sessions.current')
      return value === null ? undefined : (JSON.parse(value) as { sessionId?: string }).sessionId
    })
  }

  function members(): string[] {
    return scaffold.ctx.workspaceRegistry.list()[0]!.sessionIds.map(id => String(id)).sort()
  }

  it('never claims the occupied parent for a new conversation and keeps its run queryable', async () => {
    // Startup with no saved selection skips the occupied parent and creates a fresh blank.
    const first = await openPage()
    await expect.poll(async () => {
      const id = await selected(first)
      return id !== undefined && id !== String(FLOW_PARENT)
    }).toBe(true)
    const freshId = (await selected(first))!
    expect(members()).toEqual([String(FLOW_PARENT), freshId])

    // New Session from the header reuses the only truly-blank member.
    await first.getByRole('button', { name: 'New session', exact: true }).first().click()
    await expect.poll(() => selected(first)).toBe(freshId)
    expect(members()).toEqual([String(FLOW_PARENT), freshId])

    // Restoring the parent's saved selection opens its own history without creating anything.
    const history = await openPage(FLOW_PARENT)
    await expect.poll(() => selected(history)).toBe(String(FLOW_PARENT))
    expect(members()).toEqual([String(FLOW_PARENT), freshId])

    // A new conversation from the parent history reuses the other blank, never the parent.
    await history.getByRole('button', { name: 'New session', exact: true }).first().click()
    await expect.poll(() => selected(history)).toBe(freshId)
    expect(members()).toEqual([String(FLOW_PARENT), freshId])

    const runs = await scaffold.ctx.agentFlows.listRuns()
    expect(runs.map(run => [String(run.id), String(run.parentSessionId)])).toEqual([[runId, String(FLOW_PARENT)]])
    for (const tripwire of tripwires) {
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    }
  })
})
