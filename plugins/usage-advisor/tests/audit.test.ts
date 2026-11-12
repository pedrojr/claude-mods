import { describe, expect, test } from 'claude-code/testing'

import { diagnose, duplicateLines, habits, modelSwitchers, parseSession, preloadOf, projectSlug, propose } from '../hooks/audit'
import type { Breakdown } from '../hooks/audit'
import { emptyLive, liveTips } from '../hooks/live'
import type { SessionRow } from '../types'

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 10, 12, 0) + minutes * 60_000).toISOString()

let n = 0
const assistant = (minutes: number, usage: Record<string, number>, content: unknown[] = [], model = 'claude-opus-5-5') =>
  JSON.stringify({ type: 'assistant', timestamp: at(minutes), effort: 'high', message: { id: `m${++n}`, model, usage, content } })
const user = (minutes: number, content: unknown) => JSON.stringify({ type: 'user', timestamp: at(minutes), message: { content } })
const read = (id: string, path: string) => ({ type: 'tool_use', id, name: 'Read', input: { file_path: path } })
const result = (id: string, chars: number) => ({ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(chars) })

const SESSION = [
  user(0, 'refatore o módulo de pagamentos'),
  assistant(0, { input_tokens: 10, output_tokens: 50, cache_creation_input_tokens: 30_000, cache_read_input_tokens: 0 }, [read('r1', '/p/big.ts')]),
  user(1, [result('r1', 20_000)]),
  assistant(1, { input_tokens: 10, output_tokens: 50, cache_creation_input_tokens: 5_000, cache_read_input_tokens: 30_000 }, [
    read('r2', '/p/big.ts'),
    { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm test' } },
    { type: 'tool_use', id: 'm1', name: 'mcp__github__get_issue', input: {} },
  ]),
  user(2, [result('r2', 20_000), result('b1', 40_000), result('m1', 100)]),
  // An hour away, then the context is written again instead of read.
  assistant(70, { input_tokens: 10, output_tokens: 50, cache_creation_input_tokens: 60_000, cache_read_input_tokens: 0 }),
  user(71, 'continue'),
  assistant(72, { input_tokens: 10, output_tokens: 50, cache_creation_input_tokens: 2_000, cache_read_input_tokens: 60_000 }, [], 'claude-sonnet-5-5'),
].join('\n')

describe('parseSession', () => {
  const s = parseSession('s1', SESSION)

  test('sums the usage of each response once', () => {
    expect(s.requests).toBe(4)
    expect(s.cacheWrite).toBe(97_000)
    expect(s.cacheRead).toBe(90_000)
    expect(s.turns).toBe(2)
  })

  test('finds the whole-file re-read and the large output', () => {
    expect(s.rereads).toEqual([{ path: '/p/big.ts', count: 2, tokens: 5_000 }])
    expect(s.bigOutputs.map(o => o.what)).toEqual(['npm test', 'big.ts', 'big.ts'])
  })

  test('finds the cold start after the pause and the model switch', () => {
    expect(s.coldStarts).toEqual([{ idleMinutes: 69, tokens: 60_000 }])
    expect(s.modelSwitches).toBe(1)
    expect(s.mcpServers).toEqual(['github'])
  })
})

const BREAKDOWN: Breakdown = {
  categories: [
    { name: 'System prompt', tokens: 3_000, kind: 'used' },
    { name: 'System tools', tokens: 12_000, kind: 'used' },
    { name: 'MCP tools', tokens: 9_000, kind: 'used' },
    { name: 'Memory files', tokens: 7_000, kind: 'used' },
    { name: 'Messages', tokens: 50_000, kind: 'used' },
    { name: 'Free space', tokens: 100_000, kind: 'free' },
  ],
  memoryFiles: [{ path: '/p/CLAUDE.md', type: 'Project', tokens: 7_000 }],
  mcpTools: [
    { name: 'mcp__github__get_issue', serverName: 'github', tokens: 1_000, isLoaded: true },
    { name: 'mcp__rea__open', serverName: 'rea', tokens: 8_000, isLoaded: true },
    { name: 'mcp__rea__close', serverName: 'rea', tokens: 500, isLoaded: false },
  ],
  agents: [],
}

describe('the audit', () => {
  const { items, total } = preloadOf(BREAKDOWN)
  const sessions: SessionRow[] = [parseSession('s1', SESSION)]
  const problems = diagnose({
    lang: 'en',
    preload: items,
    preloadTokens: total,
    preloadBasis: 'estimated',
    contextWindow: 200_000,
    sessions,
    duplicates: [],
  })

  test('the preload leaves out the conversation and deferred tools', () => {
    expect(total).toBe(31_000)
    expect(items.find(i => i.name === 'rea')).toMatchObject({ tokens: 8_000, detail: '1 tools' })
  })

  test('flags the MCP server no session called, not the one used', () => {
    const ids = problems.map(p => p.id)
    expect(ids).toContain('mcp:rea')
    expect(ids).not.toContain('mcp:github')
    expect(ids).toContain('memory:Project · /p/CLAUDE.md')
  })

  test('ranks by weight and proposes only configuration changes', () => {
    const weights = problems.map(p => p.weight)
    expect([...weights].sort((a, b) => b - a)).toEqual(weights)
    const proposals = propose(problems, items, sessions, 'en')
    expect(proposals.map(p => p.id)).toContain('mcp:rea')
    expect(proposals.every(p => p.prompt.includes('wait for my OK'))).toBe(true)
  })

  test('habits come only from evidence, at most three', () => {
    const h = habits(problems, sessions, 'pt')
    expect(h.length).toBeLessThanOrEqual(3)
    expect(h.some(x => x.includes('/clear'))).toBe(true)
    expect(habits([], [], 'en')).toEqual(['No evidence of wasteful habits in the sessions read.'])
  })
})

test('duplicateLines finds a rule kept in two memory files', () => {
  const rule = 'Never push without asking the user first.'
  const dup = duplicateLines([
    { path: 'a', text: `# A\n${rule}\nonly here, long enough to count` },
    { path: 'b', text: `${rule}\n` },
  ])
  expect(dup).toEqual([{ line: rule, paths: ['a', 'b'] }])
})

test('projectSlug names the folder as Claude Code does', () => {
  expect(projectSlug('d:\\dev\\claude-mods')).toBe('d--dev-claude-mods')
})

test('modelSwitchers reads model-router and opusplan from the settings', () => {
  const found = modelSwitchers({ model: 'opusplan', enabledPlugins: { 'model-router@claude-mods': true } }, 'en')
  expect(found.length).toBe(2)
  expect(modelSwitchers({}, 'en')).toEqual([])
})

test('liveTips puts the largest waste first', () => {
  const live = {
    ...emptyLive(),
    reads: { '/p/a.ts': { count: 3, tokens: 2_000 } },
    bigOutputs: [{ tool: 'Bash', what: 'npm test', tokens: 30_000 }],
    contextTokens: 50_000,
    contextWindow: 200_000,
  }
  const tips = liveTips(live, 'pt')
  expect(tips.map(t => t.id)).toEqual(['big', 'reread:/p/a.ts'])
  expect(tips[0]!.text).toContain('npm test')
})
