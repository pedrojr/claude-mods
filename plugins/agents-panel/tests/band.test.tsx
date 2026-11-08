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

const REGISTRY = JSON.stringify({
  pid: 7,
  sessionId: 'other',
  cwd: 'D:\\work',
  name: 'Refactor billing',
  status: 'busy',
  entrypoint: 'claude-desktop',
  statusUpdatedAt: 400,
})
const TRANSCRIPT = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'D:\\work\\billing.ts' } }] },
})

test('another busy session shows in the pane with what it does', async ($, on) => {
  on('command.register', () => ({ value: { command: 'agents-panel' } }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('agent.list', () => ({ value: [] }))
  on('clock.now', () => ({ value: 1000 }))
  on('session.id', () => ({ value: 'self' }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('fs.list', () => ({ value: [{ name: '7.json', kind: 'file', size: 1, mtimeMs: 1, isLink: false }] }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 10, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('.jsonl') ? TRANSCRIPT : REGISTRY }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({
    plugin: 'agents-panel',
    component: 'Pane',
    requestId: 'agents-panel',
    surface: 'desktop',
    props: {
      title: 'Agents',
      isFocused: false,
      bodyColumns: 50,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 30 },
      view: {},
    },
  })
  expect((await ui.find({ type: 'Text', text: /Refactor billing/ }))?.text).toBe('Refactor billing')
  expect((await ui.find({ type: 'Text', text: /billing\.ts/ }))?.text).toBe('↳ Edit: billing.ts')
  await ui.unmount()
})
