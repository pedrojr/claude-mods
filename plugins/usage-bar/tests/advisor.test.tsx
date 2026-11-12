import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  plugin: 'usage-bar',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 140, scroll: { offset: 0, bodyRows: 6 }, view: {} },
} as const

/** An engine beneath with a context reading, usage-advisor's icon and a chip another plugin draws. */
function engine(on: On, icon: { count: number; isHidden: boolean } | undefined) {
  const ran: string[] = []
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('store.keys', () => ({ value: [] }))
  on('clock.now', () => ({ value: 10_000_000 }))
  on('session.id', () => ({ value: 'main' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, tokens: 61_000 }, rateLimits: [] } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: 'done' }))
  on('state.get', (_, e, next) => (e.plugin === 'usage-advisor' ? { value: { value: icon, version: icon ? 1 : 0 } } : next(e)))
  on('command.run', (_, e) => {
    ran.push(e.command)
    return { text: '' }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>chip</Text>
  })
  return { ran }
}

const turn = { answer: 'done', durationMs: 10, isAborted: false, turnId: 't', reason: 'answer' as const }

test("the advisor's icon ends the line, a press runs /advisor, and the chip beneath stays under it", async ($, on) => {
  const { ran } = engine(on, { count: 2, isHidden: false })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete(turn)

  const band = await $.ui.mount(BAND)
  const tree = JSON.stringify(await band.drawn())
  expect(tree.indexOf('◷')).toBeLessThan(tree.indexOf('open-advisor'))
  expect(tree.indexOf('open-advisor')).toBeLessThan(tree.indexOf('chip'))
  expect((await band.find({ type: 'Button', key: 'open-advisor' }))?.text).toBe('◆ 2')

  await band.press({ key: 'open-advisor' })
  expect(ran).toEqual(['advisor'])
  await band.unmount()
})

test('no icon without usage-advisor, or when it is hidden', async ($, on) => {
  engine(on, { count: 0, isHidden: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete(turn)
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Button', key: 'open-advisor' })).toBe(undefined)
  expect(await band.find({ type: 'Text', text: 'chip' })).toBeTruthy()
  await band.unmount()
})
