import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

/** The engine beneath: a context reading of 75% of the window after one answer. */
function engine(on: On, env: Record<string, string> = {}) {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'advisor' } }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1_000 }))
  on('env.get', (_, e) => ({ value: env[e.name] }))
  on('settings.read', () => ({ value: {} }))
  on('session.messages', () => ({ value: [] }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, tokens: 150_000 }, rateLimits: [] } }))
  on('turn.complete', () => ({ text: 'done' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
}

const answered = { answer: 'done', durationMs: 10, isAborted: false, turnId: 't', reason: 'answer' as const }
const run = ($: any, args: string) =>
  $.command.run({ command: 'advisor', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } }) as Promise<{
    text?: string
  }>

test('the icon state counts the tips, and /advisor hide hides it', async ($, on) => {
  const seen: unknown[] = []
  engine(on)
  on('state.set', (_, e, next) => {
    if (e.plugin === 'usage-advisor' && e.key === 'icon') seen.push(e.value)
    return next(e)
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete(answered)
  expect(seen.at(-1)).toEqual({ count: 1, isHidden: false })

  await run($, 'hide')
  expect(seen.at(-1)).toEqual({ count: 1, isHidden: true })
})

test('a session with no tip still publishes the icon at start, so usage-bar draws it', async ($, on) => {
  const seen: unknown[] = []
  engine(on)
  on('state.set', (_, e, next) => {
    if (e.plugin === 'usage-advisor' && e.key === 'icon') seen.push(e.value)
    return next(e)
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(seen).toEqual([{ count: 0, isHidden: false }])
})

test("the advisor speaks the operating system's language, whatever the chat's", async ($, on) => {
  engine(on, { OS: 'Windows_NT' })
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'pt-BR\r\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'please add the tests for this module and the other one', wait: false, origin: { kind: 'composer' } })
  // An unknown argument answers the usage line, in the language in force.
  expect((await run($, '?')).text).toMatch(/^Uso:/)
})
