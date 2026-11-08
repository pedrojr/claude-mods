import { describe, expect, test } from 'claude-code/testing'

import {
  agentIdOf,
  desktopLink,
  lastLineOf,
  openUrlArgv,
  ordered,
  parseAgentMeta,
  parseRegistry,
  projectSlug,
  visible,
} from '../hooks/sessions'
import type { AgentView, SessionView } from '../types'

const line = (value: unknown) => JSON.stringify(value)
const HOUR = 60 * 60 * 1000

const session = (over: Partial<SessionView>): SessionView => ({
  sessionId: 's',
  hostSessionId: null,
  name: 's',
  cwd: '',
  entrypoint: 'CLI',
  isSelf: false,
  active: false,
  lastAt: 0,
  lastLine: null,
  agents: [],
  ...over,
})

const agent = (over: Partial<AgentView>): AgentView => ({
  id: 'a',
  label: 'a',
  type: 'Explore',
  active: false,
  lastAt: 0,
  lastLine: null,
  parentId: null,
  ...over,
})

describe('registry and meta', () => {
  test('parses a desktop session entry', async () => {
    const row = parseRegistry(
      line({
        pid: 1,
        sessionId: 'abc',
        hostSessionId: 'local_6c0905fb-84e0',
        cwd: 'D:\\dev\\claude-mods',
        name: 'Commit and mod',
        status: 'busy',
        entrypoint: 'claude-desktop',
      }),
    )
    expect(row).toEqual({
      sessionId: 'abc',
      hostSessionId: 'local_6c0905fb-84e0',
      name: 'Commit and mod',
      cwd: 'D:\\dev\\claude-mods',
      entrypoint: 'desktop',
      busy: true,
    })
    expect(parseRegistry('not json')).toBe(null)
    expect(parseRegistry(line({ pid: 1, sessionId: 'x', hostSessionId: 'local_a&b=c' }))?.hostSessionId).toBe(null)
  })

  test('reads a subagent meta file and its id', async () => {
    expect(parseAgentMeta(line({ agentType: 'general-purpose', description: 'Review module 2', finished: true }))).toEqual({
      label: 'Review module 2',
      type: 'general-purpose',
      finished: true,
    })
    expect(agentIdOf('agent-a0e2a31e0a2b5b622.jsonl')).toBe('a0e2a31e0a2b5b622')
    expect(agentIdOf('agent-a0e2a31e0a2b5b622.meta.json')).toBe(null)
  })

  test('names the project folder as Claude Code does', async () => {
    expect(projectSlug('D:\\dev\\claude-mods')).toBe('D--dev-claude-mods')
  })
})

describe('last line', () => {
  test('takes the last tool call, skipping side-chain lines in a main transcript', async () => {
    const text = [
      line({ type: 'user', message: { content: 'Fix the login bug' } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }] } }),
      line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'x' } }] } }),
    ].join('\n')
    expect(lastLineOf(text)).toBe('Bash: Run tests')
    expect(lastLineOf(text, true)).toBe('Grep: x')
  })

  test('falls back to the reply, then the prompt', async () => {
    expect(lastLineOf(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.\nMore' }] } }))).toBe('Done.')
    expect(lastLineOf(line({ type: 'assistant', message: { content: [{ type: 'text', text: '## Wrote **the** `file`' }] } }))).toBe('Wrote the file')
    expect(lastLineOf(line({ type: 'user', message: { content: 'Summarize the notes' } }))).toBe('Summarize the notes')
  })
})

describe('what shows', () => {
  test('keeps active or warm items, drops cold ones', async () => {
    const now = 10 * HOUR
    const shown = visible(
      [
        session({ sessionId: 'cold', lastAt: now - 2 * HOUR }),
        session({ sessionId: 'warm', lastAt: now - 10 * 60 * 1000 }),
        session({ sessionId: 'busy', active: true, lastAt: now - 3 * HOUR }),
        session({ sessionId: 'host', lastAt: now - 3 * HOUR, agents: [agent({ id: 'x', active: true, lastAt: now - 3 * HOUR })] }),
        session({ sessionId: 'mixed', lastAt: now, agents: [agent({ id: 'old', lastAt: now - 2 * HOUR }), agent({ id: 'new', lastAt: now - 1000 })] }),
      ],
      now,
      HOUR,
    )
    expect(shown.map(s => s.sessionId)).toEqual(['busy', 'host', 'mixed', 'warm'])
    expect(shown.find(s => s.sessionId === 'mixed')?.agents.map(a => a.id)).toEqual(['new'])
  })

  test('nests agents under their parent, active first', async () => {
    const tree = ordered([
      agent({ id: 'done', lastAt: 5 }),
      agent({ id: 'p', active: true, lastAt: 1 }),
      agent({ id: 'c', active: true, parentId: 'p', lastAt: 2 }),
    ]).map(({ agent, depth }) => `${agent.id}:${depth}`)
    expect(tree).toEqual(['p:0', 'c:1', 'done:0'])
  })
})

describe('opening a session', () => {
  test('builds the desktop link and the OS opener', async () => {
    const url = desktopLink('local_6c0905fb-84e0')
    expect(url).toBe('claude://code/continue?session=local_6c0905fb-84e0&source=desktop_action')
    expect(openUrlArgv(url, true, false)).toEqual(['rundll32', 'url.dll,FileProtocolHandler', url])
    expect(openUrlArgv(url, false, true)).toEqual(['open', url])
    expect(openUrlArgv(url, false, false)).toEqual(['xdg-open', url])
  })
})
