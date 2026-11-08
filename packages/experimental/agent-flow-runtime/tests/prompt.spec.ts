import { describe, expect, it } from 'vitest'
import { assembleConversationPrompt, assemblePrompt, parseResult } from '../src/prompt.ts'

describe('assemblePrompt', () => {
  it('assembles instruction, user request, and workspace directory', () => {
    expect(assemblePrompt({
      instruction: 'classify the topic',
      userMessage: 'write about bugs',
      sources: [],
      dir: '/work/.dsh/flows/run-1/00-a1',
      resultWords: [],
    })).toBe([
      'classify the topic',
      '## User request\nwrite about bugs',
      '## Your workspace directory\nWrite every document you produce into this directory and nowhere else:\n/work/.dsh/flows/run-1/00-a1',
    ].join('\n\n'))
  })

  it('omits the user request section when the node disables it', () => {
    const prompt = assemblePrompt({ instruction: 'run', sources: [], dir: '/dir', resultWords: [] })
    expect(prompt).toBe('run\n\n## Your workspace directory\nWrite every document you produce into this directory and nowhere else:\n/dir')
  })

  it('keeps an interactive request out of the runtime context', () => {
    const prompt = assembleConversationPrompt({
      instruction: 'clarify',
      interactive: true,
      userMessage: 'build a sorter',
      sources: [],
      dir: '/dir',
      resultWords: ['done'],
    })
    expect(prompt.request).toBe('build a sorter')
    expect(prompt.context).toContain('## Conversation')
    expect(prompt.context).toContain('## Routing')
    expect(prompt.context).not.toContain('build a sorter')
    expect(prompt.context).not.toContain('## User request')
  })

  it('renders handoff sections with file lists and empty-file placeholders', () => {
    const prompt = assemblePrompt({
      instruction: 'continue',
      sources: [
        { name: 'Draft', handoff: 'first handoff', files: ['/work/00-a1/report.md', '/work/00-a1/notes.txt'] },
        { name: 'Review', handoff: 'looks fine', files: [] },
      ],
      dir: '/work/01-b',
      resultWords: [],
    })
    expect(prompt).toContain('## Handoff from Draft\nfirst handoff\n\nFiles:\n- /work/00-a1/report.md\n- /work/00-a1/notes.txt')
    expect(prompt).toContain('## Handoff from Review\nlooks fine\n\nFiles:\nNo files.')
  })

  it('appends the routing section with its exact vocabulary', () => {
    const prompt = assemblePrompt({
      instruction: 'review the draft',
      sources: [],
      dir: '/dir',
      resultWords: ['approved', 'rejected'],
    })
    expect(prompt.endsWith('## Routing\nEnd your final message with one line `Result: <word>` where <word> is exactly one of: "approved", "rejected".')).toBe(true)
  })

  it('renders the role ahead of the instruction', () => {
    expect(assemblePrompt({
      instruction: 'clarify the request',
      persona: 'You are a senior engineer.',
      sources: [],
      dir: '/dir',
      resultWords: [],
    })).toBe([
      '## Your role\nYou are a senior engineer.',
      'clarify the request',
      '## Your workspace directory\nWrite every document you produce into this directory and nowhere else:\n/dir',
    ].join('\n\n'))
  })

  it('states the conversation protocol ahead of the routing section for an interactive node', () => {
    const prompt = assemblePrompt({
      instruction: 'clarify the request',
      interactive: true,
      sources: [],
      dir: '/dir',
      resultWords: ['done'],
    })
    expect(prompt).toContain('## Conversation\nYou talk with the user directly in this session.')
    /* The user's go-ahead gates the rest of the flow, so the protocol demands it. */
    expect(prompt).toContain('ask the user plainly whether to start the rest of the work, and wait for the answer.')
    expect(prompt).toContain('Only after the user agrees, write the documents this step owes')
    expect(prompt.indexOf('## Conversation')).toBeLessThan(prompt.indexOf('## Routing'))
  })
})

describe('parseResult', () => {
  it('reads the word from the last non-empty line', () => {
    expect(parseResult('the review is done\nResult: approved')).toBe('approved')
    expect(parseResult('Result:   rejected  \n\n')).toBe('rejected')
    expect(parseResult('text\nResult: approved\n')).toBe('approved')
  })

  it('returns undefined without a Result line on the last non-empty line', () => {
    expect(parseResult('')).toBeUndefined()
    expect(parseResult('  \n\n')).toBeUndefined()
    expect(parseResult('no result here')).toBeUndefined()
    expect(parseResult('Result: approved\nbut more text after')).toBeUndefined()
    expect(parseResult('Result:')).toBeUndefined()
  })
})
