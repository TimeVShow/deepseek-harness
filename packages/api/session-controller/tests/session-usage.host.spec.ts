/**
 * The sessionUsage seam carries plugin-owned occupancy facts into summaries
 * and blank adoption: a Session that recorded durable plugin usage (for
 * example an orchestration run persisted under its identity) is listed as
 * occupied while its blank bit stays untouched, and adopting it as a new
 * blank conversation is refused with `session/occupied`. An absent seam keeps
 * every legacy summary and adoption behavior unchanged.
 */

import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionUsage } from '../src/index.ts'
import { createSessionTestRemote, type TestSessionRemote } from './test-remote.ts'

async function harness(): Promise<{
  ctx: Context
  remote: TestSessionRemote
  attach: (session: Session) => Promise<void>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  return {
    ctx,
    remote: createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' }),
    attach: async (session) => {
      await ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
    },
  }
}

describe('summary occupied = plugin usage recorded', () => {
  it('republishes a live summary when the provider reports a new occupation', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const occupiedIds = new Set<Session['id']>()
    const listeners = new Set<(id: Session['id']) => void>()
    const subscribe = (listener: (id: Session['id']) => void): (() => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
    onTestFinished(ctx.provide('sessionUsage', {
      isOccupied: sessionId => occupiedIds.has(sessionId),
      subscribe,
    } satisfies SessionUsage))
    createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    // The controller bound at apply time because the provider already existed.
    expect(listeners.size).toBe(1)

    const session = ctx.sessions.create(undefined, { meta: { cwd: '/tmp' } })
    await ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
    const added: Array<{ sessionId: Session['id']; occupied: boolean }> = []
    ctx.on('api-session/added', (summary) => {
      added.push({ sessionId: summary.sessionId, occupied: summary.occupied })
    })

    occupiedIds.add(session.id)
    for (const listener of [...listeners]) listener(session.id)
    expect(added.at(-1)).toEqual({ sessionId: session.id, occupied: true })

    // A cold identity has no live summary to republish.
    const count = added.length
    for (const listener of [...listeners]) listener(SessionId('cold-session'))
    expect(added.length).toBe(count)
  })

  it('lists occupied next to the untouched blank bit and defaults to false without a provider', async () => {
    const { ctx, remote, attach } = await harness()
    const occupiedSession = ctx.sessions.create(undefined, { meta: { cwd: '/tmp' } })
    await attach(occupiedSession)
    const plainSession = ctx.sessions.create(undefined, { meta: { cwd: '/tmp' } })
    await attach(plainSession)
    const occupiedIds = new Set([occupiedSession.id])
    const dispose = ctx.provide('sessionUsage', {
      isOccupied: sessionId => occupiedIds.has(sessionId),
    } satisfies SessionUsage)

    const result = await remote.list({})
    if (!result.ok) throw new Error('list failed')
    const occupiedRow = result.value.items.find(item => item.sessionId === occupiedSession.id)
    const plainRow = result.value.items.find(item => item.sessionId === plainSession.id)
    expect(occupiedRow).toMatchObject({ occupied: true, blank: true })
    expect(plainRow).toMatchObject({ occupied: false, blank: true })

    dispose()
    const withoutProvider = await remote.list({})
    if (!withoutProvider.ok) throw new Error('list failed')
    expect(withoutProvider.value.items.find(item => item.sessionId === occupiedSession.id))
      .toMatchObject({ occupied: false, blank: true })
  })

  it('refuses to adopt an occupied identity and still adopts an unoccupied blank', async () => {
    const { ctx, remote, attach } = await harness()
    const occupiedSession = ctx.sessions.create(undefined, { meta: { cwd: '/tmp' } })
    await attach(occupiedSession)
    const plainSession = ctx.sessions.create(undefined, { meta: { cwd: '/tmp' } })
    await attach(plainSession)
    const occupiedIds = new Set([occupiedSession.id])
    onTestFinished(ctx.provide('sessionUsage', {
      isOccupied: sessionId => occupiedIds.has(sessionId),
    } satisfies SessionUsage))

    const refusal = await remote.create({ sessionId: occupiedSession.id })
    expect(refusal.ok).toBe(false)
    if (refusal.ok) throw new Error('create unexpectedly succeeded')
    expect(refusal.error.code).toBe('session/occupied')
    expect(refusal.error.details).toEqual({ sessionId: occupiedSession.id })

    // The refusal is a pure gate: the occupied Session stays blank-listed.
    const listed = await remote.list({})
    if (!listed.ok) throw new Error('list failed')
    expect(listed.value.items.find(item => item.sessionId === occupiedSession.id))
      .toMatchObject({ occupied: true, blank: true })

    const adopted = await remote.create({ sessionId: plainSession.id })
    expect(adopted.ok).toBe(true)
    if (!adopted.ok) throw new Error('create failed')
    expect(adopted.value.sessionId).toBe(plainSession.id)
  })
})
