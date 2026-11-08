import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { AgentView, PaneState, SessionView, Snapshot } from '../types'
import {
  agentIdOf,
  desktopLink,
  folderOf,
  lastLineOf,
  openUrlArgv,
  ordered,
  parseAgentMeta,
  parseRegistry,
  projectSlug,
  visible,
} from './sessions'
import type { AgentMeta, RegistryRow } from './sessions'

const PANE = 'agents-panel'
const TITLE = 'Agents'
const COMMAND = 'agents-panel'
// How often the session registry and transcripts are checked.
const POLL_MS = 3000
// Prompt cache lifetime: 1 hour on subscriptions, 5 minutes on some API setups.
const CACHE_TTL_MS = 60 * 60 * 1000
// Transcripts larger than this are not read for their last line.
const MAX_TRANSCRIPT_BYTES = 40 * 1024 * 1024
// Columns the docked pane asks for in a fullscreen terminal.
const DOCK_COLUMNS = 52

// Change the tag when Snapshot's fields change: it drops what an earlier
// version stored, which outlives a reload.
const snapshot = atom({ plugin: 'agents-panel', key: 'snapshot' } as const, { sessions: [], now: 0 } as Snapshot, {
  shape: 'snapshot-3',
})

// Whether the pane is drawn, and whether the person closed it (then it stops opening by itself).
const pane = atom({ plugin: 'agents-panel', key: 'pane' } as const, { isOpen: false, closedByPerson: false } as PaneState)

// The pane is a view only: none of its own failures may get in the way of a spawn or a turn.
const ignore = (): void => {}

// The poll timer; a reload drops it with the module, and the next refresh starts it again.
let poller: { cancel: () => void } | null = null

// Where things are on this machine, found once.
let host: { configDir: string; isWindows: boolean; isMac: boolean } | null = null

// Each transcript's last line and each agent's meta, re-read only when the file changes.
const lineCache = new Map<string, { mtimeMs: number; line: string | null }>()
const metaCache = new Map<string, { mtimeMs: number; meta: AgentMeta | null }>()

async function findHost($: Engine): Promise<typeof host> {
  if (host) return host
  const [explicit, home, profile, os] = await Promise.all([
    $.env.get('CLAUDE_CONFIG_DIR'),
    $.env.get('HOME'),
    $.env.get('USERPROFILE'),
    $.env.get('OS'),
  ])
  const base = home ?? profile
  const configDir = explicit ?? (base ? `${base.replace(/[\\/]+$/, '')}/.claude` : null)
  if (!configDir) return null
  host = { configDir, isWindows: os === 'Windows_NT', isMac: (home ?? '').startsWith('/Users/') }
  return host
}

/** The last line of a transcript, from the cache while the file is unchanged. */
async function lineOf($: Engine, path: string, mtimeMs: number, size: number, sidechain: boolean): Promise<string | null> {
  const cached = lineCache.get(path)
  if (cached && cached.mtimeMs === mtimeMs) return cached.line
  const line = size > MAX_TRANSCRIPT_BYTES ? null : lastLineOf(await $.fs.read(path), sidechain)
  lineCache.set(path, { mtimeMs, line })
  return line
}

async function metaOf($: Engine, path: string, mtimeMs: number): Promise<AgentMeta | null> {
  const cached = metaCache.get(path)
  if (cached && cached.mtimeMs === mtimeMs) return cached.meta
  const meta = parseAgentMeta(await $.fs.read(path))
  metaCache.set(path, { mtimeMs, meta })
  return meta
}

/** A session's subagents, from `<sessionId>/subagents/`; only the warm ones are read. */
async function agentsOf($: Engine, dir: string, now: number): Promise<AgentView[]> {
  let entries: readonly { name: string; kind: string; size: number; mtimeMs: number }[]
  try {
    entries = await $.fs.list(dir)
  } catch {
    return []
  }
  const metaTimes = new Map(entries.filter(e => e.name.endsWith('.meta.json')).map(e => [e.name, e.mtimeMs]))
  const views = await Promise.all(
    entries.map(async (entry): Promise<AgentView | null> => {
      const id = agentIdOf(entry.name)
      if (!id) return null
      const metaName = `agent-${id}.meta.json`
      const meta = metaTimes.has(metaName) ? await metaOf($, `${dir}/${metaName}`, metaTimes.get(metaName)!).catch(() => null) : null
      const active = meta ? !meta.finished : false
      // Cold and finished: not drawn, so not read.
      if (!active && now - entry.mtimeMs >= CACHE_TTL_MS) return null
      const lastLine = await lineOf($, `${dir}/${entry.name}`, entry.mtimeMs, entry.size, true).catch(() => null)
      return { id, label: meta?.label ?? id, type: meta?.type ?? 'agent', active, lastAt: entry.mtimeMs, lastLine, parentId: null }
    }),
  )
  return views.filter((view): view is AgentView => view !== null)
}

/** Every open session on this machine with its warm agents, from Claude Code's own files. */
async function readSessions($: Engine, now: number): Promise<SessionView[]> {
  const found = await findHost($)
  if (!found) return []
  const { configDir } = found
  const [selfId, list] = await Promise.all([$.session.id(), $.agent.list().catch(() => [])])
  const live = new Map(list.map(agent => [agent.id, agent]))
  let entries: readonly { name: string; kind: string }[]
  try {
    entries = await $.fs.list(`${configDir}/sessions`)
  } catch {
    return []
  }
  const sessions = await Promise.all(
    entries
      .filter(entry => entry.kind === 'file' && entry.name.endsWith('.json'))
      .map(async (entry): Promise<SessionView | null> => {
        let row: RegistryRow | null
        try {
          row = parseRegistry(await $.fs.read(`${configDir}/sessions/${entry.name}`))
        } catch {
          return null
        }
        if (!row) return null
        const isSelf = row.sessionId === selfId
        const base = `${configDir}/projects/${projectSlug(row.cwd)}/${row.sessionId}`
        let lastAt = 0
        let lastLine: string | null = null
        try {
          const stat = await $.fs.stat(`${base}.jsonl`)
          lastAt = stat.mtimeMs
          // A cold, idle session is not drawn unless an agent of its own is warm.
          if (row.busy || isSelf || now - lastAt < CACHE_TTL_MS) lastLine = await lineOf($, `${base}.jsonl`, stat.mtimeMs, stat.size, false)
        } catch {
          // No transcript yet: a session that has not been prompted.
        }
        const coldSession = !row.busy && !isSelf && now - lastAt >= CACHE_TTL_MS
        let agents = coldSession && lastAt > 0 ? [] : await agentsOf($, `${base}/subagents`, now)
        if (isSelf) {
          // This session's own engine knows its agents' live status and nesting.
          agents = agents.map(agent => {
            const info = live.get(agent.id)
            if (!info) return agent
            const active = !['completed', 'failed', 'killed'].includes(info.status)
            return { ...agent, label: info.description || agent.label, active, parentId: info.parentId ?? null }
          })
          // One just spawned may have no file yet.
          const filed = new Set(agents.map(agent => agent.id))
          for (const info of list) {
            if (filed.has(info.id) || ['completed', 'failed', 'killed'].includes(info.status)) continue
            agents.push({ id: info.id, label: info.description || info.name || info.type, type: info.type, active: true, lastAt: now, lastLine: null, parentId: info.parentId ?? null })
          }
        }
        return {
          sessionId: row.sessionId,
          hostSessionId: row.hostSessionId,
          name: row.name,
          cwd: row.cwd,
          entrypoint: row.entrypoint,
          isSelf,
          active: row.busy,
          lastAt,
          lastLine,
          agents,
        }
      }),
  )
  return visible(
    sessions.filter((session): session is SessionView => session !== null),
    now,
    CACHE_TTL_MS,
  )
}

// Past this many entries a cache is emptied; the next poll re-reads only what it draws.
const MAX_CACHED = 500

async function refresh($: Engine): Promise<void> {
  if (lineCache.size > MAX_CACHED) lineCache.clear()
  if (metaCache.size > MAX_CACHED) metaCache.clear()
  const now = await $.clock.now()
  const sessions = await readSessions($, now).catch(() => [] as SessionView[])
  const current = await read($, snapshot)
  const ticking = sessions.some(s => s.active || s.agents.some(a => a.active))
  // Redraw on any change, and every poll while something runs (the ages tick).
  if (ticking || JSON.stringify(sessions) !== JSON.stringify(current.sessions)) {
    await update($, snapshot, () => ({ sessions, now }))
  }
  if (!poller) poller = $.clock.every(POLL_MS, () => refresh($).catch(ignore))
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

/** Puts this session's main conversation, or one of its agents, in the main view. */
async function show($: Engine, agentId?: string): Promise<boolean> {
  const moved = await $.ui.view(agentId ? { agentId } : {})
  return !moved.deny
}

/** Brings a session to the front: this one's view, or another desktop session through the app's link. */
async function openSession($: Engine, session: SessionView): Promise<void> {
  if (session.isSelf) {
    await show($)
    return
  }
  const found = await findHost($)
  if (session.hostSessionId && found) {
    // A launcher that cannot run falls through to the toast below.
    const result = await $.process
      .run(openUrlArgv(desktopLink(session.hostSessionId), found.isWindows, found.isMac))
      .catch(() => null)
    if (result?.exitCode === 0) return
  }
  await $.ui.toast(`"${session.name}" runs in ${session.entrypoint} (${folderOf(session.cwd)}); switch to it there.`)
}

async function openAgent($: Engine, session: SessionView, agent: AgentView): Promise<void> {
  if (session.isSelf && (await show($, agent.id))) return
  await openSession($, session)
}

function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show active sessions, agents and subagents, and what each is doing',
      // Runs mid-turn: agents run while the main turn waits on them.
      immediate: true,
    })
    const result = await next(e)
    // Load the list before the first prompt.
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

  // The way back to a closed pane: a one-line chip above the prompt while something else runs.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, pane)).isOpen) return next(e)
    const { sessions } = await read($, snapshot)
    const otherSessions = sessions.filter(s => !s.isSelf && s.active).length
    const agents = sessions.reduce((n, s) => n + s.agents.filter(a => a.active).length, 0)
    if (otherSessions + agents === 0) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const parts = [
      otherSessions > 0 ? `${otherSessions} other session${otherSessions === 1 ? '' : 's'} active` : null,
      agents > 0 ? `${agents} agent${agents === 1 ? '' : 's'} running` : null,
    ].filter(Boolean)
    return (
      <Box flexDirection="row">
        <Text color="success">●</Text>
        <Text dimColor> {parts.join(' · ')} </Text>
        <Button key="open-agents" label="Agents" onPress={() => openPane($, true).catch(ignore)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { sessions, now } = await read($, snapshot)
    const viewing = e.props.view.agentId
    const active = sessions.reduce((n, s) => n + (s.active ? 1 : 0) + s.agents.filter(a => a.active).length, 0)

    // One row: a dot (green while active, light gray otherwise), the title, its age, and its last line.
    const item = (
      key: string,
      depth: number,
      isActive: boolean,
      title: string,
      meta: string,
      lastLine: string | null,
      isBold: boolean,
      onPress: () => void,
    ) => (
      <Box key={key} flexDirection="column" paddingLeft={depth * 2} marginTop={depth === 0 ? 1 : 0}>
        <Button key={`open:${key}`} plain onPress={onPress}>
          <Text color={isActive ? 'success' : 'subtle'}>●</Text>{' '}
          <Text weight={isBold ? 'bold' : 'regular'} wrap="truncate-end">
            {title}
          </Text>{' '}
          <Text dimColor>{meta}</Text>
        </Button>
        {lastLine && (
          <Box paddingLeft={2}>
            <Text dimColor wrap="truncate-end">
              ↳ {lastLine}
            </Text>
          </Box>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor>
            {active} active · {sessions.length} session{sessions.length === 1 ? '' : 's'}
          </Text>
          {viewing && (
            <Button key="main" plain hotkey="m" onPress={() => show($).catch(ignore)}>
              ← Main
            </Button>
          )}
        </Box>
        {sessions.length === 0 && <Text dimColor>Nothing active, and no warm prompt cache.</Text>}
        {sessions.flatMap(session => [
          item(
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
            item(
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
  })
}
