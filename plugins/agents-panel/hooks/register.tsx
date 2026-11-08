import { atom, read, update } from 'claude-code'
import type { AgentInfo, AgentStatus, EngineInterface as Engine, Register } from 'claude-code'

import type { AgentRow, PaneState, SessionRow, Snapshot } from '../types'
import { activityFromTranscript, folderOf, isBusy, parseRegistry, projectSlug, sortSessions } from './sessions'

const PANE = 'agents-panel'
const TITLE = 'Agents'
const COMMAND = 'agents-panel'
// How often sessions and agents are polled.
const POLL_MS = 3000
// Finished agents kept below the active ones.
const MAX_FINISHED = 15
// Idle sessions listed below the busy ones.
const MAX_IDLE_SESSIONS = 12
// Transcripts larger than this are not read for the activity line.
const MAX_TRANSCRIPT_BYTES = 40 * 1024 * 1024
// Columns the docked pane asks for in a fullscreen terminal.
const DOCK_COLUMNS = 52

// Change the tag when Snapshot's fields change: it drops what an earlier
// version stored, which outlives a reload.
const snapshot = atom(
  { plugin: 'agents-panel', key: 'snapshot' } as const,
  { agents: [], sessions: [], now: 0 } as Snapshot,
  { shape: 'snapshot-2' },
)

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

// Claude Code's config folder, found once.
let configDir: string | null = null

// Each transcript's activity line, re-read only when the file changes.
const activityCache = new Map<string, { mtimeMs: number; activity: string | null }>()

async function findConfigDir($: Engine): Promise<string | null> {
  if (configDir) return configDir
  const explicit = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  configDir = explicit ?? (home ? `${home.replace(/[\\/]+$/, '')}/.claude` : null)
  return configDir
}

async function activityOf($: Engine, dir: string, row: Omit<SessionRow, 'activity' | 'isSelf'>): Promise<string | null> {
  const path = `${dir}/projects/${projectSlug(row.cwd)}/${row.sessionId}.jsonl`
  try {
    const stat = await $.fs.stat(path)
    const cached = activityCache.get(row.sessionId)
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.activity
    const activity = stat.size > MAX_TRANSCRIPT_BYTES ? null : activityFromTranscript(await $.fs.read(path))
    activityCache.set(row.sessionId, { mtimeMs: stat.mtimeMs, activity })
    return activity
  } catch {
    return activityCache.get(row.sessionId)?.activity ?? null
  }
}

/** Every open session on this machine, from Claude Code's session registry. */
async function readSessions($: Engine): Promise<SessionRow[]> {
  const dir = await findConfigDir($)
  if (!dir) return []
  const selfId = await $.session.id()
  let entries: readonly { name: string; kind: string }[]
  try {
    entries = await $.fs.list(`${dir}/sessions`)
  } catch {
    return []
  }
  const rows = await Promise.all(
    entries
      .filter(entry => entry.kind === 'file' && entry.name.endsWith('.json'))
      .map(async entry => {
        try {
          const row = parseRegistry(await $.fs.read(`${dir}/sessions/${entry.name}`))
          if (!row) return null
          return { ...row, activity: await activityOf($, dir, row), isSelf: row.sessionId === selfId }
        } catch {
          return null
        }
      }),
  )
  const sorted = sortSessions(rows.filter((row): row is SessionRow => row !== null))
  const busy = sorted.filter(row => isBusy(row.status) || row.isSelf)
  const idle = sorted.filter(row => !isBusy(row.status) && !row.isSelf).slice(0, MAX_IDLE_SESSIONS)
  return sortSessions([...busy, ...idle])
}

async function refresh($: Engine): Promise<void> {
  // The session list is a bonus: where it cannot be read, agents still show.
  const [list, now, sessions] = await Promise.all([$.agent.list(), $.clock.now(), readSessions($).catch(() => [])])
  const current = await read($, snapshot)
  const agents = merge(current.agents, list, now)
  const ticking = agents.some(row => isActive(row.status)) || sessions.some(row => isBusy(row.status))
  const same =
    JSON.stringify(agents) === JSON.stringify(current.agents) &&
    JSON.stringify(sessions) === JSON.stringify(current.sessions)
  // Redraw on any change, and every poll while something runs (the clocks tick).
  if (!same || ticking) await update($, snapshot, () => ({ agents, sessions, now }))
  if (!poller) poller = $.clock.every(POLL_MS, () => refresh($).catch(ignore))
}

async function openSession($: Engine, row: SessionRow, surface: Parameters<Engine['ui']['copy']>[0]['surface']): Promise<void> {
  if (row.isSelf) return show($)
  await $.ui.copy({ text: row.sessionId, ...(surface ? { surface } : {}) }).catch(ignore)
  await $.ui.toast(`"${row.name}" runs in ${row.entrypoint} (${folderOf(row.cwd)}); its session id is copied.`)
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
      description: 'Show open sessions, running agents and subagents, and what each is doing',
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

  // The way back to a closed pane: a one-line chip above the prompt while there is something to show.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, pane)).isOpen) return next(e)
    const { agents, sessions } = await read($, snapshot)
    const active = agents.filter(row => isActive(row.status)).length
    const busy = sessions.filter(row => !row.isSelf && isBusy(row.status)).length
    if (agents.length === 0 && busy === 0) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const parts = [
      busy > 0 ? `${busy} other session${busy === 1 ? '' : 's'} busy` : null,
      active > 0 ? `${active} agent${active === 1 ? '' : 's'} running` : null,
      active === 0 && agents.length > 0 ? `${agents.length} agent${agents.length === 1 ? '' : 's'} done` : null,
    ].filter(Boolean)
    const working = busy + active > 0
    return (
      <Box flexDirection="row">
        <Text color={working ? 'success' : 'subtle'}>{working ? '●' : '✓'}</Text>
        <Text dimColor> {parts.join(' · ')} </Text>
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
    const { agents, sessions, now } = await read($, snapshot)
    const viewing = e.props.view.agentId
    const rows = ordered(agents)
    const busy = sessions.filter(row => isBusy(row.status)).length
    const active = agents.filter(row => isActive(row.status)).length
    // Without a registry entry for this session (an SDK host), it still heads its agents.
    const self: SessionRow =
      sessions.find(row => row.isSelf) ??
      { sessionId: '', pid: 0, name: 'This session', cwd: '', status: 'busy', entrypoint: '', since: now, activity: null, isSelf: true }
    const others = sessions.filter(row => !row.isSelf)

    const sessionRow = (row: SessionRow) => {
      const working = isBusy(row.status)
      const meta = [row.isSelf ? 'this session' : row.entrypoint, folderOf(row.cwd), row.since ? `${working ? '' : 'idle '}${elapsed(now - row.since)}` : '']
        .filter(Boolean)
        .join(' · ')
      return (
        <Box key={`session:${row.sessionId || 'self'}`} flexDirection="column" marginTop={1}>
          <Button
            key={`session-btn:${row.sessionId || 'self'}`}
            plain
            dimColor={!working && !row.isSelf}
            onPress={press => openSession($, row, press.surface).catch(ignore)}
          >
            <Text color={working ? 'success' : 'subtle'}>{working ? '●' : '○'}</Text>{' '}
            <Text weight={row.isSelf && !viewing ? 'bold' : 'regular'} wrap="truncate-end">
              {row.name}
            </Text>
          </Button>
          <Box paddingLeft={2} flexDirection="column">
            <Text dimColor wrap="truncate-end">{meta}</Text>
            {row.activity && (
              <Text dimColor={!working} wrap="truncate-end">
                ↳ {row.activity}
              </Text>
            )}
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor>
            {busy} busy · {sessions.length - busy} idle · {active} agent{active === 1 ? '' : 's'}
          </Text>
          {viewing && (
            <Button key="main" plain hotkey="m" onPress={() => show($).catch(ignore)}>
              ← Main
            </Button>
          )}
        </Box>
        {sessionRow(self)}
        {rows.map(({ row, depth }, index) => {
          const { mark, color } = glyph(row.status)
          const time = elapsed((row.endedAt ?? now) - row.firstSeenAt)
          const isViewed = row.id === viewing
          return (
            <Box key={row.id} flexDirection="row" paddingLeft={2 + depth * 2}>
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
        {others.map(sessionRow)}
      </Box>
    )
  })
}
