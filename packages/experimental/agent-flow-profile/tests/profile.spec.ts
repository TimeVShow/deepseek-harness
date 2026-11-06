/** The experimental bundle must carry one parseable, explicit Agent Flow layer. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

describe('Agent Flow profile bundle', () => {
  it('declares a public parseable layer with the flow service, runtime, and panel', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      private?: boolean
      publishConfig?: { access?: string }
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.private).toBeUndefined()
    expect(manifest.publishConfig?.access).toBe('public')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies).toMatchObject({
      '@deepseek-ai/dsh-experimental-agent-flow': 'workspace:*',
      '@deepseek-ai/dsh-experimental-agent-flow-runtime': 'workspace:*',
      '@deepseek-ai/dsh-experimental-client-ui-agent-flow': 'workspace:*',
    })

    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    expect(Array.isArray(parsed)).toBe(true)
    const patches = parsed as {
      id?: string
      disabled?: boolean
      config?: Record<string, unknown>
      insert?: { id?: string; name?: string; config?: Record<string, unknown> }[]
    }[]
    const inserted = patches.flatMap(patch => patch.insert ?? [])
    expect(inserted.find(entry => entry.id === 'agent-flow')).toMatchObject({
      name: '@deepseek-ai/dsh-experimental-agent-flow',
      config: { executor: 'graph', maxRuns: 200 },
    })
    expect(inserted.find(entry => entry.id === 'agent-flow-runtime')).toMatchObject({
      name: '@deepseek-ai/dsh-experimental-agent-flow-runtime',
      config: { executor: 'graph', provider: 'spawn', maxConcurrentAgents: 4, maxConversationTurns: 16 },
    })
    expect(inserted.find(entry => entry.id === 'ui-agent-flow')).toMatchObject({
      name: '@deepseek-ai/dsh-experimental-client-ui-agent-flow',
    })
  })
})
