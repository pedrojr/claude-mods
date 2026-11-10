import { expect, test } from 'claude-code/testing'

import { shownSessions } from '../hooks/agents'
import type { SessionView } from '../types'

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
  plugin: 'workspace',
  component: 'Pane',
  requestId: 'workspace',
  props: {
    title: 'Workspace',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'workspace',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 6 }, view: {} },
} as const

const session = (over: Partial<SessionView>): SessionView => ({
  sessionId: 's',
  hostSessionId: null,
  name: 'n',
  cwd: '/',
  entrypoint: 'CLI',
  isSelf: false,
  active: false,
  lastAt: 0,
  lastLine: null,
  agents: [],
  ...over,
})

const agent = (id: string, active: boolean) => ({ id, label: id, type: 'Explore', active, lastAt: 0, lastLine: null, parentId: null })

test('idle sessions and agents hide behind a count, this session stays', () => {
  const all = [
    session({ sessionId: 'self', isSelf: true, agents: [agent('a1', true), agent('a2', false)] }),
    session({ sessionId: 'busy', active: true }),
    session({ sessionId: 'idle', agents: [agent('a3', false)] }),
  ]
  const compact = shownSessions(all, false)
  expect(compact.sessions.map(s => s.sessionId)).toEqual(['self', 'busy'])
  expect(compact.sessions[0]?.agents.map(a => a.id)).toEqual(['a1'])
  // a2, the idle session and its agent a3.
  expect(compact.hidden).toBe(3)
  const full = shownSessions(all, true)
  expect(full.sessions.length).toBe(3)
  expect(full.hidden).toBe(0)
})

test('another active session shows, and its title opens it in the desktop app', async ($, on) => {
  const opened: string[][] = []
  let panes = 0
  on('command.register', () => ({ value: { command: 'workspace' } }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('session.cwd', () => ({ value: 'D:/work' }))
  on('agent.list', () => ({ value: [] }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'self' }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : e.name === 'OS' ? 'Windows_NT' : undefined }))
  on('fs.list', (_, e) => ({
    value: /[\\/]sessions$/.test(e.path) ? [{ name: '7.json', kind: 'file', size: 1, mtimeMs: 1, isLink: false }] : [],
  }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 10, mtimeMs: NOW - 1000, isLink: false } }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('.jsonl') ? TRANSCRIPT : REGISTRY }))
  on('process.run', (_, e) => {
    // git is not what this test looks at: no repository here.
    if (e.argv[0] === 'git') {
      return { value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
    }
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
  expect(await ui.find({ type: 'Text', text: 'AGENTS' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: 'CHANGES' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: 'DIFF' })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /Refactor billing/ }))?.text).toBe('Refactor billing')
  expect((await ui.find({ type: 'Text', text: /billing\.ts/ }))?.text).toBe('↳ Edit: billing.ts')
  await ui.press({ key: 'open:session:other' })
  expect(opened).toEqual([
    ['rundll32', 'url.dll,FileProtocolHandler', 'claude://code/continue?session=local_abc-123&source=desktop_action'],
  ])

  // Folding a section leaves its title line.
  await ui.press({ key: 'fold:agents' })
  expect(await ui.find({ type: 'Text', text: /Refactor billing/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: 'AGENTS' })).toBeTruthy()
  await ui.unmount()

  // The terminal opened nothing by itself; the band's button does.
  expect(panes).toBe(0)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /active/ }))?.text).toContain('1 other session active')
  await band.press({ key: 'open-workspace' })
  expect(panes).toBe(1)
  await band.unmount()
})
