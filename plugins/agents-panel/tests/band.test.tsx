import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'agents-panel',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 6,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

const AGENT = { id: 'a1', description: 'Map repo', type: 'Explore', status: 'completed' as const }

test('a closed pane leaves a button above the prompt that opens it', async ($, on) => {
  let opens = 0
  on('command.register', () => ({ value: { command: 'agents-panel' } }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('agent.list', () => ({ value: [AGENT] }))
  on('ui.open', () => {
    opens += 1
    return { value: { isPlaced: true } }
  })
  on('clock.now', () => ({ value: 1000 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // Stands for the engine's own drawing when the band yields.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /agent/ }))?.text).toContain('1 agent done')
    await ui.unmount()
  }
  // The terminal opens nothing by itself.
  expect(opens).toBe(0)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'open-agents' })
  expect(opens).toBe(1)
  await ui.unmount()
})
