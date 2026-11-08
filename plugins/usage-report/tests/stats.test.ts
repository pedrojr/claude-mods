import { describe, expect, test } from 'claude-code/testing'

import { agentTypeOf, compact, parseTranscript, report, reportText, toolName } from '../hooks/stats'

const DAY = Date.parse('2026-11-08T00:00:00Z')
const at = (time: string) => `2026-11-08T${time}Z`
const line = (value: unknown) => JSON.stringify(value)

const assistant = (id: string, time: string, blocks: unknown[], extra: object = {}) =>
  line({
    type: 'assistant',
    timestamp: at(time),
    effort: 'high',
    message: {
      id,
      model: 'claude-opus-5-5',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
      content: blocks,
    },
    ...extra,
  })
const call = (id: string, name: string) => ({ type: 'tool_use', id, name, input: {} })
const result = (id: string, time: string, isError = false, extra: object = {}) =>
  line({ type: 'user', timestamp: at(time), message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] }, ...extra })

describe('one transcript', () => {
  test('counts a message once across its lines, and only from today', () => {
    const text = [
      assistant('old', '00:00:00', [], { timestamp: '2026-11-07T10:00:00Z' }),
      assistant('m1', '10:00:00', [{ type: 'thinking' }]),
      assistant('m1', '10:00:01', [call('t1', 'Bash')]),
      result('t1', '10:00:02'),
    ].join('\n')
    const stats = parseTranscript(text, DAY)
    expect(Object.keys(stats.messages)).toEqual(['m1'])
    expect(stats.messages.m1!.effort).toBe('high')
    expect(stats.calls.t1).toEqual({ tool: 'Bash', outcome: 'ok' })
  })

  test('a response written over several lines keeps its largest usage reading', () => {
    const partial = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }
    const text = [
      line({ type: 'assistant', timestamp: at('10:00:00'), message: { id: 'm1', model: 'claude-opus-5-5', usage: partial, content: [] } }),
      assistant('m1', '10:00:01', []),
    ].join('\n')
    expect(parseTranscript(text, DAY).messages.m1!.tokens).toEqual({ input: 10, output: 5, cacheRead: 100, cacheWrite: 20 })
  })

  test('tells errors, denials and retries apart', () => {
    const text = [
      assistant('m1', '10:00:00', [call('t1', 'Bash')]),
      result('t1', '10:00:01', true),
      assistant('m2', '10:00:02', [call('t2', 'Bash')]),
      result('t2', '10:00:03'),
      assistant('m3', '10:00:04', [call('t3', 'WebFetch')]),
      result('t3', '10:00:05', true, { toolDenialKind: 'permission-rule' }),
      assistant('m4', '10:00:06', [call('t4', 'Read')]),
      result('t4', '10:00:07'),
      line({ type: 'assistant', timestamp: at('10:00:08'), isApiErrorMessage: true, message: { id: 'e', model: '<synthetic>', content: [] } }),
      line({ type: 'user', timestamp: at('10:00:09'), message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
    ].join('\n')
    const stats = parseTranscript(text, DAY)
    expect(stats.calls.t1!.outcome).toBe('error')
    expect(stats.calls.t3!.outcome).toBe('denied')
    // Bash failed then Bash again: one retry. WebFetch denied then Read: none.
    expect(stats.retries).toBe(1)
    expect(stats.apiErrors).toBe(1)
    expect(stats.interrupts).toBe(1)
  })

  test('a main transcript skips side-chain lines; the subagent file reads them', () => {
    const text = assistant('s1', '10:00:00', [], { isSidechain: true })
    expect(Object.keys(parseTranscript(text, DAY).messages)).toEqual([])
    expect(Object.keys(parseTranscript(text, DAY, true).messages)).toEqual(['s1'])
  })
})

describe('the report', () => {
  test('adds files up, counting shared messages once', () => {
    const main = parseTranscript([assistant('m1', '10:00:00', [call('t1', 'Agent')]), result('t1', '10:05:00')].join('\n'), DAY)
    const sub = parseTranscript(
      [assistant('a1', '10:01:00', [call('t2', 'Grep')]), result('t2', '10:01:01', true), assistant('m1', '10:00:00', [])].join('\n'),
      DAY,
      true,
    )
    const idle = parseTranscript('', DAY)
    const r = report(
      [
        { kind: 'session', stats: main },
        { kind: 'agent', agentType: 'Explore', stats: sub },
        { kind: 'session', stats: idle },
      ],
      DAY,
      DAY + 1,
      0,
    )
    expect(r.tokens).toEqual({ input: 20, output: 10, cacheRead: 200, cacheWrite: 40 })
    expect(r.models).toEqual([{ name: 'claude-opus-5-5', count: 2, tokens: 270 }])
    expect(r.efforts).toEqual([{ name: 'high', count: 2 }])
    expect(r.tools).toMatchObject({ total: 2, ok: 1, errors: 1, denied: 0 })
    expect(r.sessions).toBe(1)
    expect(r.agents).toEqual({ total: 1, byType: [{ name: 'Explore', count: 1 }] })
    expect(reportText(r)).toContain('Tool calls: 2 · ok 1 · error 1')
  })

  test('formats numbers and reads agent types', () => {
    expect(compact(950)).toBe('950')
    expect(compact(1234)).toBe('1.2k')
    expect(compact(2_500_000)).toBe('2.5M')
    expect(agentTypeOf('{"agentType":"Explore"}')).toBe('Explore')
    expect(agentTypeOf('not json')).toBe('agent')
    expect(toolName('mcp__ccd_turn__update_plan')).toBe('update_plan')
    expect(toolName('Bash')).toBe('Bash')
  })
})
