import { expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, On } from 'claude-code'

type Sent = { model: string; effort: unknown }

const USAGE = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

/** The engine beneath the plugin: answers what the mod calls, records each request it sends. */
function engine(
  on: On,
  classifierReply: string | Error | ((prompt: string) => string),
  stored: Record<string, unknown> = {},
  contextTokens?: number,
) {
  const sent: Sent[] = []
  const calls = { classifier: 0 }
  mock.store(on, stored)
  mock.clock(on, { now: 1_000 })
  on('command.register', () => ({ value: { command: 'route' } }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000, ...(contextTokens === undefined ? {} : { tokens: contextTokens }) },
      rateLimits: [],
    },
  }))
  on('ui.status', () => ({ value: undefined }))
  on('fs.stat', () => {
    throw new Error('no such file')
  })
  on('model.complete', (_, e) => {
    calls.classifier += 1
    if (classifierReply instanceof Error) throw classifierReply
    const text = typeof classifierReply === 'function' ? classifierReply(e.prompt) : classifierReply
    return { value: { isAnswered: true, text, usage: USAGE } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.step', async function* (_, e) {
    sent.push({ model: e.model, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return { sent, calls }
}

async function step($: EngineInterface | any, model = 'claude-opus-5-5', effort: string = 'medium', agentId?: string) {
  const stream = $.turn.step({ turnId: 't', index: 0, model, effort, messageCount: 1, ...(agentId ? { agentId } : {}) })
  for await (const _ of stream) {
    // drain
  }
}

const submit = ($: any, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

const runRoute = ($: any, args: string) =>
  $.command.run({
    command: 'route',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  }) as Promise<{ text?: string }>

test('the first prompt picks the route, and it stays for the session', async ($, on) => {
  const { sent, calls } = engine(on, '{"difficulty":"hard","reason":"refactor across modules"}')
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  await submit($, 'Refactor the billing module so invoices and refunds share one ledger')
  expect(calls.classifier).toBe(1)
  await step($)
  expect(sent[0]).toEqual({ model: 'opus', effort: 'medium' })

  // A bare go-ahead is not rated; requests keep the locked route.
  await submit($, 'ok, pode seguir')
  expect(calls.classifier).toBe(1)
  await step($)
  expect(sent[1]).toEqual({ model: 'opus', effort: 'medium' })

  // The person ran /model: the router steps aside.
  await step($, 'claude-sonnet-5-5')
  expect(sent[2]).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium' })

  // The person ran /effort: the model stays routed, the effort is theirs.
  await step($, 'claude-opus-5-5', 'high')
  expect(sent[3]).toEqual({ model: 'opus', effort: 'high' })

  // Subagent requests are left alone.
  await step($, 'claude-haiku-5-5', 'medium', 'agent-1')
  expect(sent[4]).toEqual({ model: 'claude-haiku-5-5', effort: 'medium' })
})

test('a short command routes to haiku without asking the classifier', async ($, on) => {
  const { sent, calls } = engine(on, '{"difficulty":"critical"}')
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  await submit($, 'git status')
  await step($)
  expect(calls.classifier).toBe(0)
  expect(sent[0]).toEqual({ model: 'haiku', effort: 'low' })
})

const BY_TASK = (prompt: string) => {
  if (prompt.includes('typo')) return '{"difficulty":"simple","rigor":"light","confidence":"high","reason":"typo"}'
  if (prompt.includes('race condition')) {
    return '{"difficulty":"critical","rigor":"careful","confidence":"high","reason":"concurrency bug"}'
  }
  if (prompt.includes('same for')) return '{"difficulty":"simple","rigor":"light","confidence":"low","reason":"unseen work"}'
  if (prompt.includes('ledger')) return '{"difficulty":"hard","rigor":"careful","confidence":"high","reason":"refactor"}'
  return '{"difficulty":"standard","rigor":"normal","confidence":"high","reason":"feature"}'
}

test('a later prompt sets the effort again and never moves the model down', async ($, on) => {
  const { sent, calls } = engine(on, BY_TASK)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  await submit($, 'Refactor the billing module so invoices and refunds share one ledger')
  await step($)
  expect(sent[0]).toEqual({ model: 'opus', effort: 'high' })

  await submit($, 'fix the typo in the README title')
  expect(calls.classifier).toBe(2)
  await step($)
  expect(sent[1]).toEqual({ model: 'opus', effort: 'low' })

  // An unsure rating is raised a tier and never lowers the effort in force.
  await submit($, 'Add pagination to the orders endpoint and update the tests')
  await step($)
  expect(sent[2]).toEqual({ model: 'opus', effort: 'medium' })
  await submit($, 'do the same for the others')
  await step($)
  expect(sent[3]).toEqual({ model: 'opus', effort: 'medium' })
})

test('a session locked on a weak model moves up when a later prompt needs it', async ($, on) => {
  const { sent } = engine(on, BY_TASK)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  await submit($, 'git status')
  await step($)
  expect(sent[0]).toEqual({ model: 'haiku', effort: 'low' })

  await submit($, 'Add pagination to the orders endpoint and update the tests')
  await step($)
  expect(sent[1]).toEqual({ model: 'sonnet', effort: 'medium' })

  await submit($, 'There is a race condition between payment and stock reservation; fix it')
  await step($)
  expect(sent[2]).toEqual({ model: 'opus', effort: 'high' })
  expect((await runRoute($, '')).text).toContain('Moved up from haiku.')
})

test('on a long conversation one model up is not worth the re-read: the effort goes up instead', async ($, on) => {
  const { sent } = engine(on, BY_TASK, {}, 60_000)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  await submit($, 'Add pagination to the orders endpoint and update the tests')
  await step($)
  expect(sent[0]).toEqual({ model: 'sonnet', effort: 'medium' })

  await submit($, 'Refactor the billing module so invoices and refunds share one ledger')
  await step($)
  expect(sent[1]).toEqual({ model: 'sonnet', effort: 'xhigh' })
})

test('a rating that fails on a later prompt leaves the route as it is', async ($, on) => {
  let isDown = false
  const { sent } = engine(on, prompt => (isDown ? 'no idea' : BY_TASK(prompt)))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  await submit($, 'Refactor the billing module so invoices and refunds share one ledger')
  await step($)
  isDown = true
  await submit($, 'Add pagination to the orders endpoint and update the tests')
  await step($)
  expect(sent[1]).toEqual({ model: 'opus', effort: 'high' })
})

test('an override of an automatic route is written to the corrections log', async ($, on) => {
  engine(on, BY_TASK)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expect((await runRoute($, 'log')).text).toContain('none yet')

  await submit($, 'Add pagination to the orders endpoint and update the tests')
  await step($)
  // /model, seen on two requests: logged once.
  await step($, 'claude-fable-5-2')
  await step($, 'claude-fable-5-2')
  // Back on the session model, then /effort.
  await step($, 'claude-opus-5-5', 'high')
  // /route <model> on the automatic route.
  await runRoute($, 'opus high')

  const log = (await runRoute($, 'log')).text ?? ''
  expect(log).toContain('Corrections (3)')
  expect(log).toContain('model: sonnet/medium -> claude-fable-5-2 (standard/normal, classifier) "Add pagination')
  expect(log).toContain('effort: sonnet/medium -> high')
  expect(log).toContain('route: sonnet/medium -> opus/high')
})

test('/route eval rates the evaluation set and reports the misses', async ($, on) => {
  const { calls } = engine(on, '{"difficulty":"standard","rigor":"normal","confidence":"high","reason":"x"}')
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const report = (await runRoute($, 'eval')).text ?? ''
  expect(report).toContain('Evaluation: 62 prompts.')
  expect(report).toContain('too low')
  expect(report).toContain('Misses, model too low first:')
  // The short commands of the set are rated by the rules, without a model call.
  expect(calls.classifier < 62).toBe(true)
})

test('an unreadable classifier reply falls back to sonnet/medium', async ($, on) => {
  const { sent } = engine(on, 'I think it is quite hard')
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  await submit($, 'Add pagination to the orders endpoint and update the tests')
  await step($)
  expect(sent[0]).toEqual({ model: 'sonnet', effort: 'medium' })
})

test('a classifier the engine refuses to call falls back to sonnet/medium', async ($, on) => {
  const { sent } = engine(on, new Error('model haiku is not in availableModels'))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  await submit($, 'Add pagination to the orders endpoint and update the tests')
  await step($)
  expect(sent[0]).toEqual({ model: 'sonnet', effort: 'medium' })
})

test('a resumed session keeps its route even when launched on another model', async ($, on) => {
  const saved = {
    model: 'opus',
    effort: 'high',
    difficulty: 'critical',
    contextTokens: 0,
    source: 'classifier',
    reason: 'migration',
    mode: 'auto',
    baseModel: 'claude-opus-5-5',
    baseEffort: 'medium',
    lockedAt: 1_000,
  }
  const { sent, calls } = engine(on, '{"difficulty":"simple"}', { 'route:session-1': saved })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  await submit($, 'keep going')
  await step($, 'claude-sonnet-5-5', 'medium')
  expect(calls.classifier).toBe(0)
  expect(sent[0]).toEqual({ model: 'opus', effort: 'high' })
})

test('/route sets, shows and turns off the route', async ($, on) => {
  const { sent } = engine(on, '{"difficulty":"simple"}')
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const set = await runRoute($, 'opus high')
  expect(set.text).toContain('opus/high')
  await step($, 'claude-sonnet-5-5')
  expect(sent[0]).toEqual({ model: 'opus', effort: 'high' })

  const shown = await runRoute($, '')
  expect(shown.text).toContain('opus/high (set by /route')

  await runRoute($, 'off')
  await step($, 'claude-sonnet-5-5')
  expect(sent[1]).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium' })
})

test('a generic Agent call gets a model and effort; others keep theirs', async ($, on) => {
  engine(on, '{"difficulty":"standard","reason":"tests in a few files"}')
  const ran: Array<Record<string, unknown>> = []
  on('tool.call', (_, e) => {
    ran.push({ ...e })
    return { result: {} }
  })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: 'Agent', description: 'write tests', prompt: 'Write unit tests for the parser module' })
  expect(ran[0]).toMatchObject({ model: 'sonnet', effort: 'medium' })

  await $.tool.call({ tool: 'Agent', description: 'run suite', prompt: 'run npm test', subagent_type: 'Explore' })
  expect(ran[1]).toMatchObject({ model: 'haiku', effort: 'low' })

  await $.tool.call({ tool: 'Agent', description: 'fix', prompt: 'Fix it', subagent_type: 'cavecrew-builder' })
  expect(ran[2]?.model).toBe(undefined)

  await $.tool.call({ tool: 'Agent', description: 'design', prompt: 'Design it', model: 'opus', effort: 'high' })
  expect(ran[3]).toMatchObject({ model: 'opus', effort: 'high' })

  const shown = await runRoute($, '')
  expect(shown.text).toContain('Subagents (4):')
})

test('the delegation section is added last to the system prompt', async ($, on) => {
  engine(on, '{}')
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }))

  const composed = await $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'],
    tools: [],
    outputStyle: null,
    traits: [],
  })
  const last = composed.sections[composed.sections.length - 1]
  expect(last?.id).toBe('model-router:delegation')
  expect(last?.scope).toBe('session')
})

test('a /clear lets the next prompt route afresh', async ($, on) => {
  const { sent, calls } = engine(on, '{"difficulty":"hard"}')
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await submit($, 'git log')
  await step($)
  expect(sent[0]?.model).toBe('haiku')

  await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: {} as any })
  await submit($, 'Investigate why the cache invalidation drops writes under load')
  await step($)
  expect(calls.classifier).toBe(1)
  expect(sent[1]?.model).toBe('opus')
})

test('a first prompt with no task keeps the session model instead of locking on haiku', async ($, on) => {
  const { sent, calls } = engine(on, '{"difficulty":"simple","reason":"just ok"}')
  on('session.messages', () => ({ value: [] }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  await submit($, 'ok')
  expect(calls.classifier).toBe(0)
  await step($)
  expect(sent[0]).toEqual({ model: 'claude-opus-5-5', effort: 'medium' })

  // The route is settled at the start: a real task later does not switch models.
  await submit($, 'Refactor the billing module so invoices and refunds share one ledger')
  expect(calls.classifier).toBe(0)
  await step($)
  expect(sent[1]).toEqual({ model: 'claude-opus-5-5', effort: 'medium' })
  expect((await runRoute($, '')).text).toContain('held no task')
})

test('"continue" on a resumed session rates the task it was resumed with', async ($, on) => {
  const { sent, calls } = engine(on, '{"difficulty":"critical","reason":"schema migration"}')
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'Migrate the orders table to the new schema without downtime', toolUses: [] },
      { role: 'assistant', text: 'Plan ready.', toolUses: [] },
      { role: 'user', text: 'ok', toolUses: [] },
    ],
  }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  await submit($, 'continue')
  expect(calls.classifier).toBe(1)
  await step($)
  expect(sent[0]).toEqual({ model: 'opus', effort: 'high' })
})
