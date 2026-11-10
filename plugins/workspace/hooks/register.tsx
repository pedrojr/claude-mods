import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register, RenderChildren } from 'claude-code'

import type { AgentsSnapshot, FileChange, PaneState, Selection, SectionId, SessionView } from '../types'
import { age, openAgent, openSession, readSessions, show, shownSessions } from './agents'
import { NO_CHANGES, NO_DIFF, readDiff, readStatus } from './changes'
import { changeKey, splitPath, statusColor } from './git'
import { ordered } from './sessions'

const PANE = 'workspace'
const TITLE = 'Workspace'
const COMMAND = 'workspace'
// How often sessions, agents and (while the pane is open) git are read again.
const POLL_MS = 3000
// Columns the docked pane asks for in a fullscreen terminal.
const DOCK_COLUMNS = 56
// Tools whose run may change the working tree.
const WRITERS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell'])

// Each section's color: its frame (dimmed, so it stays light) and its title.
const COLORS: Record<SectionId, string> = {
  agents: 'claude',
  changes: 'suggestion',
  diff: 'merged',
}

// Change a tag when its type's fields change: it drops what an earlier version stored.
const agents = atom({ plugin: 'workspace', key: 'agents' } as const, { sessions: [], now: 0 } as AgentsSnapshot, { shape: 'agents-1' })
const changes = atom({ plugin: 'workspace', key: 'changes' } as const, NO_CHANGES, { shape: 'changes-1' })
const selection = atom({ plugin: 'workspace', key: 'selection' } as const, null as Selection, { shape: 'selection-1' })
const diff = atom({ plugin: 'workspace', key: 'diff' } as const, NO_DIFF, { shape: 'diff-1' })
const pane = atom(
  { plugin: 'workspace', key: 'pane' } as const,
  { isOpen: false, closedByPerson: false, collapsed: [], showIdle: false } as PaneState,
  { shape: 'pane-1' },
)

// The pane is a view only: none of its own failures may get in the way of a spawn or a turn.
const ignore = (): void => {}

// The poll timer; a reload drops it with the module, and the next refresh starts it again.
let poller: { cancel: () => void } | null = null

// Each value is written only when it changed, so an idle poll redraws nothing.
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

async function refreshAgents($: Engine): Promise<void> {
  const now = await $.clock.now()
  const sessions = await readSessions($, now).catch(() => [] as SessionView[])
  const current = await read($, agents)
  const ticking = sessions.some(s => s.active || s.agents.some(a => a.active))
  // Redraw on any change, and every poll while something runs (the ages tick).
  if (ticking || !same(sessions, current.sessions)) await update($, agents, () => ({ sessions, now }))
}

async function refreshDiff($: Engine): Promise<void> {
  const picked = await read($, selection)
  const next = picked ? await readDiff($, picked) : NO_DIFF
  if (!same(await read($, diff), next)) await update($, diff, () => next)
}

async function refreshChanges($: Engine): Promise<void> {
  const next = await readStatus($).catch(error => ({ ...NO_CHANGES, error: String(error) }))
  if (!same(await read($, changes), next)) await update($, changes, () => next)
  await refreshDiff($)
}

/** Reads everything again. Git runs only while the pane is drawn, or when `withGit` asks. */
async function refresh($: Engine, withGit = false): Promise<void> {
  const { isOpen } = await read($, pane)
  await Promise.all([refreshAgents($), isOpen || withGit ? refreshChanges($) : null])
  if (!poller) poller = $.clock.every(POLL_MS, () => refresh($).catch(ignore))
}

/** Opens the pane; `asked` is true when the person's own command or press asks for it. */
async function openPane($: Engine, asked: boolean): Promise<string> {
  const opened = await $.ui.open({ id: PANE, title: TITLE, columns: DOCK_COLUMNS, ...(asked ? { focus: true } : {}) })
  await update($, pane, state => ({
    ...state,
    isOpen: opened.isPlaced,
    closedByPerson: asked ? false : state.closedByPerson,
  }))
  await refresh($, true)
  return opened.isPlaced ? 'Workspace pane opened.' : `Workspace pane waits: ${opened.reason}`
}

async function openIfApp($: Engine): Promise<void> {
  // Once the person closed the pane it stays closed; the band's button or /workspace brings it back.
  if ((await read($, pane)).closedByPerson) return
  const surfaces = await $.session.surfaces()
  // The terminal opens the pane only on request; app surfaces open it themselves.
  if (surfaces.some(s => s !== 'terminal')) await openPane($, false)
}

/** A click on a file shows its diff; a click on the file already shown hides it. */
async function pick($: Engine, change: FileChange): Promise<void> {
  const { root } = await read($, changes)
  if (!root) return
  const current = await read($, selection)
  const isSame = current !== null && changeKey(current) === changeKey(change)
  await update($, selection, () => (isSame ? null : { ...change, root }))
  // Showing a diff unfolds its section.
  if (!isSame) await update($, pane, state => ({ ...state, collapsed: state.collapsed.filter(id => id !== 'diff') }))
  await refreshDiff($)
}

async function unpick($: Engine): Promise<void> {
  await update($, selection, () => null)
  await refreshDiff($)
}

async function fold($: Engine, id: SectionId): Promise<void> {
  await update($, pane, state => ({
    ...state,
    collapsed: state.collapsed.includes(id) ? state.collapsed.filter(c => c !== id) : [...state.collapsed, id],
  }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show the active agents, the changed files and their diffs',
      // Runs mid-turn: agents run while the main turn waits on them.
      immediate: true,
    })
    const result = await next(e)
    // Load the lists before the first prompt.
    await refresh($, true).catch(ignore)
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
      return { text: `Workspace pane could not open: ${String(error)}` }
    }
  })

  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE) {
      await update($, pane, state => ({
        ...state,
        isOpen: false,
        closedByPerson: state.closedByPerson || e.origin.kind === 'person',
      })).catch(ignore)
    }
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    refresh($).catch(ignore)
    openIfApp($).catch(ignore)
    return result
  })

  // An edit or a command may change the tree: read git again as soon as it ends.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (WRITERS.has(String(e.tool))) refresh($, true).catch(ignore)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    refresh($, true).catch(ignore)
    return result
  })

  // The way back to a closed pane: a one-line chip above the prompt while something else runs.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, pane)).isOpen) return next(e)
    const { sessions } = await read($, agents)
    const otherSessions = sessions.filter(s => !s.isSelf && s.active).length
    const running = sessions.reduce((n, s) => n + s.agents.filter(a => a.active).length, 0)
    if (otherSessions + running === 0) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const parts = [
      otherSessions > 0 ? `${otherSessions} other session${otherSessions === 1 ? '' : 's'} active` : null,
      running > 0 ? `${running} agent${running === 1 ? '' : 's'} running` : null,
    ].filter(Boolean)
    return (
      <Box flexDirection="row">
        <Text color="success">●</Text>
        <Text dimColor> {parts.join(' · ')} </Text>
        <Button key="open-workspace" label="Workspace" onPress={() => openPane($, true).catch(ignore)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const state = await read($, pane)
    const { sessions, now } = await read($, agents)
    const snap = await read($, changes)
    const picked = await read($, selection)
    const view = await read($, diff)
    const viewing = e.props.view.agentId
    const selectedKey = picked ? changeKey(picked) : null

    // A section: a light frame in its color, a title line that folds it, actions on the right.
    const section = (id: SectionId, title: string, summary: string, actions: RenderChildren[], body: RenderChildren) => {
      const color = COLORS[id]
      const folded = state.collapsed.includes(id)
      return (
        <Box key={`section:${id}`} flexDirection="column" borderStyle="round" borderColor={color} borderDimColor paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Button key={`fold:${id}`} plain onPress={() => void fold($, id).catch(ignore)}>
              <Text color={color}>{folded ? '▸' : '▾'} </Text>
              <Text color={color} weight="bold">
                {title}
              </Text>
              {summary ? <Text dimColor> {summary}</Text> : ''}
            </Button>
            <Box flexDirection="row" gap={1}>
              {actions}
            </Box>
          </Box>
          {folded ? null : body}
        </Box>
      )
    }

    // ---- Agents: this session and whatever runs; idle ones behind "+N idle". ----

    const { sessions: listed, hidden } = shownSessions(sessions, state.showIdle)
    const runningCount = sessions.reduce((n, s) => n + (s.active ? 1 : 0) + s.agents.filter(a => a.active).length, 0)

    // One row: a dot (green while running, gray when idle), the title, its age; what it does now under it.
    const agentRow = (
      key: string,
      depth: number,
      isActive: boolean,
      title: string,
      meta: string,
      lastLine: string | null,
      isBold: boolean,
      onPress: () => void,
    ) => (
      <Box key={key} flexDirection="column" paddingLeft={depth * 2}>
        <Button key={`open:${key}`} plain onPress={onPress}>
          <Text color={isActive ? 'success' : 'subtle'}>●</Text>{' '}
          <Text weight={isBold ? 'bold' : 'regular'} wrap="truncate-end">
            {title}
          </Text>{' '}
          <Text dimColor>{meta}</Text>
        </Button>
        {isActive && lastLine && (
          <Box paddingLeft={2}>
            <Text dimColor wrap="truncate-end">
              ↳ {lastLine}
            </Text>
          </Box>
        )}
      </Box>
    )

    const agentsBody = (
      <Box flexDirection="column">
        {listed.length === 0 && <Text dimColor>Nothing running.</Text>}
        {listed.flatMap(session => [
          agentRow(
            `session:${session.sessionId}`,
            0,
            session.active,
            session.name,
            [session.isSelf ? 'this session' : session.entrypoint, age(now - session.lastAt)].join(' · '),
            session.lastLine,
            session.isSelf && !viewing,
            () => void openSession($, session).catch(ignore),
          ),
          ...ordered(session.agents).map(({ agent, depth }) =>
            agentRow(
              `agent:${session.sessionId}:${agent.id}`,
              depth + 1,
              agent.active,
              `${agent.id === viewing ? '▶ ' : ''}${agent.label}`,
              `${agent.type} · ${age(now - agent.lastAt)}`,
              agent.lastLine,
              agent.id === viewing,
              () => void openAgent($, session, agent).catch(ignore),
            ),
          ),
        ])}
      </Box>
    )

    const agentsActions = [
      viewing ? (
        <Button key="main" plain hotkey="m" onPress={() => void show($).catch(ignore)}>
          ← Main
        </Button>
      ) : null,
      hidden > 0 || state.showIdle ? (
        <Button
          key="idle"
          plain
          onPress={() => void update($, pane, s => ({ ...s, showIdle: !s.showIdle })).catch(ignore)}
        >
          <Text dimColor>{state.showIdle ? 'hide idle' : `+${hidden} idle`}</Text>
        </Button>
      ) : null,
    ]

    // ---- Changes: VS Code's groups, a colored status letter per file. ----

    const total = snap.merge.length + snap.staged.length + snap.changes.length

    const fileRow = (change: FileChange) => {
      const key = changeKey(change)
      const { name, dir } = splitPath(change.path)
      const isSelected = key === selectedKey
      const from = change.origPath ? `${splitPath(change.origPath).name} → ` : ''
      return (
        <Box key={key} flexDirection="row">
          <Button key={`open:${key}`} plain onPress={() => void pick($, change).catch(ignore)}>
            <Text color={statusColor(change.status, change.untracked)} weight="bold">
              {change.status}
            </Text>{' '}
            <Text weight={isSelected ? 'bold' : 'regular'} color={isSelected ? COLORS.diff : undefined} wrap="truncate-end">
              {from}
              {name}
            </Text>
            {dir ? <Text dimColor> {dir}</Text> : ''}
            {isSelected ? <Text color={COLORS.diff}> ◂</Text> : ''}
          </Button>
        </Box>
      )
    }

    const group = (key: string, label: string, files: FileChange[]) =>
      files.length === 0 ? null : (
        <Box key={key} flexDirection="column">
          <Text dimColor>
            {label} · {files.length}
          </Text>
          {files.map(fileRow)}
        </Box>
      )

    const branch = [snap.branch ? `⎇ ${snap.branch}` : null, snap.ahead ? `↑${snap.ahead}` : null, snap.behind ? `↓${snap.behind}` : null]
      .filter(Boolean)
      .join(' ')

    const changesBody = (
      <Box flexDirection="column" gap={1}>
        {snap.error && <Text dimColor>{snap.error}</Text>}
        {!snap.error && total === 0 && <Text dimColor>No changes.</Text>}
        {group('merge', 'Conflicts', snap.merge)}
        {group('staged', 'Staged', snap.staged)}
        {group('changes', 'Not staged', snap.changes)}
        {snap.isTruncated && <Text dimColor>Only the first 500 files are listed.</Text>}
      </Box>
    )

    // ---- Diff: the file picked in Changes. ----

    const diffParts = () => {
      if (!picked) return { summary: '', body: <Text dimColor>Click a file in Changes to see its diff here.</Text> }
      const { name, dir } = splitPath(picked.path)
      const side = picked.staged ? 'staged' : picked.untracked ? 'new file' : 'not staged'
      const isFresh = view.key === selectedKey
      const counts = isFresh && view.hunks && !view.isCombined
      const code = !isFresh ? (
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
      return {
        summary: name,
        body: (
          <Box flexDirection="column">
            <Text wrap="truncate-end">
              <Text dimColor>{dir ? `${dir}/` : ''}</Text>
              <Text weight="bold">{name}</Text>
            </Text>
            <Text dimColor wrap="truncate-end">
              {side}
              {picked.origPath ? ` · was ${picked.origPath}` : ''}
              {view.isCombined ? ' · merge conflict' : ''}
              {counts ? ' · ' : ''}
              {counts ? <Text color="success">+{view.added}</Text> : ''}
              {counts ? ' ' : ''}
              {counts ? <Text color="error">−{view.removed}</Text> : ''}
            </Text>
            <Box marginTop={1} flexDirection="column">
              {code}
            </Box>
            {isFresh && view.isTruncated && <Text dimColor>The diff is long; only its first part is shown.</Text>}
          </Box>
        ),
      }
    }
    const diffView = diffParts()

    return (
      <Box flexDirection="column" gap={1}>
        {section(
          'agents',
          'AGENTS',
          runningCount > 0 ? `${runningCount} running` : 'idle',
          agentsActions,
          agentsBody,
        )}
        {section(
          'changes',
          'CHANGES',
          [branch, `${total} file${total === 1 ? '' : 's'}`].filter(Boolean).join(' · '),
          [
            <Button key="refresh" plain hotkey="r" onPress={() => void refresh($, true).catch(ignore)}>
              <Text dimColor>↻</Text>
            </Button>,
          ],
          changesBody,
        )}
        {section(
          'diff',
          'DIFF',
          diffView.summary,
          picked
            ? [
                <Button key="close-diff" plain hotkey="x" onPress={() => void unpick($).catch(ignore)}>
                  <Text dimColor>✕</Text>
                </Button>,
              ]
            : [],
          diffView.body,
        )}
      </Box>
    )
  })
}
