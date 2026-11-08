import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'usage-bar',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} },
} as const

const turn = (agentId?: string) => ({
  answer: 'done',
  durationMs: 10,
  isAborted: false,
  turnId: 't',
  reason: 'answer' as const,
  ...(agentId ? { agentId } : {}),
})

test("a subagent's turn leaves the main prompt cache countdown alone", async ($, on) => {
  const clock = mock.clock(on, { now: 10_000_000 })
  mock.store(on)
  on('session.id', () => ({ value: 'main' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000, tokens: 61_000 }, rateLimits: [] },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: 'done' }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // The main conversation answers; its cache has 60 minutes left.
  await $.turn.complete(turn())
  // 30 minutes later only a subagent finishes a turn.
  await clock.advance(30 * 60 * 1000)
  await $.turn.complete(turn('agent-1'))

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /◷/ }))?.text).toBe('◷ 30m')
  await band.unmount()
})
