import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { DiffView, FileChange, PaneState, Selection, Snapshot } from '../types'
import { diffArgv, parseDiff } from './diff'
import { changeKey, parseStatus, splitPath, statusColor } from './git'

const PANE = 'changed-files'
const TITLE = 'Changes'
const COMMAND = 'changes'
// How often git status (and the selected file's diff) runs while the pane is open.
const POLL_MS = 3000
// Columns the docked pane asks for in a fullscreen terminal (the agents pane asks the same).
const DOCK_COLUMNS = 52
// The pane opens this long after the session starts, so it lands below the agents pane.
const OPEN_DELAY_MS = 1500
// Tools whose run may change the working tree.
const WRITERS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell'])

const EMPTY: Snapshot = {
  root: null,
  branch: null,
  ahead: 0,
  behind: 0,
  merge: [],
  staged: [],
  changes: [],
  isTruncated: false,
  error: null,
}

const NO_DIFF: DiffView = {
  key: '',
  hunks: '',
  added: 0,
  removed: 0,
  isBinary: false,
  isTruncated: false,
  isCombined: false,
  error: null,
}

// Change a tag when its type's fields change: it drops what an earlier version stored.
const snapshot = atom({ plugin: 'changed-files', key: 'snapshot' } as const, EMPTY, { shape: 'snapshot-1' })
const selection = atom({ plugin: 'changed-files', key: 'selection' } as const, null as Selection, { shape: 'selection-2' })
const diff = atom({ plugin: 'changed-files', key: 'diff' } as const, NO_DIFF, { shape: 'diff-1' })
const pane = atom({ plugin: 'changed-files', key: 'pane' } as const, { isOpen: false, closedByPerson: false } as PaneState)

// The pane is a view only: none of its own failures may get in the way of a turn.
const ignore = (): void => {}

let poller: { cancel: () => void } | null = null
// The repository root, found once per session (a reload finds it again).
let rootOf: { cwd: string; root: string | null } | null = null

async function findRoot($: Engine): Promise<string | null> {
  const cwd = await $.session.cwd()
  if (rootOf?.cwd === cwd) return rootOf.root
  const result = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd })
  const root = result.exitCode === 0 ? result.stdout.trim().replace(/\\/g, '/') || null : null
  rootOf = { cwd, root }
  return root
}

async function readStatus($: Engine): Promise<Snapshot> {
  let root: string | null
  try {
    root = await findRoot($)
  } catch {
    return { ...EMPTY, error: 'git did not run. Is it installed and on PATH?' }
  }
  if (!root) return { ...EMPTY, error: 'Not a git repository.' }
  const result = await $.process.run(['git', 'status', '--porcelain=v1', '-b', '-z', '--untracked-files=all'], { cwd: root })
  if (result.exitCode !== 0) return { ...EMPTY, root, error: result.stderr.trim().split('\n')[0] || 'git status failed.' }
  return { root, ...parseStatus(result.stdout), error: null }
}

async function readDiff($: Engine, picked: NonNullable<Selection>): Promise<DiffView> {
  const view = { ...NO_DIFF, key: changeKey(picked) }
  try {
    const result = await $.process.run(diffArgv(picked), { cwd: picked.root })
    // `--no-index` exits 1 when the files differ, which they always do there.
    if (result.exitCode > 1 || (result.exitCode === 1 && !picked.untracked)) {
      return { ...view, error: result.stderr.trim().split('\n')[0] || `git diff exited ${result.exitCode}.` }
    }
    return { ...view, ...parseDiff(result.stdout) }
  } catch (error) {
    return { ...view, error: String(error) }
  }
}

// Each value is written only when it changed, so an idle poll redraws nothing.
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

async function refreshDiff($: Engine): Promise<void> {
  const picked = await read($, selection)
  const next = picked ? await readDiff($, picked) : NO_DIFF
  if (!same(await read($, diff), next)) await update($, diff, () => next)
}

async function refresh($: Engine): Promise<void> {
  const next = await readStatus($).catch(error => ({ ...EMPTY, error: String(error) }))
  if (!same(await read($, snapshot), next)) await update($, snapshot, () => next)
  await refreshDiff($)
  // Poll only while the pane is drawn; a closed pane refreshes after tools and turns.
  const { isOpen } = await read($, pane)
  if (isOpen && !poller) poller = $.clock.every(POLL_MS, () => refresh($).catch(ignore))
  if (!isOpen && poller) {
    poller.cancel()
    poller = null
  }
}

/** Opens the pane; `asked` is true when the person's own command or press asks for it. */
async function openPane($: Engine, asked: boolean): Promise<string> {
  const opened = await $.ui.open({ id: PANE, title: TITLE, columns: DOCK_COLUMNS, ...(asked ? { focus: true } : {}) })
  await update($, pane, state => ({
    isOpen: opened.isPlaced,
    closedByPerson: asked ? false : state.closedByPerson,
  }))
  await refresh($)
  return opened.isPlaced ? 'Changes pane opened.' : `Changes pane waits: ${opened.reason}`
}

/** App surfaces open the pane by themselves, after the agents pane; the terminal waits for /changes. */
async function openIfApp($: Engine): Promise<void> {
  if ((await read($, pane)).closedByPerson) return
  const surfaces = await $.session.surfaces()
  if (!surfaces.some(s => s !== 'terminal')) return
  await $.clock.sleep(OPEN_DELAY_MS)
  await openPane($, false)
}

/** A click on a file shows its diff; a click on the file already shown hides it. */
async function toggle($: Engine, change: FileChange): Promise<void> {
  const { root } = await read($, snapshot)
  if (!root) return
  const current = await read($, selection)
  const isSame = current !== null && changeKey(current) === changeKey(change)
  await update($, selection, () => (isSame ? null : { ...change, root }))
  await refreshDiff($)
}

async function clear($: Engine): Promise<void> {
  await update($, selection, () => null)
  await refreshDiff($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Show the files changed in this repository and their diffs, as VS Code does' })
    const result = await next(e)
    refresh($).catch(ignore)
    openIfApp($).catch(ignore)
    return result
  })

  on('session.attach', async ($, e, next) => {
    const result = await next(e)
    if (e.surface !== 'terminal') openIfApp($).catch(ignore)
    return result
  })

  on('command.run', { command: COMMAND }, async $ => {
    try {
      return { text: await openPane($, true) }
    } catch (error) {
      return { text: `Changes pane could not open: ${String(error)}` }
    }
  })

  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE) {
      await update($, pane, state => ({
        isOpen: false,
        closedByPerson: state.closedByPerson || e.origin.kind === 'person',
      })).catch(ignore)
      refresh($).catch(ignore)
    }
    return result
  })

  // An edit or a command may change the tree: refresh as soon as it ends.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (WRITERS.has(String(e.tool))) refresh($).catch(ignore)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    refresh($).catch(ignore)
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const picked = await read($, selection)
    const view = await read($, diff)
    const selectedKey = picked ? changeKey(picked) : null
    const total = snap.merge.length + snap.staged.length + snap.changes.length

    const row = (change: FileChange) => {
      const key = changeKey(change)
      const { name, dir } = splitPath(change.path)
      const isSelected = key === selectedKey
      const from = change.origPath ? `${splitPath(change.origPath).name} → ` : ''
      return (
        <Box key={key} flexDirection="row" paddingLeft={1}>
          <Button key={`open:${key}`} plain onPress={() => void toggle($, change).catch(ignore)}>
            <Text color={statusColor(change.status, change.untracked)} weight="bold">
              {change.status}
            </Text>{' '}
            <Text weight={isSelected ? 'bold' : 'regular'} color={isSelected ? 'suggestion' : undefined} wrap="truncate-end">
              {isSelected ? '▶ ' : ''}
              {from}
              {name}
            </Text>
            {dir ? <Text dimColor> {dir}</Text> : ''}
          </Button>
        </Box>
      )
    }

    const group = (key: string, label: string, changes: FileChange[]) =>
      changes.length === 0 ? null : (
        <Box key={key} flexDirection="column" marginTop={1}>
          <Text weight="bold">
            {label} <Text dimColor>{changes.length}</Text>
          </Text>
          {changes.map(row)}
        </Box>
      )

    const branchLine = [
      snap.branch ? `⎇ ${snap.branch}` : null,
      snap.ahead ? `↑${snap.ahead}` : null,
      snap.behind ? `↓${snap.behind}` : null,
    ]
      .filter(Boolean)
      .join(' ')

    // The diff of the selected file, under the list.
    const diffSection = () => {
      if (!picked) return null
      const { name, dir } = splitPath(picked.path)
      const side = picked.staged ? 'Staged' : picked.untracked ? 'Untracked' : 'Working tree'
      const isFresh = view.key === selectedKey
      const body = !isFresh ? (
        <Text dimColor>Reading the diff…</Text>
      ) : view.error ? (
        <Text color="error">{view.error}</Text>
      ) : view.isBinary ? (
        <Text dimColor>Binary file: no text diff.</Text>
      ) : !view.hunks ? (
        <Text dimColor>No changes left in this file.</Text>
      ) : view.isCombined ? (
        <Code key="hunks" source={view.hunks} path={picked.path} />
      ) : (
        <Code key="hunks" source={view.hunks} format="diff" path={picked.path} />
      )
      return (
        <Box key="diff" flexDirection="column" marginTop={1}>
          <Text dimColor>{'─'.repeat(Math.max(8, Math.min(e.props.bodyColumns, 200)))}</Text>
          <Box flexDirection="row" justifyContent="space-between">
            <Text wrap="truncate-end">
              <Text weight="bold">{name}</Text>
              {dir ? <Text dimColor> {dir}</Text> : ''}
            </Text>
            <Button key="close-diff" plain hotkey="x" onPress={() => void clear($).catch(ignore)}>
              ✕
            </Button>
          </Box>
          <Text dimColor wrap="truncate-end">
            {side}
            {picked.origPath ? ` · renamed from ${picked.origPath}` : ''}
            {view.isCombined ? ' · merge conflict' : ''}
            {isFresh && !view.isCombined && view.hunks ? ' · ' : ''}
            {isFresh && !view.isCombined && view.hunks ? <Text color="success">+{view.added}</Text> : ''}
            {isFresh && !view.isCombined && view.hunks ? ' ' : ''}
            {isFresh && !view.isCombined && view.hunks ? <Text color="error">−{view.removed}</Text> : ''}
          </Text>
          <Box marginTop={1} flexDirection="column">
            {body}
          </Box>
          {isFresh && view.isTruncated && <Text dimColor>The diff is long; only its first part is shown.</Text>}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor wrap="truncate-end">
            {branchLine || 'git'} · {total} file{total === 1 ? '' : 's'}
          </Text>
          <Button key="refresh" plain hotkey="r" onPress={() => void refresh($).catch(ignore)}>
            ↻
          </Button>
        </Box>
        {snap.error && <Text dimColor>{snap.error}</Text>}
        {!snap.error && total === 0 && <Text dimColor>No changes.</Text>}
        {group('merge', 'Merge Changes', snap.merge)}
        {group('staged', 'Staged Changes', snap.staged)}
        {group('changes', 'Changes', snap.changes)}
        {snap.isTruncated && <Text dimColor>Only the first 500 files are listed.</Text>}
        {diffSection()}
      </Box>
    )
  })
}
