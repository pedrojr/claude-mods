import type { EngineInterface as Engine } from 'claude-code'

import type { AgentView, SessionView } from '../types'
import {
  agentIdOf,
  desktopLink,
  folderOf,
  lastLineOf,
  openUrlArgv,
  parseAgentMeta,
  parseRegistry,
  projectSlug,
  visible,
  vscodeArgvs,
  vscodeLink,
} from './sessions'
import type { AgentMeta, RegistryRow } from './sessions'

// Prompt cache lifetime: 1 hour on subscriptions, 5 minutes on some API setups.
export const CACHE_TTL_MS = 60 * 60 * 1000
// Transcripts larger than this are not read for their last line.
const MAX_TRANSCRIPT_BYTES = 40 * 1024 * 1024
// Past this many entries a cache is emptied; the next poll re-reads only what it draws.
const MAX_CACHED = 500

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
export async function readSessions($: Engine, now: number): Promise<SessionView[]> {
  if (lineCache.size > MAX_CACHED) lineCache.clear()
  if (metaCache.size > MAX_CACHED) metaCache.clear()
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

/** Puts this session's main conversation, or one of its agents, in the main view. */
export async function show($: Engine, agentId?: string): Promise<boolean> {
  const moved = await $.ui.view(agentId ? { agentId } : {})
  return !moved.deny
}

/** Brings a session to the front: this one's view, or another desktop session through the app's link. */
export async function openSession($: Engine, session: SessionView): Promise<void> {
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
  const link = session.entrypoint === 'VS Code' ? vscodeLink(session.sessionId) : null
  if (link && found) {
    let ok = true
    for (const argv of vscodeArgvs(session.cwd, link, found.isWindows)) {
      const result = await $.process.run(argv).catch(() => null)
      if (result?.exitCode !== 0) {
        ok = false
        break
      }
    }
    if (ok) return
  }
  await $.ui.toast(`"${session.name}" runs in ${session.entrypoint} (${folderOf(session.cwd)}); switch to it there.`)
}

export async function openAgent($: Engine, session: SessionView, agent: AgentView): Promise<void> {
  if (session.isSelf && (await show($, agent.id))) return
  await openSession($, session)
}

/** "12s", "4m", "1h05m". */
export function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/**
 * What the Agents section lists: this session always, and anything running.
 * Idle sessions and agents (warm cache, nothing running) only with `showIdle`;
 * `hidden` counts the ones left out.
 */
export function shownSessions(sessions: readonly SessionView[], showIdle: boolean): { sessions: SessionView[]; hidden: number } {
  let hidden = 0
  const shown: SessionView[] = []
  for (const session of sessions) {
    const agents = showIdle ? session.agents : session.agents.filter(agent => agent.active)
    const keep = showIdle || session.isSelf || session.active || agents.length > 0
    if (!keep) {
      hidden += 1 + session.agents.length
      continue
    }
    hidden += session.agents.length - agents.length
    shown.push({ ...session, agents })
  }
  return { sessions: shown, hidden }
}
