import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'usage-bar',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 6 }, view: {} },
} as const

const turn = () => ({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't', reason: 'answer' as const })

// The engine spells the path the host's way, so it is matched by its end.
const sharedOf = (files: Map<string, string>) =>
  [...files.keys()].find(path => /[\\/]plugins[\\/]data[\\/]usage-bar[\\/]limits\.json$/.test(path))

const limits = (session: number, week: number) => [
  { kind: 'five_hour', percentUsed: session, resetsAt: '2099-01-01T16:00:00Z' },
  { kind: 'seven_day', percentUsed: week, resetsAt: '2099-01-05T16:00:00Z' },
]

function setup(on: Parameters<Parameters<typeof test>[1]>[1], files: Map<string, string>) {
  const clock = mock.clock(on, { now: 10_000_000 })
  mock.store(on)
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'main' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: 'done' }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return clock
}

test('the cache countdown moves every minute without a new turn', async ($, on) => {
  const files = new Map<string, string>()
  const clock = setup(on, files)
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000, tokens: 61_000 }, rateLimits: limits(10, 20) },
  }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete(turn())

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /◷/ }))?.text).toBe('◷ 60m')
  await clock.advance(60 * 1000)
  expect((await band.find({ type: 'Text', text: /◷/ }))?.text).toBe('◷ 59m')
  await clock.advance(9 * 60 * 1000)
  expect((await band.find({ type: 'Text', text: /◷/ }))?.text).toBe('◷ 50m')
  await band.unmount()
})

test('an idle session picks up a newer reading another session shared', async ($, on) => {
  const files = new Map<string, string>()
  const clock = setup(on, files)
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000, tokens: 1000 }, rateLimits: limits(10, 20) },
  }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete(turn())
  // This session wrote its own reading for the others.
  const shared = sharedOf(files)!
  expect(shared).toBeTruthy()
  expect(JSON.parse(files.get(shared)!).session.percent).toBe(10)

  // Another session measures later and spends more.
  files.set(shared,JSON.stringify({ session: { percent: 42, resetsAt: null }, week: { percent: 55, resetsAt: null }, at: 10_000_000 + 30_000 }))
  await clock.advance(60 * 1000)

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: / 42%/ })).toBeTruthy()
  expect(await band.find({ type: 'Text', text: / 55%/ })).toBeTruthy()
  await band.unmount()
})

test('a progress ring sits before each percent, filled by quarters', async ($, on) => {
  const files = new Map<string, string>()
  setup(on, files)
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 1_000_000, tokens: 95_000 }, rateLimits: limits(72, 50), cost: { usd: 2.96 } },
  }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete(turn())

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const texts = (await band.findAll({ type: 'Text' })).map(t => t.text).join(' | ')
  expect(texts).toContain('◕ 72%')
  expect(texts).toContain('◑ 50%')
  expect(texts).toContain('◔ 10%')
  expect(texts).not.toContain('█')
  await band.unmount()
})

test('the line shows the reset countdown, the context fill and the session cost', async ($, on) => {
  const files = new Map<string, string>()
  const clock = setup(on, files)
  const now = 10_000_000
  const iso = (ms: number) => new Date(now + ms).toISOString()
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 1_000_000, tokens: 225_000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 13, resetsAt: iso(8 * 60_000) },
        { kind: 'seven_day', percentUsed: 22, resetsAt: iso((13 * 60 + 48) * 60_000) },
      ],
      cost: { usd: 2.96 },
    },
  }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'você pode revisar isso para mim também', wait: false, origin: { kind: 'composer' } }).catch(() => {})
  await $.turn.complete(turn())

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const texts = (await band.findAll({ type: 'Text' })).map(t => t.text).join(' | ')
  expect(texts).toContain('(8min) US$ 2.96')
  expect(texts).toContain('(13h 48min)')
  expect(texts).toContain('(225k/1M)')
  expect(texts).toContain(' 23%')
  expect(texts).not.toContain('↻')
  // The session window resets: it drops to 0% at once.
  await clock.advance(9 * 60_000)
  const after = (await band.findAll({ type: 'Text' })).map(t => t.text).join(' | ')
  expect(after).toContain('○ 0%')
  await band.unmount()
})
