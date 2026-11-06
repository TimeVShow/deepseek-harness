/**
 * Inject-conformance guard for the client half: every `ctx.remote.<ns>` or
 * injected-face `this.remote.<ns>` namespace the sources read must be declared
 * as `remote.<ns>` in some inject array, and every declared `remote.<ns>` must
 * be read. The runtime declaration lives in
 * `mountAgentFlowPanel`'s `ctx.inject` (the loader-facing `inject` export lists
 * only pre-existing services — a self-mounted namespace there would deadlock
 * boot). The property proxy rejects undeclared namespace access at runtime
 * ("without inject"), which unit fakes that provide `remote` as a flat object
 * cannot reproduce — this scan closes that gap.
 * @module
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../src/client/', import.meta.url))

/** Collect every TypeScript source under the client half, recursively. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}${entry.name}`
    if (entry.isDirectory()) return sources(`${path}/`)
    return entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') ? [path] : []
  })
}

describe('client inject conformance', () => {
  it('reads exactly the remote namespaces its inject arrays declare', () => {
    const files = sources(root)
    const accessed = new Set<string>()
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(/\b(?:ctx|this)\.remote\.([A-Za-z][\w$]*)/g)) {
        accessed.add(match[1]!)
      }
    }
    const declared = new Set<string>()
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(/'remote\.([\w$]+)'/g)) {
        declared.add(match[1]!)
      }
    }
    expect([...accessed].sort()).toEqual([...declared].sort())
  })
})
