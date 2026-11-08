import { describe, expect, test } from 'claude-code/testing'

import { activityFromTranscript, parseRegistry, projectSlug, sortSessions } from '../hooks/sessions'

const line = (value: unknown) => JSON.stringify(value)

describe('sessions', () => {
  test('parses a registry entry', async () => {
    const row = parseRegistry(
      line({
        pid: 26760,
        sessionId: 'abc',
        cwd: 'D:\\dev\\claude-mods',
        name: 'Commit and mod',
        status: 'busy',
        entrypoint: 'claude-desktop',
        statusUpdatedAt: 5,
      }),
    )
    expect(row).toEqual({
      sessionId: 'abc',
      pid: 26760,
      name: 'Commit and mod',
      cwd: 'D:\\dev\\claude-mods',
      status: 'busy',
      entrypoint: 'desktop',
      since: 5,
    })
    expect(parseRegistry('not json')).toBe(null)
    expect(parseRegistry(line({ pid: 1 }))).toBe(null)
  })

  test('names the project folder as Claude Code does', async () => {
    expect(projectSlug('D:\\dev\\claude-mods')).toBe('D--dev-claude-mods')
    expect(projectSlug('/home/me/x.y')).toBe('-home-me-x-y')
  })

  test('takes the last tool call, skipping subagent lines', async () => {
    const text = [
      line({ type: 'user', message: { content: 'Fix the login bug' } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }] } }),
      line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'x' } }] } }),
      '',
    ].join('\n')
    expect(activityFromTranscript(text)).toBe('Bash: Run tests')
  })

  test('falls back to the reply, then the prompt', async () => {
    const reply = [line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.\nMore' }] } })].join('\n')
    expect(activityFromTranscript(reply)).toBe('Done.')
    const prompt = line({ type: 'user', message: { content: 'Summarize the notes' } })
    expect(activityFromTranscript(prompt)).toBe('Summarize the notes')
  })

  test('puts busy sessions first', async () => {
    const base = { pid: 1, cwd: '', entrypoint: 'CLI', activity: null, isSelf: false }
    const sorted = sortSessions([
      { ...base, sessionId: 'a', name: 'a', status: 'idle', since: 9 },
      { ...base, sessionId: 'b', name: 'b', status: 'busy', since: 1 },
    ])
    expect(sorted.map(row => row.sessionId)).toEqual(['b', 'a'])
  })
})
