import { expect, test } from 'claude-code/testing'

import { diffArgv, MAX_CHARS, parseDiff } from '../hooks/diff'
import { parseStatus } from '../hooks/git'

const PANE = {
  plugin: 'changed-files',
  component: 'Pane',
  requestId: 'changed-files',
  props: {
    title: 'Changes',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

// Staged README, README edited again, a staged rename, an untracked file, a deletion.
const STATUS = [
  '## main...origin/main [ahead 2]',
  'MM README.md',
  'R  hooks/new.ts',
  'hooks/old.ts',
  '?? notes/todo.md',
  ' D gone.txt',
  '',
].join('\0')

const DIFF = [
  'diff --git a/notes/todo.md b/notes/todo.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/notes/todo.md',
  '@@ -0,0 +1,2 @@',
  '+first',
  '+second',
  '',
].join('\n')

const CHANGE = { path: 'hooks/git.ts', origPath: null, status: 'M' as const, staged: false, untracked: false }

test('parseStatus splits porcelain output into VS Code groups', () => {
  const parsed = parseStatus(STATUS)
  expect(parsed.branch).toBe('main')
  expect(parsed.ahead).toBe(2)
  expect(parsed.staged.map(c => `${c.status} ${c.path}`)).toEqual(['R hooks/new.ts', 'M README.md'])
  expect(parsed.staged[0]?.origPath).toBe('hooks/old.ts')
  expect(parsed.changes.map(c => `${c.status} ${c.path}`)).toEqual(['D gone.txt', 'U notes/todo.md', 'M README.md'])
  expect(parsed.merge).toEqual([])
})

test('a conflict goes to Merge Changes', () => {
  const parsed = parseStatus(['## main', 'UU src/app.ts', ''].join('\0'))
  expect(parsed.merge.map(c => `${c.status} ${c.path}`)).toEqual(['! src/app.ts'])
  expect(parsed.changes).toEqual([])
})

test('parseDiff keeps the hunks and counts the lines', () => {
  const parsed = parseDiff(DIFF)
  expect(parsed.hunks.startsWith('@@ -0,0 +1,2 @@')).toBe(true)
  expect(parsed.added).toBe(2)
  expect(parsed.removed).toBe(0)
  expect(parseDiff('diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n').isBinary).toBe(true)
})

test('a long diff is cut at a hunk boundary', () => {
  const hunk = ['@@ -1,1 +1,1 @@', '-' + 'a'.repeat(1000), '+' + 'b'.repeat(1000)].join('\n')
  const parsed = parseDiff(Array.from({ length: 200 }, () => hunk).join('\n'))
  expect(parsed.isTruncated).toBe(true)
  expect(parsed.hunks.length).toBeLessThanOrEqual(MAX_CHARS)
  expect(parsed.hunks.split('\n').at(-1)?.startsWith('+')).toBe(true)
})

test('diffArgv picks the side', () => {
  expect(diffArgv({ ...CHANGE, staged: true }).includes('--cached')).toBe(true)
  expect(diffArgv({ ...CHANGE, untracked: true, status: 'U' }).slice(-3)).toEqual(['--', '/dev/null', 'hooks/git.ts'])
  expect(diffArgv(CHANGE).includes('--cached')).toBe(false)
})

test('the pane lists the files, and a click shows the diff below', async ($, on) => {
  const runs: { argv: string[]; cwd: string | undefined }[] = []
  on('command.register', () => ({ value: { command: 'changes' } }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('session.cwd', () => ({ value: 'D:/work' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    runs.push({ argv: [...e.argv], cwd: e.init?.cwd })
    const stdout = e.argv.includes('rev-parse') ? 'D:/work\n' : e.argv.includes('diff') ? DIFF : STATUS
    // `git diff --no-index` exits 1 when the files differ.
    const exitCode = e.argv.includes('--no-index') ? 1 : 0
    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.session.start({ cwd: 'D:/work', surface: 'terminal', isInteractive: true })
  await $.command.run({
    command: 'changes',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^Staged Changes/ }))?.text).toContain('2')
  expect(await ui.find({ type: 'Text', text: /old\.ts → new\.ts/ })).toBeTruthy()
  expect(await ui.find({ type: 'Code' })).toBeFalsy()

  // A click shows the diff under the list, read from the repository root.
  await ui.press({ key: 'open:untracked:notes/todo.md' })
  const diffRun = runs.find(run => run.argv.includes('diff'))
  expect(diffRun?.cwd).toBe('D:/work')
  expect(diffRun?.argv.slice(-3)).toEqual(['--', '/dev/null', 'notes/todo.md'])
  expect(await ui.find({ type: 'Code' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: '+2' })).toBeTruthy()

  // A second click on the same file hides it.
  await ui.press({ key: 'open:untracked:notes/todo.md' })
  expect(await ui.find({ type: 'Code' })).toBeFalsy()
  await ui.unmount()
})
