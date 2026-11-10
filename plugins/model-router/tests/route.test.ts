import { describe, expect, test } from 'claude-code/testing'

import {
  LARGE_CONTEXT_TOKENS,
  isAck,
  mentionedPaths,
  parseRouteArgs,
  parseVerdict,
  pick,
  quickRules,
  statusText,
  verdict,
} from '../hooks/route'

describe('pick', () => {
  test('maps each difficulty to a model and effort', async () => {
    expect(pick('simple', false)).toEqual({ model: 'haiku', effort: 'medium' })
    expect(pick('standard', false)).toEqual({ model: 'sonnet', effort: 'medium' })
    expect(pick('hard', false)).toEqual({ model: 'opus', effort: 'medium' })
    expect(pick('critical', false)).toEqual({ model: 'opus', effort: 'high' })
  })

  test('a large context raises the effort, and moves simple off haiku', async () => {
    expect(pick('simple', true)).toEqual({ model: 'sonnet', effort: 'medium' })
    expect(pick('standard', true)).toEqual({ model: 'sonnet', effort: 'high' })
    expect(pick('hard', true)).toEqual({ model: 'opus', effort: 'high' })
  })

  test('large means more than 100k tokens', async () => {
    expect(verdict('standard', LARGE_CONTEXT_TOKENS, 'rules', '').effort).toBe('medium')
    expect(verdict('standard', LARGE_CONTEXT_TOKENS + 1, 'rules', '').effort).toBe('high')
  })
})

describe('quickRules', () => {
  test('a short command is simple', async () => {
    expect(quickRules('rode os testes')).toBe('simple')
    expect(quickRules('git status')).toBe('simple')
    expect(quickRules('What is the default port?')).toBe('simple')
  })

  test('anything else goes to the classifier', async () => {
    expect(quickRules('rode uma investigação do memory leak no worker')).toBe(null)
    expect(quickRules('Add pagination to the orders endpoint and update the tests')).toBe(null)
    expect(quickRules('')).toBe(null)
    expect(quickRules(`run ${'x'.repeat(200)}`)).toBe(null)
  })
})

describe('parseVerdict', () => {
  test('reads the JSON line, even with text around it', async () => {
    expect(parseVerdict('{"difficulty":"hard","reason":"cross-module refactor"}')).toEqual({
      difficulty: 'hard',
      reason: 'cross-module refactor',
    })
    expect(parseVerdict('Sure: {"difficulty":"Simple"}')).toEqual({ difficulty: 'simple', reason: '' })
  })

  test('refuses what is not a verdict', async () => {
    expect(parseVerdict('hard')).toBe(null)
    expect(parseVerdict('{"difficulty":"extreme"}')).toBe(null)
    expect(parseVerdict('{not json}')).toBe(null)
  })
})

test('mentionedPaths finds @ file mentions and skips agents and resources', async () => {
  expect(mentionedPaths('see @src/a.ts, and @"docs/my file.md" with @agent-reviewer and @db:users')).toEqual([
    'src/a.ts',
    'docs/my file.md',
  ])
  expect(mentionedPaths('mail me at me@example.com')).toEqual([])
})

test('parseRouteArgs', async () => {
  expect(parseRouteArgs('')).toEqual({ kind: 'show' })
  expect(parseRouteArgs(' off ')).toEqual({ kind: 'off' })
  expect(parseRouteArgs('auto')).toEqual({ kind: 'auto' })
  expect(parseRouteArgs('Opus HIGH')).toEqual({ kind: 'set', model: 'opus', effort: 'high' })
  expect(parseRouteArgs('sonnet')).toEqual({ kind: 'set', model: 'sonnet', effort: 'medium' })
  expect(parseRouteArgs('opus max').kind).toBe('error')
})

test('statusText', async () => {
  const route = {
    ...verdict('hard', 10, 'classifier', 'x'),
    mode: 'auto' as const,
    baseModel: 'm',
    baseEffort: null,
    lockedAt: 0,
  }
  expect(statusText(null, false)).toBe(undefined)
  expect(statusText(route, false)).toBe('route opus/medium')
  expect(statusText(route, true)).toBe('route opus/medium · paused')
  expect(statusText({ ...route, mode: 'off' }, false)).toBe('route off')
})

test('isAck tells a bare go-ahead from a task', () => {
  for (const t of ['ok', 'OK!', 'sim, pode seguir', 'continue', 'go ahead', 'Continua por favor']) expect(isAck(t)).toBe(true)
  for (const t of ['ok, now fix the login bug', 'continue the migration of orders', 'rode os testes', '']) expect(isAck(t)).toBe(false)
})
