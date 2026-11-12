import { describe, expect, test } from 'claude-code/testing'

import type { EvalOutcome, Rating, Route } from '../types'
import { EVAL_SET } from '../hooks/evalset'
import {
  LARGE_CONTEXT_TOKENS,
  SMALL_CONTEXT_TOKENS,
  classifierPrompt,
  correctionsText,
  evalReport,
  hedge,
  isAck,
  mentionedPaths,
  nextModel,
  parseRouteArgs,
  parseVerdict,
  pick,
  quickRules,
  rerouted,
  statusText,
  verdict,
} from '../hooks/route'

const lockedRoute = (v: ReturnType<typeof verdict>): Route => ({
  ...v,
  mode: 'auto',
  baseModel: 'm',
  baseEffort: null,
  lockedAt: 0,
  escalatedFrom: null,
  noted: null,
})

describe('pick', () => {
  test('the difficulty picks the model', async () => {
    expect(pick('simple').model).toBe('haiku')
    expect(pick('standard').model).toBe('sonnet')
    expect(pick('hard').model).toBe('opus')
    expect(pick('critical').model).toBe('opus')
  })

  test('the rigor picks the effort', async () => {
    expect(pick('standard', 'light').effort).toBe('low')
    expect(pick('standard', 'normal').effort).toBe('medium')
    expect(pick('standard', 'careful').effort).toBe('high')
    expect(pick('hard', 'deep').effort).toBe('xhigh')
  })

  test('a rigor left out follows the difficulty', async () => {
    expect(pick('simple')).toEqual({ model: 'haiku', effort: 'low' })
    expect(pick('standard')).toEqual({ model: 'sonnet', effort: 'medium' })
    expect(pick('hard')).toEqual({ model: 'opus', effort: 'medium' })
    expect(pick('critical')).toEqual({ model: 'opus', effort: 'high' })
  })

  test('a simple task stays at medium or below, a critical one at high or above', async () => {
    expect(pick('simple', 'deep').effort).toBe('medium')
    expect(pick('critical', 'light').effort).toBe('high')
    expect(pick('critical', 'deep').effort).toBe('xhigh')
  })

  test('a large context raises the effort, and moves simple off haiku', async () => {
    expect(pick('simple', 'light', true)).toEqual({ model: 'sonnet', effort: 'medium' })
    expect(pick('standard', 'normal', true)).toEqual({ model: 'sonnet', effort: 'high' })
    expect(pick('hard', 'normal', true)).toEqual({ model: 'opus', effort: 'high' })
    expect(pick('hard', 'deep', true)).toEqual({ model: 'opus', effort: 'xhigh' })
  })

  test('large means more than 100k tokens', async () => {
    expect(verdict('standard', LARGE_CONTEXT_TOKENS, 'rules', '').effort).toBe('medium')
    expect(verdict('standard', LARGE_CONTEXT_TOKENS + 1, 'rules', '').effort).toBe('high')
  })
})

describe('hedge', () => {
  const rating = (difficulty: Rating['difficulty'], rigor: Rating['rigor'], confidence: Rating['confidence']): Rating => ({
    difficulty,
    rigor,
    confidence,
    reason: '',
  })

  test('a sure rating is left alone', async () => {
    expect(hedge(rating('simple', 'light', 'high'))).toMatchObject({ difficulty: 'simple', rigor: 'light' })
  })

  test('an unsure rating below hard goes up a tier', async () => {
    expect(hedge(rating('simple', 'light', 'low'))).toMatchObject({ difficulty: 'standard', rigor: 'normal' })
    expect(hedge(rating('standard', 'careful', 'low'))).toMatchObject({ difficulty: 'hard', rigor: 'careful' })
  })

  test('an unsure rating from hard on gets more rigor, up to careful', async () => {
    expect(hedge(rating('hard', 'normal', 'low'))).toMatchObject({ difficulty: 'hard', rigor: 'careful' })
    expect(hedge(rating('critical', 'careful', 'low'))).toMatchObject({ difficulty: 'critical', rigor: 'careful' })
    expect(hedge(rating('critical', 'deep', 'low'))).toMatchObject({ difficulty: 'critical', rigor: 'deep' })
  })
})

describe('a later prompt on a locked route', () => {
  test('the model never moves down, the effort follows the prompt', async () => {
    const current = lockedRoute(verdict({ difficulty: 'hard', rigor: 'careful' }, 50_000, 'classifier', 'x'))
    const next = rerouted(current, verdict('simple', 50_000, 'rules', 'short command'))
    expect(next.model).toBe('opus')
    expect(next.effort).toBe('low')
    expect(next.escalatedFrom).toBe(null)
  })

  test('haiku to opus moves up whatever the context', async () => {
    const current = lockedRoute(verdict('simple', 80_000, 'rules', 'x'))
    const next = rerouted(current, verdict('hard', 80_000, 'classifier', 'y'))
    expect(next.model).toBe('opus')
    expect(next.escalatedFrom).toBe('haiku')
  })

  test('one model up moves only while the conversation is small, or for a critical task', async () => {
    const current = lockedRoute(verdict('standard', 0, 'classifier', 'x'))
    expect(nextModel(current, verdict('hard', SMALL_CONTEXT_TOKENS, 'classifier', 'y'))).toBe('opus')
    expect(nextModel(current, verdict('hard', SMALL_CONTEXT_TOKENS + 1, 'classifier', 'y'))).toBe('sonnet')
    expect(nextModel(current, verdict('critical', 90_000, 'classifier', 'y'))).toBe('opus')
  })

  test('a prompt held on the weaker model gets one effort level more', async () => {
    const current = lockedRoute(verdict('standard', 0, 'classifier', 'x'))
    const next = rerouted(current, verdict('hard', 60_000, 'classifier', 'y'))
    expect(next).toMatchObject({ model: 'sonnet', effort: 'high' })
  })

  test('an unsure rating never lowers the effort', async () => {
    const current = lockedRoute(verdict({ difficulty: 'hard', rigor: 'careful' }, 0, 'classifier', 'x'))
    const unsure = verdict({ difficulty: 'standard', rigor: 'normal', confidence: 'low' }, 0, 'classifier', 'y')
    expect(rerouted(current, unsure)).toMatchObject({ model: 'opus', effort: 'high' })
  })
})

describe('quickRules', () => {
  test('a short command is simple', async () => {
    expect(quickRules('rode os testes')).toBe('simple')
    expect(quickRules('git status')).toBe('simple')
    expect(quickRules('What is the default port?')).toBe('simple')
    // A start that ends in an accented letter: `\b` would miss it.
    expect(quickRules('o que é um hook?')).toBe('simple')
    expect(quickRules('rodando os testes de novo')).toBe(null)
  })

  test('anything else goes to the classifier', async () => {
    expect(quickRules('rode uma investigação do memory leak no worker')).toBe(null)
    expect(quickRules('Add pagination to the orders endpoint and update the tests')).toBe(null)
    expect(quickRules('')).toBe(null)
    expect(quickRules(`run ${'x'.repeat(200)}`)).toBe(null)
  })

  test('never calls simple a prompt the evaluation set labels harder', async () => {
    const wrong = EVAL_SET.filter(c => c.difficulty !== 'simple' && quickRules(c.text) !== null).map(c => c.text)
    expect(wrong).toEqual([])
  })
})

describe('parseVerdict', () => {
  test('reads the JSON line, even with text around it', async () => {
    expect(parseVerdict('{"difficulty":"hard","rigor":"careful","confidence":"low","reason":"unknown cause"}')).toEqual({
      difficulty: 'hard',
      rigor: 'careful',
      confidence: 'low',
      reason: 'unknown cause',
    })
    expect(parseVerdict('Sure: {"difficulty":"Simple"}')).toEqual({
      difficulty: 'simple',
      rigor: 'light',
      confidence: 'high',
      reason: '',
    })
  })

  test('a rigor it does not know follows the difficulty', async () => {
    expect(parseVerdict('{"difficulty":"critical","rigor":"extreme"}')?.rigor).toBe('careful')
  })

  test('refuses what is not a verdict', async () => {
    expect(parseVerdict('hard')).toBe(null)
    expect(parseVerdict('{"difficulty":"extreme"}')).toBe(null)
    expect(parseVerdict('{not json}')).toBe(null)
  })
})

test('classifierPrompt keeps the start and the end of a long prompt', async () => {
  const text = `START ${'x'.repeat(9000)} END`
  const prompt = classifierPrompt('followup', text, 10)
  expect(prompt).toContain('START')
  expect(prompt).toContain('[cut]')
  expect(prompt).toContain('END')
  expect(prompt).toContain('A later prompt in a running session')
  expect(prompt.length < 6500).toBe(true)
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
  expect(parseRouteArgs('log')).toEqual({ kind: 'log' })
  expect(parseRouteArgs('eval')).toEqual({ kind: 'eval' })
  expect(parseRouteArgs('Opus HIGH')).toEqual({ kind: 'set', model: 'opus', effort: 'high' })
  expect(parseRouteArgs('sonnet')).toEqual({ kind: 'set', model: 'sonnet', effort: 'medium' })
  expect(parseRouteArgs('fable xhigh')).toEqual({ kind: 'set', model: 'fable', effort: 'xhigh' })
  expect(parseRouteArgs('haiku low')).toEqual({ kind: 'set', model: 'haiku', effort: 'low' })
  expect(parseRouteArgs('opus max').kind).toBe('error')
})

test('statusText', async () => {
  const route = lockedRoute(verdict('hard', 10, 'classifier', 'x'))
  expect(statusText(null, false)).toBe(undefined)
  expect(statusText(route, false)).toBe('route opus/medium')
  expect(statusText(route, true)).toBe('route opus/medium · paused')
  expect(statusText({ ...route, mode: 'off' }, false)).toBe('route off')
})

test('isAck tells a bare go-ahead from a task', () => {
  for (const t of ['ok', 'OK!', 'sim, pode seguir', 'continue', 'go ahead', 'Continua por favor', 'keep going']) {
    expect(isAck(t)).toBe(true)
  }
  for (const t of ['ok, now fix the login bug', 'continue the migration of orders', 'rode os testes', '']) {
    expect(isAck(t)).toBe(false)
  }
})

test('correctionsText lists what the person overrode', async () => {
  expect(correctionsText([])).toContain('none yet')
  const text = correctionsText([
    {
      at: 1,
      kind: 'model',
      from: 'sonnet/medium',
      to: 'claude-opus-5-5',
      difficulty: 'standard',
      rigor: 'normal',
      source: 'classifier',
      task: 'Add pagination',
    },
  ])
  expect(text).toContain('Corrections (1)')
  expect(text).toContain('model: sonnet/medium -> claude-opus-5-5 (standard/normal, classifier) "Add pagination"')
})

describe('the evaluation set', () => {
  test('has at least 60 prompts and no duplicate', async () => {
    expect(EVAL_SET.length >= 60).toBe(true)
    expect(new Set(EVAL_SET.map(c => c.text)).size).toBe(EVAL_SET.length)
  })

  test('the report counts misses on each side, model too low first', async () => {
    const outcome = (text: string, want: EvalOutcome['want'], got: EvalOutcome['got']): EvalOutcome => ({
      text,
      want,
      got,
      source: 'classifier',
    })
    const report = evalReport([
      outcome('right', { model: 'sonnet', effort: 'medium' }, { model: 'sonnet', effort: 'medium' }),
      outcome('model high', { model: 'sonnet', effort: 'medium' }, { model: 'opus', effort: 'medium' }),
      outcome('model low', { model: 'opus', effort: 'high' }, { model: 'sonnet', effort: 'high' }),
      outcome('effort low', { model: 'opus', effort: 'high' }, { model: 'opus', effort: 'medium' }),
    ])
    expect(report).toContain('Evaluation: 4 prompts.')
    expect(report).toContain('Model: 2 right (50%), 1 too low, 1 too high.')
    expect(report).toContain('Effort: 3 right (75%), 1 too low, 0 too high.')
    expect(report).toContain('Both right: 1 (25%).')
    const lines = report.split('\n')
    expect(lines[lines.indexOf('Misses, model too low first:') + 1]).toContain('model low')
  })
})
