import { atom, read, update } from 'claude-code'
import type { AgentInfo, AgentStatus, EngineInterface as Engine, Register } from 'claude-code'

import type { AgentRow, PaneState, Snapshot } from '../types'

const PANE = 'agents-panel'
const TITLE = 'Agents'
const COMMAND = 'agents-panel'
// How often the list is polled while any agent is still working.
const POLL_MS = 1500
// Finished agents kept below the active ones.
const MAX_FINISHED = 15
// Columns the docked pane asks for in a fullscreen terminal.
const DOCK_COLUMNS = 44

// Change the tag when AgentRow's fields change: it drops what an earlier
// version stored, which outlives a reload.
const snapshot = atom({ plugin: 'agents-panel', key: 'snapshot' } as const, { agents: [], now: 0 } as Snapshot, {
  shape: 'snapshot-1',
})

// Whether the pane is drawn, and whether the person closed it (then it stops opening by itself).
const pane = atom({ plugin: 'agents-panel', key: 'pane' } as const, { isOpen: false, closedByPerson: false } as PaneState)

const FINAL: ReadonlySet<AgentStatus> = new Set(['completed', 'failed', 'killed'])

const isActive = (status: AgentStatus) => !FINAL.has(status)

function glyph(status: AgentStatus): { mark: string; color: string } {
  switch (status) {
    case 'running':
      return { mark: '●', color: 'success' }
    case 'pending':
      return { mark: '◌', color: 'warning' }
    case 'waiting':
      return { mark: '◐', color: 'warning' }
    case 'idle':
      return { mark: '○', color: 'subtle' }
    case 'completed':
      return { mark: '✓', color: 'subtle' }
    case 'failed':
      return { mark: '✗', color: 'error' }
    case 'killed':
      return { mark: '■', color: 'error' }
  }
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

function labelOf(agent: AgentInfo): string {
  return agent.description || agent.name || agent.type
}

/** Merges a fresh `$.agent.list()` into the stored rows, keeping first-seen and end times. */
export function merge(previous: readonly AgentRow[], list: readonly AgentInfo[], now: number): AgentRow[] {
  const known = new Map(previous.map(row => [row.id, row]))
  const rows = list.map((agent): AgentRow => {
    const before = known.get(agent.id)
    const ended = FINAL.has(agent.status)
    return {
      id: agent.id,
      label: labelOf(agent),
      type: agent.type,
      status: agent.status,
      parentId: agent.parentId ?? null,
      firstSeenAt: before?.firstSeenAt ?? now,
      endedAt: ended ? (before?.endedAt ?? now) : null,
    }
  })
  // The engine drops a finished agent's task after a while; keep it listed.
  const listed = new Set(rows.map(row => row.id))
  const dropped = previous
    .filter(row => !listed.has(row.id))
    .map(row => (FINAL.has(row.status) ? row : { ...row, status: 'completed' as const, endedAt: row.endedAt ?? now }))
  const finished = [...rows, ...dropped]
    .filter(row => !isActive(row.status))
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, MAX_FINISHED)
  const keep = new Set([...rows.filter(row => isActive(row.status)).map(row => row.id), ...finished.map(row => row.id)])
  return [...rows, ...dropped].filter(row => keep.has(row.id))
}

/** Orders rows as a tree: each parent followed by its children, active roots first. */
export function ordered(rows: readonly AgentRow[]): { row: AgentRow; depth: number }[] {
  const ids = new Set(rows.map(row => row.id))
  const children = new Map<string | null, AgentRow[]>()
  for (const row of rows) {
    const parent = row.parentId && ids.has(row.parentId) ? row.parentId : null
    children.set(parent, [...(children.get(parent) ?? []), row])
  }
  const rank = (row: AgentRow) => (isActive(row.status) ? 0 : 1)
  const out: { row: AgentRow; depth: number }[] = []
  const walk = (parent: string | null, depth: number) => {
    const level = [...(children.get(parent) ?? [])].sort(
      (a, b) => rank(a) - rank(b) || a.firstSeenAt - b.firstSeenAt,
    )
    for (const row of level) {
      out.push({ row, depth })
      walk(row.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

// The pane is a view only: none of its own failures may get in the way of a spawn or a turn.
const ignore = (): void => {}

// The poll timer; a reload drops it with the module, and the next refresh starts it again.
let poller: { cancel: () => void } | null = null

async function refresh($: Engine): Promise<void> {
  const [list, now] = await Promise.all([$.agent.list(), $.clock.now()])
  const current = await read($, snapshot)
  const agents = merge(current.agents, list, now)
  const anyActive = agents.some(row => isActive(row.status))
  const same = JSON.stringify(agents) === JSON.stringify(current.agents)
  // Redraw on any change, and every poll while something runs (the clocks tick).
  if (!same || anyActive) await update($, snapshot, () => ({ agents, now }))
  if (anyActive && !poller) {
    poller = $.clock.every(POLL_MS, () => refresh($).catch(ignore))
  } else if (!anyActive && poller) {
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
  return opened.isPlaced ? 'Agents pane opened.' : `Agents pane waits: ${opened.reason}`
}

async function openIfApp($: Engine): Promise<void> {
  // Once the person closed the pane it stays closed; the band's button or /agents-panel brings it back.
  if ((await read($, pane)).closedByPerson) return
  const surfaces = await $.session.surfaces()
  // The terminal opens the pane only on request (/agents-panel); app surfaces open it themselves.
  if (surfaces.some(s => s !== 'terminal')) await openPane($, false)
}

async function show($: Engine, agentId?: string): Promise<void> {
  const moved = await $.ui.view(agentId ? { agentId } : {})
  if (moved.deny) await $.ui.toast(`Cannot open that transcript: ${moved.deny}`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show running agents and subagents; pick one to view its transcript',
      // Runs mid-turn: agents run while the main turn waits on them.
      immediate: true,
    })
    const result = await next(e)
    // A resumed session already lists its agents: load them before the first prompt.
    await refresh($).catch(ignore)
    openIfApp($).catch(ignore)
    return result
  })

  on('session.attach', async ($, e, next) => {
    const result = await next(e)
    if (e.surface !== 'terminal') openIfApp($).catch(ignore)
    return result
  })

  on('command.run', { command: COMMAND }, async $ => {
    refresh($).catch(ignore)
    try {
      return { text: await openPane($, true) }
    } catch (error) {
      return { text: `Agents pane could not open: ${String(error)}` }
    }
  })

  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE) {
      await update($, pane, state => ({
        isOpen: false,
        closedByPerson: state.closedByPerson || e.origin.kind === 'person',
      })).catch(ignore)
    }
    return result
  })

  // The way back to a closed pane: a one-line chip above the prompt while the session has agents.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, pane)).isOpen) return next(e)
    const { agents } = await read($, snapshot)
    if (agents.length === 0) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const active = agents.filter(row => isActive(row.status)).length
    return (
      <Box flexDirection="row">
        <Text color={active > 0 ? 'success' : 'subtle'}>{active > 0 ? '●' : '✓'}</Text>
        <Text dimColor>
          {' '}
          {active > 0 ? `${active} agent${active === 1 ? '' : 's'} running` : `${agents.length} agent${agents.length === 1 ? '' : 's'} done`}{' '}
        </Text>
        <Button key="open-agents" label="Agents" onPress={() => openPane($, true).catch(ignore)} />
      </Box>
    )
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    refresh($).catch(ignore)
    openIfApp($).catch(ignore)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    refresh($).catch(ignore)
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { agents, now } = await read($, snapshot)
    const viewing = e.props.view.agentId
    const rows = ordered(agents)
    const active = agents.filter(row => isActive(row.status)).length

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor>
            {active} running · {agents.length - active} done
          </Text>
          {viewing && (
            <Button key="main" plain hotkey="m" onPress={() => show($).catch(ignore)}>
              ← Main
            </Button>
          )}
        </Box>
        {rows.length === 0 && <Text dimColor>No agents in this session yet.</Text>}
        {rows.map(({ row, depth }, index) => {
          const { mark, color } = glyph(row.status)
          const time = elapsed((row.endedAt ?? now) - row.firstSeenAt)
          const isViewed = row.id === viewing
          return (
            <Box key={row.id} flexDirection="row" paddingLeft={depth * 2}>
              <Button
                key={`agent:${row.id}`}
                plain
                hotkey={index < 9 ? String(index + 1) : undefined}
                dimColor={!isActive(row.status) && !isViewed}
                onPress={() => show($, row.id).catch(ignore)}
              >
                <Text color={color}>{mark}</Text> <Text weight={isViewed ? 'bold' : 'regular'} wrap="truncate-end">{isViewed ? '▶ ' : ''}{row.label}</Text>{' '}
                <Text dimColor>
                  {row.type} · {time}
                </Text>
              </Button>
            </Box>
          )
        })}
      </Box>
    )
  })
}
