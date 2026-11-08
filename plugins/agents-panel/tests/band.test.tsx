import { expect, test } from 'claude-code/testing'

const NOW = 10_000_000

const REGISTRY = JSON.stringify({
  pid: 7,
  sessionId: 'other',
  hostSessionId: 'local_abc-123',
  cwd: 'D:\\work',
  name: 'Refactor billing',
  status: 'busy',
  entrypoint: 'claude-desktop',
})
const TRANSCRIPT = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'D:\\work\\billing.ts' } }] },
})

const PANE = {
  plugin: 'agents-panel',
  component: 'Pane',
  requestId: 'agents-panel',
  props: {
    title: 'Agents',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'agents-panel',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 6 }, view: {} },
} as const

test('another active session shows, and its title opens it in the desktop app', async ($, on) => {
  const opened: string[][] = []
  let panes = 0
  on('command.register', () => ({ value: { command: 'agents-panel' } }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('agent.list', () => ({ value: [] }))
  on('clock.now', () => ({ value: NOW }))
  on('session.id', () => ({ value: 'self' }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : e.name === 'OS' ? 'Windows_NT' : undefined }))
  on('fs.list', (_, e) => ({
    value: /[\\/]sessions$/.test(e.path) ? [{ name: '7.json', kind: 'file', size: 1, mtimeMs: 1, isLink: false }] : [],
  }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 10, mtimeMs: NOW - 1000, isLink: false } }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('.jsonl') ? TRANSCRIPT : REGISTRY }))
  on('process.run', (_, e) => {
    opened.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => {
    panes += 1
    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Refactor billing/ }))?.text).toBe('Refactor billing')
  expect((await ui.find({ type: 'Text', text: /billing\.ts/ }))?.text).toBe('↳ Edit: billing.ts')
  await ui.press({ key: 'open:session:other' })
  expect(opened).toEqual([
    ['rundll32', 'url.dll,FileProtocolHandler', 'claude://code/continue?session=local_abc-123&source=desktop_action'],
  ])
  await ui.unmount()

  // The terminal opened nothing by itself; the band's button does.
  expect(panes).toBe(0)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /active/ }))?.text).toContain('1 other session active')
  await band.press({ key: 'open-agents' })
  expect(panes).toBe(1)
  await band.unmount()
})
