/**
 * L1 Agent Flow acceptance: identity matrix over the shipped Web composition.
 * Real Host, Remote, Session, flow scheduler, and agent loop run unchanged;
 * only the DeepSeek wire is scripted (fixtures/scripted-llm.js), so runs start
 * from the real composer flow picker, and the assertions read durable run
 * records, Session identity, workspace membership, and node handoffs.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { FlowId, FlowRun } from '@deepseek-ai/dsh-experimental-agent-flow'
import type {} from '@deepseek-ai/dsh-experimental-agent-flow'
import { launchWebScaffold, acknowledgeReloadConnectionLoss, readPersistedEvents, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

declare global {
  interface Window {
    /** Stages the E17 activity check recorded from the progress card's DOM. */
    __flowStages?: string[]
  }
}

const OVERLAY = fileURLToPath(new URL('./fixtures/agent-flow-scripted.overlay.yml', import.meta.url))
const INSTALL_ANCHORS = [
  fileURLToPath(new URL('../../../packages/experimental/agent-flow-profile/package.json', import.meta.url)),
]

describe('web e2e: agent-flow L1 identity', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let attachSession: (id: SessionId) => Promise<void>
  let primaryWorkspace: string
  let flowA: FlowId
  let flowB: FlowId
  let flowC: FlowId
  let flowD: FlowId
  let flowE: FlowId
  let flowF: FlowId
  const pages: Page[] = []
  let tripwires: ReturnType<typeof watchConsole>[] = []
  const hostFailures: unknown[] = []
  const onHostFailure = (reason: unknown): void => {
    hostFailures.push(reason)
    console.error('HOST-UNHANDLED', reason instanceof Error ? reason.stack ?? reason.message : String(reason))
  }

  beforeAll(async () => {
    // Unhandled rejections cover async faults; a synchronous throw inside an
    // event listener (an abort dispatch, for example) surfaces as an uncaught
    // exception instead, so both channels must fail the tests.
    process.on('unhandledRejection', onHostFailure)
    process.on('uncaughtException', onHostFailure)
    scaffold = await launchWebScaffold({
      extraOverlayPath: OVERLAY,
      extraInstallAnchors: INSTALL_ANCHORS,
      deepSeekMissingCredential: true,
      // A HOME-based workspace sits outside the sandbox's platform temp grants,
      // so E26 observes a real workspace-write denial on an upstream delivery.
      workspaceParentDirectory: homedir(),
    })
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    primaryWorkspace = String(workspace.id)
    attachSession = async (id) => { await workspace.attachSession(id) }
    const template = async (name: string, role: string, model: string) =>
      await scaffold.ctx.agentFlows.saveTemplate({
        name,
        persona: `ROLE:${role} Act as the ${role} of this workflow.`,
        provider: 'deepseek-official',
        model,
      })
    const writer = await template('Brief writer', 'writer', 'deepseek-v4-pro')
    const checker = await template('Brief checker', 'checker', 'deepseek-flash')
    const design = await template('Designer', 'design', 'deepseek-v4-pro')
    const implement = await template('Implementer', 'implement', 'deepseek-flash')
    const review = await template('Reviewer', 'review', 'deepseek-v4-pro')
    const product = await template('Product', 'product', 'deepseek-v4-pro')
    const engineer = await template('Engineer', 'engineer', 'deepseek-flash')
    const qa = await template('QA', 'qa', 'deepseek-flash')
    const summary = await template('Summary', 'summary', 'deepseek-v4-pro')
    const clarify = await template('Clarifier', 'clarify', 'deepseek-v4-pro')
    const sandboxReviewer = await template('Sandbox reviewer', 'sandboxcheck', 'deepseek-flash')
    const filer = await template('Filer', 'filer', 'deepseek-flash')

    const brief = {
      name: 'Brief flow',
      nodes: [
        { kind: 'start' as const, id: 'start' },
        { kind: 'agent' as const, id: 'writer', templateId: writer.id, instruction: 'Write the brief.' },
        { kind: 'agent' as const, id: 'checker', templateId: checker.id, instruction: 'Check the brief.' },
        { kind: 'end' as const, id: 'end' },
      ],
      edges: [
        { kind: 'execution' as const, from: 'start', to: 'writer' },
        { kind: 'input' as const, from: 'start', to: 'writer' },
        { kind: 'execution' as const, from: 'writer', to: 'checker' },
        { kind: 'execution' as const, from: 'checker', to: 'end' },
      ],
    }
    flowA = (await scaffold.ctx.agentFlows.saveFlow(brief)).id
    flowB = (await scaffold.ctx.agentFlows.saveFlow({
      name: 'Design flow',
      nodes: [
        { kind: 'start', id: 'start' },
        { kind: 'agent', id: 'design', templateId: design.id, instruction: 'Design the solution.' },
        { kind: 'agent', id: 'implement', templateId: implement.id, instruction: 'Implement the design.' },
        { kind: 'agent', id: 'review', templateId: review.id, instruction: 'Review the implementation.' },
        { kind: 'condition', id: 'verdict' },
        { kind: 'end', id: 'end' },
      ],
      edges: [
        { kind: 'execution', from: 'start', to: 'design' },
        { kind: 'input', from: 'start', to: 'design' },
        { kind: 'execution', from: 'design', to: 'implement' },
        { kind: 'input', from: 'design', to: 'review' },
        { kind: 'execution', from: 'implement', to: 'review' },
        { kind: 'execution', from: 'review', to: 'verdict' },
        { kind: 'execution', from: 'verdict', to: 'end', result: 'approved' },
        { kind: 'execution', from: 'verdict', to: 'implement', result: 'rework' },
      ],
    })).id
    flowC = (await scaffold.ctx.agentFlows.saveFlow({
      name: 'Review flow',
      nodes: [
        { kind: 'start', id: 'start' },
        { kind: 'agent', id: 'product', templateId: product.id, instruction: 'Assess user value.' },
        { kind: 'agent', id: 'engineer', templateId: engineer.id, instruction: 'Assess the technical plan.' },
        { kind: 'agent', id: 'qa', templateId: qa.id, instruction: 'Assess risks and acceptance.' },
        { kind: 'agent', id: 'summary', templateId: summary.id, instruction: 'Summarize consensus and differences.' },
        { kind: 'end', id: 'end' },
      ],
      edges: [
        { kind: 'execution', from: 'start', to: 'product' },
        { kind: 'input', from: 'start', to: 'product' },
        { kind: 'execution', from: 'start', to: 'engineer' },
        { kind: 'input', from: 'start', to: 'engineer' },
        { kind: 'execution', from: 'start', to: 'qa' },
        { kind: 'input', from: 'start', to: 'qa' },
        { kind: 'execution', from: 'product', to: 'summary' },
        { kind: 'execution', from: 'engineer', to: 'summary' },
        { kind: 'execution', from: 'qa', to: 'summary' },
        { kind: 'execution', from: 'summary', to: 'end' },
      ],
    })).id
    await scaffold.ctx.agentFlows.saveFlow({
      name: 'Clarify flow',
      nodes: [
        { kind: 'start', id: 'start' },
        { kind: 'agent', id: 'clarify', templateId: clarify.id, instruction: 'Clarify the request with the user.', interactive: true },
        { kind: 'agent', id: 'after', templateId: writer.id, instruction: 'Do the agreed work.' },
        { kind: 'end', id: 'end' },
      ],
      edges: [
        { kind: 'execution', from: 'start', to: 'clarify' },
        { kind: 'input', from: 'start', to: 'clarify' },
        { kind: 'execution', from: 'clarify', to: 'after' },
        { kind: 'execution', from: 'after', to: 'end' },
      ],
    })
    flowD = (await scaffold.ctx.agentFlows.saveFlow({
      name: 'Verify flow',
      nodes: [
        { kind: 'start', id: 'start' },
        { kind: 'agent', id: 'verify', templateId: clarify.id, instruction: 'Verify the details with the user.', interactive: true },
        { kind: 'agent', id: 'checked', templateId: checker.id, instruction: 'Check the verified details.' },
        { kind: 'end', id: 'end' },
      ],
      edges: [
        { kind: 'execution', from: 'start', to: 'verify' },
        { kind: 'input', from: 'start', to: 'verify' },
        { kind: 'execution', from: 'verify', to: 'checked' },
        { kind: 'execution', from: 'checked', to: 'end' },
      ],
    })).id
    flowE = (await scaffold.ctx.agentFlows.saveFlow({
      name: 'Sandbox entry flow',
      nodes: [
        { kind: 'start', id: 'start' },
        { kind: 'agent', id: 'reviewer', templateId: sandboxReviewer.id, instruction: 'Review the upstream file.', interactive: true },
        { kind: 'end', id: 'end' },
      ],
      edges: [
        { kind: 'execution', from: 'start', to: 'reviewer' },
        { kind: 'input', from: 'start', to: 'reviewer' },
        { kind: 'execution', from: 'reviewer', to: 'end' },
      ],
    })).id
    flowF = (await scaffold.ctx.agentFlows.saveFlow({
      name: 'Files flow',
      nodes: [
        { kind: 'start', id: 'start' },
        { kind: 'agent', id: 'filer', templateId: filer.id, instruction: 'Write the result files.' },
        { kind: 'end', id: 'end' },
      ],
      edges: [
        { kind: 'execution', from: 'start', to: 'filer' },
        { kind: 'input', from: 'start', to: 'filer' },
        { kind: 'execution', from: 'filer', to: 'end' },
      ],
    })).id
    // The progress card needs a tool execution that lasts long enough to paint
    // its Running tools stage; a millisecond tool settles between two client
    // commits and the stage never renders. The scripted provider calls this
    // tool from the E17 clarification round.
    scaffold.ctx.tools.register(defineContentToolFixture({
      name: 'slow_echo',
      description: 'Echo the text after a short delay (acceptance-lane fixture).',
      parameters: {
        text: { type: 'string', required: true, description: 'Text to echo back.' },
      },
      execute: async (args) => {
        await new Promise(resolve => setTimeout(resolve, 600))
        return [{ type: 'text', text: args.text }]
      },
    }))
    browser = await chromium.launch()
  }, 240_000)

  afterEach(async () => {
    // Close the pages first: a console or host failure that only the unload
    // surfaces still belongs to this test. The checks run in `finally` so a
    // close failure cannot leave the watchers attached to the next test.
    const opened = pages.splice(0)
    const watched = tripwires
    tripwires = []
    try {
      await Promise.all(opened.map(page => page.close()))
    } finally {
      for (const tripwire of watched) {
        expect(tripwire.pageErrors).toEqual([])
        expect(tripwire.warnings).toEqual([])
      }
      expect(hostFailures.splice(0)).toEqual([])
    }
  })

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      try {
        await scaffold?.close()
      } finally {
        try {
          // Teardown-phase host failures are still this suite's failures.
          expect(hostFailures.splice(0)).toEqual([])
        } finally {
          process.off('unhandledRejection', onHostFailure)
          process.off('uncaughtException', onHostFailure)
        }
      }
    }
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
    pages.push(page)
    return page
  }

  /** Create one workspace-attached Session with its own identity. */
  async function createSession(id: string): Promise<SessionId> {
    const sessionId = SessionId(id)
    await scaffold.ctx.agents.create({
      sessionId,
      meta: { cwd: scaffold.workspaceCwd },
      agentOptions: scaffold.ctx.agentDefaultModel.currentSelection(),
    })
    await attachSession(sessionId)
    return sessionId
  }

  async function selected(page: Page): Promise<string | undefined> {
    return page.evaluate(() => {
      const value = localStorage.getItem('dsh.sessions.current')
      return value === null ? undefined : (JSON.parse(value) as { sessionId?: string }).sessionId
    })
  }

  function members(): string[] {
    const workspace = scaffold.ctx.workspaceRegistry.list()
      .find(candidate => String(candidate.id) === primaryWorkspace)
    if (workspace === undefined) throw new Error('primary workspace is missing')
    return workspace.sessionIds.map(id => String(id))
  }

  /** Number of Agent Flow result cards the page shows for its selected Session. */
  async function cardCount(page: Page): Promise<number> {
    return await page.locator('[data-flow-progress]').count()
  }

  /** Start one flow through the real composer: picker click, claim token, typed message, submit. */
  async function startFlowViaComposer(page: Page, flowName: string, text: string): Promise<void> {
    const input = page.locator('[data-composer-input]').first()
    // A previous submission's claim must clear before the next selection: a
    // stale token plus a fresh one puts two claims in the same draft, which
    // sends the editor's transforms into a loop and loses the new claim.
    await expect.poll(async () => await input.innerText(), { timeout: 30_000 }).not.toContain('flow:')
    // The trigger's accessible name carries a running suffix, so match the prefix.
    await page.locator('button[aria-label^="Workflow"]').first().click()
    await page.getByRole('menuitem', { name: flowName, exact: true }).click()
    // The claim token must lead the draft before the message types in; clicking
    // the menu row alone can land while the editor is still settling.
    await expect.poll(async () => await input.innerText()).toContain(`flow:${flowName}`)
    await input.click()
    await page.keyboard.type(text)
    await expect.poll(async () => await input.innerText()).toContain(text)
    await page.keyboard.press('Enter')
  }

  /** Leave flow selection so the next submission is an ordinary chat message. */
  async function clearFlowSelection(page: Page): Promise<void> {
    await page.locator('button[aria-label^="Workflow"]').first().click()
    await page.getByRole('menuitem', { name: 'No workflow', exact: true }).click()
    const input = page.locator('[data-composer-input]').first()
    await expect.poll(async () => await input.innerText()).not.toContain('flow:')
  }

  function runsFor(sessionId: string): Promise<FlowRun[]> {
    return scaffold.ctx.agentFlows.listRuns().then(runs => runs.filter(run => String(run.parentSessionId) === sessionId))
  }

  /** Wait until the run started by one CASE reaches the expected status. */
  async function waitForRun(sessionId: string, caseId: string, status: FlowRun['status'] = 'completed'): Promise<FlowRun> {
    await expect.poll(async () => {
      const candidate = (await runsFor(sessionId)).find(entry => entry.input.includes(caseId))
      return candidate?.status
    }, { timeout: 90_000, interval: 200 }).toBe(status)
    return (await runsFor(sessionId)).find(entry => entry.input.includes(caseId))!
  }

  /** Release one `[HOLD]` request through the scripted wire's test control. */
  function releaseHold(caseId: string): void {
    const control = scaffold.ctx.get('scriptedLlm') as { release(caseId: string): void } | undefined
    control?.release(caseId)
  }

  /** Model requests the scripted wire served for one CASE; a node restart adds one. */
  function callsFor(caseId: string): number {
    const control = scaffold.ctx.get('scriptedLlm') as { calls(caseId: string): number } | undefined
    return control?.calls(caseId) ?? -1
  }

  function agentOf(sessionId: SessionId): Agent {
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error(`no live Agent for ${String(sessionId)}`)
    return agent
  }

  function handoffOf(run: FlowRun, nodeId: string): string {
    return run.nodeRuns.filter(entry => entry.nodeId === nodeId).map(entry => entry.handoff ?? '').join('\n')
  }

  it('E01: new conversation after a run is a different Session without the old results', async () => {
    const first = await openPage()
    await expect.poll(async () => await selected(first)).not.toBeUndefined()
    const s1 = (await selected(first))!
    const before = (await scaffold.ctx.agentFlows.listRuns()).length

    await startFlowViaComposer(first, 'Brief flow', '[CASE:E01-L1AA] Write a brief for the book exchange event.')
    const run = await waitForRun(s1, 'E01-L1AA')
    expect((await scaffold.ctx.agentFlows.listRuns()).length).toBe(before + 1)
    expect(String(run.flowId)).toBe(String(flowA))
    expect(run.nodeRuns.find(node => node.nodeId === 'writer')).toMatchObject({ status: 'succeeded' })
    expect(handoffOf(run, 'writer')).toContain('CASE:E01-L1AA')
    expect(handoffOf(run, 'checker')).toContain('CASE:E01-L1AA')
    // The completed run renders its result card on the Session that started it.
    await expect.poll(async () => await cardCount(first)).toBe(1)

    // New Session: a different identity that owns no run and shows no card.
    // The brand mark also exposes an aria-label of "New session", so target the
    // header control rather than the first match.
    await first.getByRole('button', { name: 'New session', exact: true }).last().click()
    await expect.poll(async () => await selected(first)).not.toBe(s1)
    const s2 = (await selected(first))!
    expect(members().sort()).toEqual([s1, s2].sort())
    expect(await runsFor(s2)).toEqual([])
    expect(await cardCount(first)).toBe(0)

    // A plain conversation in the same workspace shows no flow card either.
    const s3 = await createSession('l1-e01-s3')
    const plainPage = await openPage(s3)
    const plainInput = plainPage.locator('[data-composer-input]').first()
    await plainInput.click()
    await plainPage.keyboard.type('plain hello from another session')
    await plainPage.keyboard.press('Enter')
    await plainPage.getByText('worker handled CASE:NO-CASE').last().waitFor({ timeout: 60_000 })
    expect(await cardCount(plainPage)).toBe(0)

    // Another workspace's Session never borrows the run's card.
    const otherDir = await mkdtemp(join(tmpdir(), 'dsh-web-e2e-other-'))
    const otherWorkspace = await scaffold.ctx.workspaceRegistry.create(otherDir)
    const s4 = SessionId('l1-e01-s4')
    await scaffold.ctx.agents.create({
      sessionId: s4,
      meta: { cwd: otherDir },
      agentOptions: scaffold.ctx.agentDefaultModel.currentSelection(),
    })
    await otherWorkspace.attachSession(s4)
    const otherPage = await openPage(s4)
    expect(await cardCount(otherPage)).toBe(0)

    // The finished run's Session stays visible history and opens its own transcript with its card.
    await first.locator(`[data-row-key="session:${s1}"]`).first().click()
    await expect.poll(async () => await selected(first)).toBe(s1)
    await expect.poll(async () => await cardCount(first)).toBe(1)

    // A reload keeps both identities, the run association, and the card.
    const reloadWarnings = tripwires[0]!.warnings.length
    await first.reload({ waitUntil: 'load' })
    await first.locator('[data-composer-input]').first().waitFor({ timeout: 30_000 })
    expect(members().sort()).toEqual([s1, s2, String(s3)].sort())
    expect((await runsFor(s1)).map(entry => String(entry.id))).toEqual([String(run.id)])
    await expect.poll(async () => await cardCount(first), { timeout: 30_000 }).toBe(1)
    // The reload's connection-loss warning may surface late, so acknowledge it
    // after the reload's own assertions; gap-repair stays fatal.
    acknowledgeReloadConnectionLoss(tripwires[0]!, reloadWarnings)
  }, 180_000)

  it('E02/E03: one Flow keeps per-Session and per-run identity across repeated runs', async () => {
    const sA = await createSession('l1-e02-a')
    const sB = await createSession('l1-e02-b')
    const pageA = await openPage(sA)
    await startFlowViaComposer(pageA, 'Brief flow', '[CASE:E02-A1AA] Brief for the library event.')
    const runA = await waitForRun(String(sA), 'E02-A1AA')
    const pageB = await openPage(sB)
    await startFlowViaComposer(pageB, 'Brief flow', '[CASE:E02-B1BB] Brief for the office lunch.')
    const runB = await waitForRun(String(sB), 'E02-B1BB')

    expect(String(runA.flowId)).toBe(String(runB.flowId))
    expect(String(runA.id)).not.toBe(String(runB.id))
    expect(String(runA.parentSessionId)).toBe(String(sA))
    expect(String(runB.parentSessionId)).toBe(String(sB))
    expect(handoffOf(runA, 'writer')).toContain('E02-A1AA')
    expect(handoffOf(runA, 'writer')).not.toContain('E02-B1BB')
    expect(handoffOf(runB, 'writer')).toContain('E02-B1BB')
    expect(handoffOf(runB, 'writer')).not.toContain('E02-A1AA')

    // E03: a second run on the same Session never overwrites the first.
    await startFlowViaComposer(pageB, 'Brief flow', '[CASE:E03-B2CC] Brief for the school fair.')
    const runB2 = await waitForRun(String(sB), 'E03-B2CC')
    expect(String(runB2.id)).not.toBe(String(runB.id))
    const sessionB = await runsFor(String(sB))
    expect(sessionB.map(entry => String(entry.id)).sort()).toEqual([String(runB.id), String(runB2.id)].sort())
    expect((await scaffold.ctx.agentFlows.readRun(runB.id)).input).toContain('E02-B1BB')
  }, 240_000)

  it('E04: two business Flows keep their own graphs and runs', async () => {
    const sC = await createSession('l1-e04-c')
    const page = await openPage(sC)
    await startFlowViaComposer(page, 'Design flow', '[CASE:E04-C1DD] Design and implement the sorting module.')
    const run = await waitForRun(String(sC), 'E04-C1DD')
    expect(String(run.flowId)).toBe(String(flowB))
    // The scripted review rejects the first attempt and approves the second.
    const implementRuns = run.nodeRuns.filter(entry => entry.nodeId === 'implement')
    expect(implementRuns.map(entry => entry.iteration)).toEqual([0, 1])
    const reviewRuns = run.nodeRuns.filter(entry => entry.nodeId === 'review')
    expect(reviewRuns.map(entry => entry.iteration)).toEqual([0, 1])
    expect(handoffOf(run, 'review')).toContain('Result: rework')
    expect(handoffOf(run, 'review')).toContain('Result: approved')
    expect(run.nodeRuns.filter(entry => entry.nodeId === 'verdict').every(entry => entry.status === 'succeeded')).toBe(true)
    expect(run.nodeRuns.some(entry => entry.status === 'running' || entry.status === 'conversing' || entry.status === 'pending')).toBe(false)
    expect((await runsFor(String(sC))).every(entry => String(entry.flowId) === String(flowB))).toBe(true)
  }, 240_000)

  // E24: the results page is a document surface. Routing conditions never get
  // cards, earlier rounds stay reachable, and a long deliverable remains
  // readable in the narrow layout and the dark theme.
  it('E24: the results page hides condition nodes and renders the deliverable in both layouts', async () => {
    const sP = await createSession('l1-e24-p')
    const page = await openPage(sP)
    await startFlowViaComposer(page, 'Design flow', '[CASE:E24-P1SS] [LONG] [ROUNDS] Design the results page probe.')
    const run = await waitForRun(String(sP), 'E24-P1SS')
    const card = page.locator('[data-flow-progress]')
    await card.waitFor({ timeout: 30_000 })
    await card.getByRole('button', { name: 'View full flow', exact: true }).click()
    const results = page.locator(`[data-run-results="${String(run.id)}"]`)
    await results.waitFor({ timeout: 30_000 })

    // The routing condition stays in the execution record but out of the
    // result cards; each work node keeps exactly one card.
    await expect.poll(async () => await results.locator('[data-node="verdict"]').count()).toBe(0)
    for (const node of ['design', 'implement', 'review']) {
      await expect.poll(async () => await results.locator(`[data-node="${node}"]`).count()).toBe(1)
    }

    // The long Markdown deliverable is clamped with an explicit expansion, and
    // its rendered heading proves Markdown, not plain text.
    const heading = results.getByRole('heading', { name: 'Long report' })
    await heading.waitFor({ state: 'visible', timeout: 30_000 })
    const design = results.locator('[data-node="design"]')
    const expand = design.getByRole('button', { name: 'Show the full summary', exact: true })
    await expand.click()
    await design.getByRole('button', { name: 'Collapse the summary', exact: true })
      .waitFor({ state: 'visible', timeout: 30_000 })
    const earlier = results.locator('[data-node="implement"]')
      .getByRole('button', { name: /1 earlier rounds/ })
    await earlier.waitFor({ state: 'visible', timeout: 30_000 })
    // Expanding the history proves each round keeps its own handoff text, not
    // the latest round's body repeated.
    await earlier.click()
    const implement = results.locator('[data-node="implement"]')
    await implement.getByRole('button', { name: /Round 1/ }).click()
    await expect.poll(async () => await implement.innerText()).toContain('implement round 1 for CASE:NO-CASE')
    await expect.poll(async () => await implement.innerText()).toContain('implement round 2 for CASE:NO-CASE')

    // The narrow layout and the dark theme keep the request toggle usable from
    // the keyboard.
    await page.setViewportSize({ width: 420, height: 800 })
    await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', '') })
    await results.waitFor({ state: 'visible', timeout: 30_000 })
    const request = results.getByRole('button', { name: 'Original request', exact: true })
    await request.focus()
    await page.keyboard.press('Enter')
    await expect.poll(async () => await results.getByText('E24-P1SS', { exact: false }).count()).toBeGreaterThan(0)
  }, 240_000)

  // E26: a downstream node can read upstream deliverables and copy them into
  // its own directory, but the sandbox must refuse writes through Bash.
  it('E26: a downstream node cannot overwrite an upstream delivered file', async () => {
    const sQ = await createSession('l1-e26-q')
    const page = await openPage(sQ)
    await startFlowViaComposer(page, 'Brief flow', '[CASE:E26-Q1TT] [SANDBOX] Create the upstream file.')
    const run = await waitForRun(String(sQ), 'E26-Q1TT')
    const writer = run.nodeRuns.find(entry => entry.nodeId === 'writer')!
    const checker = run.nodeRuns.find(entry => entry.nodeId === 'checker')!
    expect(writer.status).toBe('succeeded')
    expect(checker.status).toBe('succeeded')
    // The node Session's immutable header cwd is its own directory, which every
    // host uses as the sandbox root; the upstream writer directory stays outside.
    using observed = await scaffold.ctx.sessionQuery.observeSession(checker.agentSessionId!)
    expect(observed.header.cwd).toBe(checker.dir)
    const events = await readPersistedEvents(scaffold, checker.agentSessionId!)
    expect(events.filter(event => event.type === 'sandbox/root')).toEqual([])
    const upstream = join(writer.dir!, 'original.txt')
    const results = events
      .filter(event => event.type === 'tool/result')
      .map(event => JSON.stringify(event.data))
    // Six refused writes: same-byte overwrite, rewrite, delete, rename, a
    // temp-file replacement, and a write through a symlink in the checker's own
    // directory. Each reports STEP-DENIED only when the shell could not perform
    // it, so a missing marker would mean the write went through.
    expect(results).toHaveLength(6)
    expect(results.every(text => text.includes('STEP-DENIED'))).toBe(true)
    expect(await readFile(upstream, 'utf8')).toBe('upstream-original')
    // The upstream directory keeps exactly its original entry: no rename, no
    // replacement.
    expect(await readdir(writer.dir!)).toEqual(['original.txt'])
  }, 240_000)

  // E27: an interactive node is a root Session, not a subagent child; its own
  // directory must still be the write boundary. An interactive node is an
  // execution entry, so the upstream file already exists in the workspace.
  it('E27: an interactive node cannot overwrite an upstream delivered file', async () => {
    const sR = await createSession('l1-e27-r')
    const upstream = join(scaffold.workspaceCwd, 'upstream.txt')
    await writeFile(upstream, 'upstream-original')
    const page = await openPage(sR)
    await startFlowViaComposer(
      page,
      'Sandbox entry flow',
      `[CASE:E27-R1BB] [SANDBOX-ENTRY] [UPSTREAM:${upstream}] Review the upstream file.`,
    )
    const run = await waitForRun(String(sR), 'E27-R1BB')
    expect(String(run.flowId)).toBe(String(flowE))
    const reviewer = run.nodeRuns.find(entry => entry.nodeId === 'reviewer')!
    expect(reviewer.status).toBe('succeeded')
    using observed = await scaffold.ctx.sessionQuery.observeSession(reviewer.agentSessionId!)
    expect(observed.header.cwd).toBe(reviewer.dir)
    const events = await readPersistedEvents(scaffold, reviewer.agentSessionId!)
    expect(events.filter(event => event.type === 'sandbox/root')).toEqual([])
    const results = events
      .filter(event => event.type === 'tool/result')
      .map(event => JSON.stringify(event.data))
    expect(results).toHaveLength(6)
    expect(results.every(text => text.includes('STEP-DENIED'))).toBe(true)
    expect(await readFile(upstream, 'utf8')).toBe('upstream-original')
  }, 240_000)

  it('E05: one Session runs two Flows and returns to ordinary chat', async () => {
    const sD = await createSession('l1-e05-d')
    const page = await openPage(sD)
    await startFlowViaComposer(page, 'Brief flow', '[CASE:E05-D1EE] Brief for the garden club.')
    await waitForRun(String(sD), 'E05-D1EE')
    await startFlowViaComposer(page, 'Review flow', '[CASE:E05-D2FF] Assess the signup system.')
    const reviewRun = await waitForRun(String(sD), 'E05-D2FF')
    expect(String(reviewRun.flowId)).toBe(String(flowC))
    const summary = reviewRun.nodeRuns.find(entry => entry.nodeId === 'summary')!
    expect(summary.inputs?.map(input => input.nodeId).sort()).toEqual(['engineer', 'product', 'qa'])
    const flows = new Set((await runsFor(String(sD))).map(entry => String(entry.flowId)))
    expect(flows).toEqual(new Set([String(flowA), String(flowC)]))

    // Leaving the picker returns the composer to ordinary chat: the unique
    // message is accepted, answered in the page, and starts no run.
    const before = (await runsFor(String(sD))).length
    const cursor = scaffold.ctx.sessions.get(sD)?.seq ?? 0
    await clearFlowSelection(page)
    const input = page.locator('[data-composer-input]').first()
    const message = 'plain-after-flows-probe'
    await input.click()
    await page.keyboard.type(message)
    await page.keyboard.press('Enter')
    await page.getByText(message).last().waitFor({ timeout: 30_000 })
    await page.getByText('worker handled CASE:NO-CASE').last().waitFor({ timeout: 60_000 })
    // The user message and its reply are two durable events past the cursor.
    expect(scaffold.ctx.sessions.get(sD)?.seq ?? 0).toBeGreaterThan(cursor + 1)
    expect(await runsFor(String(sD))).toHaveLength(before)
  }, 240_000)

  it('E06: cancelling one concurrent run leaves the other untouched', async () => {
    const sE = await createSession('l1-e06-e')
    const sF = await createSession('l1-e06-f')
    const pageE = await openPage(sE)
    await startFlowViaComposer(pageE, 'Brief flow', '[CASE:E06-E1GG] [HOLD] Brief for the marathon.')
    await expect.poll(async () => (await runsFor(String(sE)))[0]?.status, { timeout: 30_000 }).toBe('running')
    const held = (await runsFor(String(sE)))[0]!
    const pageF = await openPage(sF)
    await startFlowViaComposer(pageF, 'Brief flow', '[CASE:E06-F1HH] [HOLD] Brief for the museum tour.')
    await expect.poll(async () => (await runsFor(String(sF)))[0]?.status, { timeout: 30_000 }).toBe('running')
    const blocked = (await runsFor(String(sF)))[0]!

    // Cancel A through its result card, while B is still executing.
    const card = pageE.locator('[data-flow-progress]')
    await card.waitFor({ timeout: 30_000 })
    await card.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect.poll(async () => (await scaffold.ctx.agentFlows.readRun(held.id)).status).toBe('cancelled')
    expect((await scaffold.ctx.agentFlows.readRun(blocked.id)).status).toBe('running')

    // B releases and finishes its remaining node; A's cancellation did not stop it.
    releaseHold('E06-F1HH')
    const completed = await waitForRun(String(sF), 'E06-F1HH')
    expect(completed.nodeRuns.find(entry => entry.nodeId === 'writer')?.status).toBe('succeeded')
    expect(completed.nodeRuns.find(entry => entry.nodeId === 'checker')?.status).toBe('succeeded')
    expect((await scaffold.ctx.agentFlows.readRun(held.id)).status).toBe('cancelled')
  }, 240_000)

  it('E07: two Flows wait on their users at once and a reply advances only its own run', async () => {
    const sK = await createSession('l1-e07-k')
    const sL = await createSession('l1-e07-l')
    const pageK = await openPage(sK)
    const pageL = await openPage(sL)
    await startFlowViaComposer(pageK, 'Verify flow', '[CASE:E07-K1OO] Verify the launch checklist.')
    await startFlowViaComposer(pageL, 'Clarify flow', '[CASE:E07-L1PP] Clarify the migration plan.')
    for (const [sessionId, node] of [[sK, 'verify'], [sL, 'clarify']] as const) {
      await expect.poll(async () => {
        const run = (await runsFor(String(sessionId)))[0]
        return run?.nodeRuns.find(entry => entry.nodeId === node)?.status
      }, { timeout: 60_000 }).toBe('conversing')
    }
    await pageK.getByText('round 1 needs more detail').waitFor({ timeout: 60_000 })
    await pageL.getByText('round 1 needs more detail').waitFor({ timeout: 60_000 })

    // K's reply stays inside K's conversation: only K's run reaches round 2.
    const inputK = pageK.locator('[data-composer-input]').first()
    await inputK.click()
    await pageK.keyboard.type('Add the rollback step.')
    await pageK.keyboard.press('Enter')
    await pageK.getByText('round 2 needs more detail').waitFor({ timeout: 60_000 })
    expect(await pageL.getByText('round 2 needs more detail').count()).toBe(0)
    expect(await pageL.getByText('Add the rollback step.').count()).toBe(0)
    expect((await runsFor(String(sL)))[0]!.nodeRuns.find(entry => entry.nodeId === 'clarify')!.status).toBe('conversing')

    // L's own composer still serves its waiting run: the confirmation finishes
    // it while K's run keeps waiting untouched.
    const inputL = pageL.locator('[data-composer-input]').first()
    await inputL.click()
    await pageL.keyboard.type('READY-TO-PROCEED')
    await pageL.keyboard.press('Enter')
    await pageL.getByText('round 2 confirmed').waitFor({ timeout: 60_000 })
    const finished = await waitForRun(String(sL), 'E07-L1PP')
    expect(finished.snapshot.name).toBe('Clarify flow')
    expect(finished.nodeRuns.every(entry => entry.status === 'succeeded')).toBe(true)
    expect((await runsFor(String(sK)))[0]!.status).toBe('running')
    await expect.poll(async () => await pageK.locator('[data-flow-progress]').innerText(), { timeout: 30_000 })
      .toContain('Flow waiting for your reply')

    // K confirms last; its conversation carried only its own rounds.
    await inputK.click()
    await pageK.keyboard.type('READY-TO-PROCEED')
    await pageK.keyboard.press('Enter')
    await pageK.getByText('round 3 confirmed').waitFor({ timeout: 60_000 })
    const kRun = await waitForRun(String(sK), 'E07-K1OO')
    expect(String(kRun.flowId)).toBe(String(flowD))
    expect(kRun.nodeRuns.every(entry => entry.status === 'succeeded')).toBe(true)
    expect(await pageL.getByText('round 3 confirmed').count()).toBe(0)
  }, 240_000)

  // E08's original unhandled Host error (`agent "<id>" cannot read inbox
  // state: its projection registration is not active`) had two reproducible
  // paths, both now pinned separately: the core regression covers AgentLoop
  // unload overlapping an external parent cancel, and the runtime only cancels
  // an interactive Agent still in its registry. This test keeps watching for
  // host-level failures in afterEach, and covers the UI-facing fact: both runs
  // start through the composer, the picker separates them by the request that
  // started each, and cancelling one runId leaves the other executing. The
  // second start comes from a second tab: re-claiming the same editor is the
  // claim-token transform path whose transform cascade is tracked separately.
  it('E08: two runs in one Session cancel by runId, not by Flow', async () => {
    const sG = await createSession('l1-e08-g')
    const page = await openPage(sG)
    await startFlowViaComposer(page, 'Brief flow', '[CASE:E08-G1II] [HOLD] Held brief.')
    await expect.poll(async () => (await runsFor(String(sG))).length, { timeout: 30_000 }).toBe(1)
    const held = (await runsFor(String(sG)))[0]!
    const second = await openPage(sG)
    await startFlowViaComposer(second, 'Brief flow', '[CASE:E08-G2JJ] [HOLD] Second brief while the first holds.')
    await expect.poll(async () => (await runsFor(String(sG))).length, { timeout: 30_000 }).toBe(2)
    const live = (await runsFor(String(sG))).find(run => run.id !== held.id)!

    // The picker names each run by its request, so the target is chosen from
    // what the user can see, not from the roster's position.
    const card = second.locator('[data-flow-progress]')
    await card.waitFor({ timeout: 30_000 })
    await card.getByRole('button', { name: 'Choose the run to view', exact: true }).click()
    const runRows = second.getByRole('menuitem')
    await expect.poll(async () => await runRows.count()).toBe(2)
    await expect.poll(async () => await runRows.allInnerTexts()).toEqual(expect.arrayContaining([
      expect.stringContaining('Held brief.'),
      expect.stringContaining('Second brief'),
    ]))
    await runRows.filter({ hasText: 'Held brief.' }).click()
    await card.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect.poll(async () => (await scaffold.ctx.agentFlows.readRun(held.id)).status).toBe('cancelled')
    expect((await scaffold.ctx.agentFlows.readRun(live.id)).status).toBe('running')

    releaseHold('E08-G2JJ')
    await expect.poll(async () => (await scaffold.ctx.agentFlows.readRun(live.id)).status, { timeout: 90_000 }).toBe('completed')
    expect((await scaffold.ctx.agentFlows.readRun(held.id)).status).toBe('cancelled')
  }, 240_000)

  // Re-claiming the same Flow from the same editor while the first run holds
  // is the path where a stale claim token and a fresh one can land in one
  // draft and send the editor's transforms into a cascade. The host and page
  // failure watchers in afterEach turn a recurrence into a failed assertion
  // with the captured stack; the visible facts are the same as the two-tab
  // case above: two run identities behind one picker, chosen by request text.
  it('E08: one page claims the same Flow twice and cancels the first by its request summary', async () => {
    const sG = await createSession('l1-e08-same-page')
    const page = await openPage(sG)
    await startFlowViaComposer(page, 'Brief flow', '[CASE:E08-S1II] [HOLD] Same-page held.')
    await expect.poll(async () => (await runsFor(String(sG))).length, { timeout: 30_000 }).toBe(1)
    const held = (await runsFor(String(sG)))[0]!
    await startFlowViaComposer(page, 'Brief flow', '[CASE:E08-S2JJ] [HOLD] Same-page second.')
    await expect.poll(async () => (await runsFor(String(sG))).length, { timeout: 30_000 }).toBe(2)
    const started = await runsFor(String(sG))
    expect(new Set(started.map(run => String(run.id))).size).toBe(2)
    expect(started.every(run => String(run.flowId) === String(flowA))).toBe(true)
    expect(started.every(run => String(run.parentSessionId) === String(sG))).toBe(true)
    const live = started.find(run => run.id !== held.id)!
    const parent = agentOf(sG).session
    const parentTurns = (): number => parent.snapshotEvents()
      .filter(event => event.type === 'turn/start').length
    // Both claims consume the composer submission; neither may leave an
    // ordinary chat turn behind on the parent Session.
    expect(parentTurns()).toBe(0)

    const card = page.locator('[data-flow-progress]')
    await card.waitFor({ timeout: 30_000 })
    await card.getByRole('button', { name: 'Choose the run to view', exact: true }).click()
    const runRows = page.getByRole('menuitem')
    await expect.poll(async () => await runRows.count()).toBe(2)
    await expect.poll(async () => await runRows.allInnerTexts()).toEqual(expect.arrayContaining([
      expect.stringContaining('Same-page held.'),
      expect.stringContaining('Same-page second.'),
    ]))
    await runRows.filter({ hasText: 'Same-page held.' }).click()
    await card.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect.poll(async () => (await scaffold.ctx.agentFlows.readRun(held.id)).status).toBe('cancelled')
    expect((await scaffold.ctx.agentFlows.readRun(live.id)).status).toBe('running')

    releaseHold('E08-S2JJ')
    await expect.poll(async () => (await scaffold.ctx.agentFlows.readRun(live.id)).status, { timeout: 90_000 }).toBe('completed')
    expect((await scaffold.ctx.agentFlows.readRun(held.id)).status).toBe('cancelled')
    expect(parentTurns()).toBe(0)
  }, 240_000)

  it('E09: a same-named clone is a distinct Flow identity', async () => {
    const original = await scaffold.ctx.agentFlows.readFlow(flowA)
    const clone = await scaffold.ctx.agentFlows.saveFlow({
      name: original.name,
      nodes: original.nodes,
      edges: original.edges,
    })
    const sH = await createSession('l1-e09-h')
    const page = await openPage(sH)

    // The picker shows two rows with the same label; each click picks one and
    // the runs stay keyed by flowId, never by the shared display name.
    const pickBrief = async (index: number, text: string): Promise<void> => {
      await page.getByRole('button', { name: 'Workflow', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Brief flow', exact: true }).nth(index).click()
      const input = page.locator('[data-composer-input]').first()
      await expect.poll(async () => await input.innerText()).toContain('flow:Brief flow')
      await input.click()
      await page.keyboard.type(text)
      await expect.poll(async () => await input.innerText()).toContain(text)
      await page.keyboard.press('Enter')
    }
    await pickBrief(0, '[CASE:E09-H1KK] Brief for the first clone.')
    await waitForRun(String(sH), 'E09-H1KK')
    await pickBrief(1, '[CASE:E09-H2LL] Brief for the second clone.')
    await waitForRun(String(sH), 'E09-H2LL')

    const runs = await runsFor(String(sH))
    expect(runs).toHaveLength(2)
    expect(new Set(runs.map(entry => String(entry.id))).size).toBe(2)
    // Both picks must actually run the two distinct flows: neither row may
    // silently start the same Flow twice.
    expect(new Set(runs.map(entry => String(entry.flowId)))).toEqual(new Set([String(flowA), String(clone.id)]))
    expect((await scaffold.ctx.agentFlows.listFlows()).filter(entry => entry.name === 'Brief flow')).toHaveLength(2)
  }, 240_000)

  // E23: the wire itself proves per-node routing, not the picker labels. A
  // started run keeps the graph it snapshotted, while a template read happens
  // when its node starts — the documented existing behavior for a held run.
  it('E23: node requests follow their template routes and a started run keeps its graph', async () => {
    const routeWriter = await scaffold.ctx.agentFlows.saveTemplate({
      name: 'Route writer',
      persona: 'ROLE:writer Route as the writer.',
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
    })
    const routeChecker = await scaffold.ctx.agentFlows.saveTemplate({
      name: 'Route checker',
      persona: 'ROLE:checker Route as the checker.',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
    })
    const routed = await scaffold.ctx.agentFlows.saveFlow({
      name: 'Routing flow',
      nodes: [
        { kind: 'start', id: 'start' },
        { kind: 'agent', id: 'writer', templateId: routeWriter.id, instruction: 'Route writer.' },
        { kind: 'agent', id: 'checker', templateId: routeChecker.id, instruction: 'Route checker.' },
        { kind: 'end', id: 'end' },
      ],
      edges: [
        { kind: 'execution', from: 'start', to: 'writer' },
        { kind: 'input', from: 'start', to: 'writer' },
        { kind: 'execution', from: 'writer', to: 'checker' },
        { kind: 'execution', from: 'checker', to: 'end' },
      ],
    })
    const sN = await createSession('l1-e23-n')
    const page = await openPage(sN)
    const routedModels = (): { role: string; provider: string; model: string }[] => {
      const control = scaffold.ctx.get('scriptedLlm') as {
        routes(caseId: string): { role: string; provider: string; model: string }[]
      } | undefined
      return control?.routes('E23-N1RR') ?? []
    }

    await startFlowViaComposer(page, 'Routing flow', '[CASE:E23-N1RR] [HOLD] Route check.')
    await expect.poll(async () => (await runsFor(String(sN))).length, { timeout: 30_000 }).toBe(1)
    const held = (await runsFor(String(sN)))[0]!
    await expect.poll(async () => routedModels().length, { timeout: 30_000 }).toBe(1)
    expect(routedModels()[0]).toMatchObject({
      role: 'writer', provider: 'deepseek-official', model: 'deepseek-v4-pro',
    })

    // The run snapshotted the Flow document, so replacing the checker node's
    // template in the saved Flow leaves this run on its original template.
    // The template itself is read at node start, so updating its model now
    // changes the not-yet-started checker request.
    const replacement = await scaffold.ctx.agentFlows.saveTemplate({
      name: 'Replacement checker',
      persona: 'ROLE:checker Replacement as the checker.',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
    })
    await scaffold.ctx.agentFlows.saveTemplate({
      id: routeChecker.id,
      name: routeChecker.name,
      persona: routeChecker.persona,
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
    })
    await scaffold.ctx.agentFlows.saveFlow({
      id: routed.id,
      name: routed.name,
      nodes: routed.nodes.map(node => node.kind === 'agent' && node.id === 'checker'
        ? { ...node, templateId: replacement.id }
        : node),
      edges: routed.edges,
    })

    releaseHold('E23-N1RR')
    const settled = await waitForRun(String(sN), 'E23-N1RR')
    expect(settled.id).toBe(held.id)
    await expect.poll(async () => routedModels().length, { timeout: 30_000 }).toBe(2)
    expect(routedModels()[1]).toMatchObject({
      role: 'checker', provider: 'deepseek-official', model: 'deepseek-v4-pro',
    })
    const checkerSnapshot = settled.snapshot.nodes.find(node => node.kind === 'agent' && node.id === 'checker')
    expect(checkerSnapshot).toMatchObject({ templateId: routeChecker.id })
    expect((await scaffold.ctx.agentFlows.readFlow(routed.id)).nodes
      .find(node => node.kind === 'agent' && node.id === 'checker')).toMatchObject({ templateId: replacement.id })
  }, 240_000)

  // E25: an invalid model route fails where it is determinable, in the page,
  // without spending a model request; correcting the template makes the next
  // submission run exactly its nodes, and ordinary chat still works.
  it('E25: an unknown provider fails visibly and a corrected route runs once', async () => {
    const broken = await scaffold.ctx.agentFlows.saveTemplate({
      name: 'Broken route',
      persona: 'ROLE:writer Broken route.',
      provider: 'missing-provider',
      model: 'missing-model',
    })
    await scaffold.ctx.agentFlows.saveFlow({
      name: 'Broken route flow',
      nodes: [
        { kind: 'start', id: 'start' },
        { kind: 'agent', id: 'work', templateId: broken.id, instruction: 'Do the work.' },
        { kind: 'end', id: 'end' },
      ],
      edges: [
        { kind: 'execution', from: 'start', to: 'work' },
        { kind: 'input', from: 'start', to: 'work' },
        { kind: 'execution', from: 'work', to: 'end' },
      ],
    })
    const sT = await createSession('l1-e25-t')
    const page = await openPage(sT)
    await startFlowViaComposer(page, 'Broken route flow', '[CASE:E25-T1AA] Do the work.')

    const failed = await waitForRun(String(sT), 'E25-T1AA', 'failed')
    const work = failed.nodeRuns.find(entry => entry.nodeId === 'work')!
    expect(work.status).toBe('failed')
    // The route is unserviceable, so the wire never sees a request for it.
    expect(callsFor('E25-T1AA')).toBe(0)
    expect(work.error ?? failed.error ?? '').toContain('missing-provider')

    // The page shows the reason, not just a red dot.
    const card = page.locator('[data-flow-progress]')
    await card.waitFor({ timeout: 30_000 })
    await card.getByRole('button', { name: 'View full flow', exact: true }).click()
    const results = page.locator(`[data-run-results="${String(failed.id)}"]`)
    await results.waitFor({ timeout: 30_000 })
    await expect.poll(async () => await results.innerText(), { timeout: 30_000 }).toContain('missing-provider')

    // Correcting the template is the only change; the next submission reaches
    // the single expected node exactly once.
    await scaffold.ctx.agentFlows.saveTemplate({
      id: broken.id,
      name: broken.name,
      persona: broken.persona,
      provider: 'deepseek-official',
      model: 'deepseek-flash',
    })
    const page2 = await openPage(sT)
    await startFlowViaComposer(page2, 'Broken route flow', '[CASE:E25-T2BB] Do the work again.')
    const fixed = await waitForRun(String(sT), 'E25-T2BB')
    expect(fixed.nodeRuns.filter(entry => entry.nodeId === 'work').map(entry => entry.status)).toEqual(['succeeded'])
    expect(callsFor('E25-T2BB')).toBe(1)

    // Leaving the picker returns the composer to ordinary chat.
    await clearFlowSelection(page2)
    const input = page2.locator('[data-composer-input]').first()
    await input.click()
    await page2.keyboard.type('plain-after-invalid-route')
    await page2.keyboard.press('Enter')
    await page2.getByText('worker handled CASE:NO-CASE').last().waitFor({ timeout: 60_000 })
  }, 240_000)

  // E28: result files belong to their run and workspace. Previews open the
  // recorded path, Markdown line links reveal the requested line, localized
  // and space-bearing names survive, and a deleted file reports not-found.
  it('E28: result files resolve per run and workspace with line links and missing feedback', async () => {
    const sA = await createSession('l1-e28-a')
    const page = await openPage(sA)
    await startFlowViaComposer(page, 'Files flow', '[CASE:E28-A1CC] [FILES] [MARK:A] Write the result.')
    const runA = await waitForRun(String(sA), 'E28-A1CC')
    expect(String(runA.flowId)).toBe(String(flowF))
    const filerA = runA.nodeRuns.find(entry => entry.nodeId === 'filer')!
    expect(filerA.files).toEqual([
      join(filerA.dir!, 'RESULT.md'),
      join(filerA.dir!, 'notes.txt'),
      join(filerA.dir!, '结果 报告.md'),
    ])

    const openResults = async (targetPage: Page, flowRun: FlowRun) => {
      const card = targetPage.locator('[data-flow-progress]')
      await card.waitFor({ timeout: 30_000 })
      await card.getByRole('button', { name: 'View full flow', exact: true }).click()
      const results = targetPage.locator(`[data-run-results="${String(flowRun.id)}"]`)
      await results.waitFor({ timeout: 30_000 })
      return results
    }
    // Opening a file moves the right sidebar to the parent Session, so the
    // results panel is reopened through the progress card for each preview.
    let resultsA = await openResults(page, runA)
    const column = page.locator('[data-rightbar-col]')
    const previewOf = async (results: ReturnType<Page['locator']>, name: string) => {
      await results.locator('[data-node="filer"] ul').first().locator('li').filter({ hasText: name })
        .getByRole('button', { name: 'Preview', exact: true }).click()
    }

    // The narrow layout keeps the results document readable in both themes.
    const artifacts = fileURLToPath(new URL('../../../.artifacts', import.meta.url))
    await mkdir(artifacts, { recursive: true })
    await page.setViewportSize({ width: 420, height: 800 })
    for (const dark of [false, true]) {
      await page.evaluate((on) => {
        if (on) document.body.setAttribute('data-ds-dark-theme', '')
        else document.body.removeAttribute('data-ds-dark-theme')
      }, dark)
      await expect.poll(async () => await resultsA.locator('[data-node="filer"]').count()).toBe(1)
      await page.screenshot({
        path: join(artifacts, `agent-flow-e28-results-${dark ? 'dark' : 'light'}.png`),
        animations: 'disabled',
      })
    }

    // The result body's Markdown link carries its line into the text preview.
    await resultsA.getByRole('button', { name: 'line 3', exact: true }).click()
    await expect.poll(() => column.locator('[data-textpreview-target="3"]').textContent()).toBe('A line 3\n')
    await expect.poll(() => column.locator('[data-textpreview-path]').textContent()).toBe(join(filerA.dir!, 'notes.txt'))
    await page.screenshot({ path: join(artifacts, 'agent-flow-e28-line-preview.png'), animations: 'disabled' })

    // The preview sidebar covers the page at the narrow width, so restore the
    // ordinary layout before reopening the results panel.
    await page.setViewportSize({ width: 1280, height: 800 })
    resultsA = await openResults(page, runA)
    await previewOf(resultsA, 'RESULT.md')
    await expect.poll(() => column.locator('[data-textpreview-path]').textContent()).toBe(join(filerA.dir!, 'RESULT.md'))
    await column.getByRole('heading', { name: 'RESULT A' }).waitFor({ state: 'visible', timeout: 30_000 })

    // A Chinese, space-bearing name resolves as its own resource.
    resultsA = await openResults(page, runA)
    await previewOf(resultsA, '结果 报告.md')
    await expect.poll(() => column.locator('[data-textpreview-path]').textContent()).toBe(join(filerA.dir!, '结果 报告.md'))
    await column.getByRole('heading', { name: '结果 A' }).waitFor({ state: 'visible', timeout: 30_000 })

    // Back returns to the run surface without leaving a stale results panel.
    resultsA = await openResults(page, runA)
    await resultsA.getByRole('button', { name: 'Back to runs', exact: true }).click()
    await expect.poll(async () => await page.locator('[data-run-results]').count()).toBe(0)

    // A file deleted after the run reports not-found instead of stale content.
    // The reopened page also proves the record, not client state, owns the path.
    await rm(join(filerA.dir!, 'RESULT.md'))
    const reopenPage = await openPage(sA)
    await openResults(reopenPage, runA)
    await reopenPage.locator('[data-node="filer"] ul').first().locator('li').filter({ hasText: 'RESULT.md' })
      .getByRole('button', { name: 'Preview', exact: true }).click()
    await reopenPage.locator('[data-rightbar-col] [data-textpreview-failed="workspace-file/not-found"]')
      .waitFor({ timeout: 30_000 })

    // The same Flow in a second workspace resolves that workspace's own file.
    const secondDir = await mkdtemp(join(homedir(), 'dsh-flow-ws2-'))
    onTestFinished(async () => { await rm(secondDir, { recursive: true, force: true }) })
    const secondWorkspace = await scaffold.ctx.workspaceRegistry.create(secondDir)
    const sB = SessionId('l1-e28-b')
    await scaffold.ctx.agents.create({
      sessionId: sB,
      meta: { cwd: secondDir },
      agentOptions: scaffold.ctx.agentDefaultModel.currentSelection(),
    })
    await secondWorkspace.attachSession(sB)
    const pageB = await openPage(sB)
    await startFlowViaComposer(pageB, 'Files flow', '[CASE:E28-B1DD] [FILES] [MARK:B] Write the result.')
    const runB = await waitForRun(String(sB), 'E28-B1DD')
    const filerB = runB.nodeRuns.find(entry => entry.nodeId === 'filer')!
    expect(filerB.dir!.startsWith(secondDir)).toBe(true)
    const columnB = pageB.locator('[data-rightbar-col]')
    let resultsB = await openResults(pageB, runB)
    await resultsB.getByRole('button', { name: 'line 3', exact: true }).click()
    await expect.poll(() => columnB.locator('[data-textpreview-target="3"]').textContent()).toBe('B line 3\n')
    await expect.poll(() => columnB.locator('[data-textpreview-path]').textContent()).toBe(join(filerB.dir!, 'notes.txt'))
    resultsB = await openResults(pageB, runB)
    await previewOf(resultsB, 'RESULT.md')
    await expect.poll(() => columnB.locator('[data-textpreview-path]').textContent()).toBe(join(filerB.dir!, 'RESULT.md'))
    await columnB.getByRole('heading', { name: 'RESULT B' }).waitFor({ state: 'visible', timeout: 30_000 })
  }, 240_000)

  it('E17: an interactive node converses over several rounds and settles on the user confirmation', async () => {
    const sI = await createSession('l1-e17-i')
    const page = await openPage(sI)
    await startFlowViaComposer(page, 'Clarify flow', '[CASE:E17-I1MM] [SLOW] Clarify what the report must contain.')
    const card = page.locator('[data-flow-progress]')
    await card.waitFor({ timeout: 30_000 })

    // The scripted slow stream proves the card folds real activity, not just
    // the record. Reasoning, Writing, and — once the scripted agent calls its
    // tool — Running tools each have to appear; the transient stages are
    // recorded in-page, because the tool call itself settles in milliseconds.
    // The observer watches the document body: the card node may be replaced
    // while the roster refreshes.
    await page.evaluate(() => {
      const seen: string[] = []
      const record = (): void => {
        const text = document.querySelector('[data-flow-progress]')?.textContent ?? ''
        for (const label of ['Reasoning', 'Writing', 'Running tools']) {
          if (text.includes(label) && !seen.includes(label)) seen.push(label)
        }
      }
      record()
      new MutationObserver(record).observe(document.body, { subtree: true, childList: true, characterData: true })
      window.__flowStages = seen
    })
    const stages = new Set<string>()
    await expect.poll(async () => {
      const text = await card.innerText()
      for (const label of ['Reasoning', 'Writing', 'Running tools']) {
        if (text.includes(label)) stages.add(label)
      }
      for (const label of await page.evaluate(() => window.__flowStages ?? [])) stages.add(label)
      return [...stages]
    }, { timeout: 60_000, interval: 100 }).toEqual(expect.arrayContaining(['Reasoning', 'Writing', 'Running tools']))
    await expect.poll(async () => await card.innerText(), { timeout: 30_000 }).toContain('Flow running')
    expect(await card.innerText()).not.toContain('No new recorded activity')

    await expect.poll(async () => {
      const run = (await runsFor(String(sI)))[0]
      return run?.nodeRuns.find(entry => entry.nodeId === 'clarify')?.status
    }, { timeout: 60_000 }).toBe('conversing')
    const conversing = (await runsFor(String(sI)))[0]!
    expect(conversing.status).toBe('running')
    await page.getByText('round 1 needs more detail').waitFor({ timeout: 60_000 })
    await expect.poll(async () => await card.innerText(), { timeout: 30_000 }).toContain('Flow waiting for your reply')

    // The user answers in the interactive conversation: the card leaves the
    // waiting posture while the node works the reply — still no Result, so the
    // node returns to waiting instead of failing or settling. Round numbers
    // make each reply unique, so a stale first reply cannot satisfy the wait.
    const input = page.locator('[data-composer-input]').first()
    await input.click()
    await page.keyboard.type('Please include the budget table.')
    await page.keyboard.press('Enter')
    await expect.poll(async () => {
      const text = await card.innerText()
      return /Reasoning|Writing/.test(text) && !text.includes('Flow waiting for your reply')
    }, { timeout: 30_000, interval: 100 }).toBe(true)
    await page.getByText('round 2 needs more detail').waitFor({ timeout: 60_000 })
    expect((await runsFor(String(sI)))[0]?.nodeRuns.find(entry => entry.nodeId === 'clarify')?.status).toBe('conversing')
    await expect.poll(async () => await card.innerText(), { timeout: 30_000 }).toContain('Flow waiting for your reply')

    // Confirmation closes the conversation with the Result word; the rest runs.
    await input.click()
    await page.keyboard.type('READY-TO-PROCEED')
    await page.keyboard.press('Enter')
    await page.getByText('round 3 confirmed').waitFor({ timeout: 60_000 })
    const settled = await waitForRun(String(sI), 'E17-I1MM')
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'clarify')?.status).toBe('succeeded')
    expect(settled.nodeRuns.find(entry => entry.nodeId === 'after')?.status).toBe('succeeded')
    expect(settled.nodeRuns.some(entry => entry.status === 'running' || entry.status === 'conversing')).toBe(false)
    expect(await runsFor(String(sI))).toHaveLength(1)
    await expect.poll(async () => await card.innerText(), { timeout: 30_000 }).toContain('Flow completed')
  }, 240_000)

  it('E19: a cut wire interrupts observation and the page catches up without restarting nodes', async () => {
    const sM = await createSession('l1-e19-m')
    const page = await openPage(sM)
    const caseId = 'E19-M1QQ'
    await startFlowViaComposer(page, 'Review flow', `[CASE:${caseId}] [HOLD] Assess the data platform.`)
    // A dispatched node reads running before its child opens, so wait for the
    // recorded agent Sessions, then for the requests to actually hold.
    await expect.poll(async () => {
      const run = (await runsFor(String(sM)))[0]
      return run?.nodeRuns.filter(entry => entry.status === 'running' && entry.agentSessionId !== undefined).length
    }, { timeout: 60_000 }).toBe(3)
    const before = (await runsFor(String(sM)))[0]!
    const nodeSessions = new Map(before.nodeRuns
      .filter(entry => entry.status === 'running' && entry.agentSessionId !== undefined)
      .map(entry => [entry.nodeId, String(entry.agentSessionId)] as const))
    await expect.poll(() => callsFor(caseId), { timeout: 60_000 }).toBe(3)

    // Cut only this page's transport; the Host keeps executing the run.
    const tripwire = tripwires.at(-1)!
    const warningStart = tripwire.warnings.length
    await page.context().setOffline(true)
    // The card itself reports the interrupted observation, not a page error.
    await expect.poll(async () => await page.locator('[data-flow-progress]').innerText(), { timeout: 30_000 })
      .toContain('Status updates are interrupted')

    // The Host finishes the whole run while the page cannot observe it.
    releaseHold(caseId)
    await expect.poll(async () => (await scaffold.ctx.agentFlows.readRun(before.id)).status, { timeout: 90_000 })
      .toBe('completed')

    // Restore the wire; the page catches up to the finished run.
    await page.context().setOffline(false)
    await expect.poll(async () => await page.locator('[data-flow-progress]').innerText(), { timeout: 30_000 })
      .toContain('Flow completed')

    const after = (await runsFor(String(sM)))[0]!
    expect(String(after.id)).toBe(String(before.id))
    expect(after.nodeRuns.map(entry => entry.nodeId).sort())
      .toEqual(['end', 'engineer', 'product', 'qa', 'start', 'summary'])
    // No node restarted across the cut: the role Sessions the record opened
    // before the cut are exactly the ones the finished run reports.
    for (const [nodeId, sessionId] of nodeSessions) {
      const entry = after.nodeRuns.find(candidate => candidate.nodeId === nodeId)!
      expect(String(entry.agentSessionId), `node ${nodeId}`).toBe(sessionId)
    }
    expect(callsFor(caseId)).toBe(4)
    // Console warnings from the intentional cut are its own consequence; the
    // assertion above already proved the page recovered, so they are expected.
    // Only the expected connection-loss wording is exempt: a gap repair or
    // discontinuity after the cut still means the page did not recover cleanly.
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
  }, 240_000)

  it('E20: a page refresh keeps the in-flight run and never restarts its nodes', async () => {
    const sJ = await createSession('l1-e20-j')
    const page = await openPage(sJ)
    const caseId = 'E20-J1NN'
    await startFlowViaComposer(page, 'Review flow', `[CASE:${caseId}] [HOLD] Assess the night market.`)
    // A dispatched node reads running before its child opens, so wait for the
    // recorded agent Sessions, then for the requests to actually hold.
    await expect.poll(async () => {
      const run = (await runsFor(String(sJ)))[0]
      return run?.nodeRuns.filter(entry => entry.status === 'running' && entry.agentSessionId !== undefined).length
    }, { timeout: 60_000 }).toBe(3)
    const running = (await runsFor(String(sJ)))[0]!
    const nodeSessions = new Map(running.nodeRuns
      .filter(entry => entry.status === 'running' && entry.agentSessionId !== undefined)
      .map(entry => [entry.nodeId, String(entry.agentSessionId)] as const))
    await expect.poll(() => callsFor(caseId), { timeout: 60_000 }).toBe(3)

    const reloadWarnings = tripwires.at(-1)!.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.locator('[data-composer-input]').first().waitFor({ timeout: 30_000 })
    // The client re-reads the run state: the selector reports the in-flight run.
    await expect.poll(async () => await page.locator('button[aria-label^="Workflow"]').first().getAttribute('aria-label'), { timeout: 30_000 })
      .toContain('run in flight')

    // No duplicate run and no node work restarted by the refresh.
    const afterRefresh = await runsFor(String(sJ))
    expect(afterRefresh).toHaveLength(1)
    expect(String(afterRefresh[0]!.id)).toBe(String(running.id))
    expect((await scaffold.ctx.agentFlows.readRun(running.id)).status).toBe('running')
    for (const [nodeId, sessionId] of nodeSessions) {
      const entry = afterRefresh[0]!.nodeRuns.find(candidate => candidate.nodeId === nodeId)!
      expect(String(entry.agentSessionId), `node ${nodeId}`).toBe(sessionId)
    }
    expect(callsFor(caseId)).toBe(3)

    await scaffold.ctx.agentFlows.cancel(agentOf(sJ), running.id)
    await expect.poll(async () => (await scaffold.ctx.agentFlows.readRun(running.id)).status).toBe('cancelled')
    expect(await runsFor(String(sJ))).toHaveLength(1)
    // Cancellation stopped the held requests; it did not restart any node.
    expect(callsFor(caseId)).toBe(3)
    // The reload's connection-loss warning may surface late, after the old
    // page context finished unloading, so acknowledge it once the test's own
    // assertions are done; gap-repair and discontinuity stay fatal.
    acknowledgeReloadConnectionLoss(tripwires.at(-1)!, reloadWarnings)
  }, 240_000)
})
