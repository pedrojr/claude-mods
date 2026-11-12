// Pure helpers: parsing what Claude Code keeps on disk for each session.
//   <config>/sessions/<pid>.json                              one per open session
//   <config>/projects/<slug>/<sessionId>.jsonl                its transcript
//   <config>/projects/<slug>/<sessionId>/subagents/agent-<id>.jsonl | .meta.json

import type { AgentView, SessionView } from '../types'

/** A registry entry: what the pane needs from `<config>/sessions/<pid>.json`. */
export type RegistryRow = {
  sessionId: string
  hostSessionId: string | null
  name: string
  cwd: string
  entrypoint: string
  busy: boolean
}

type RegistryEntry = {
  pid?: number
  sessionId?: string
  hostSessionId?: string
  cwd?: string
  name?: string
  status?: string
  entrypoint?: string
}

const BUSY = new Set(['busy', 'running', 'working', 'waiting'])

/** Parses one registry file; null when it is not a session entry. */
export function parseRegistry(text: string): RegistryRow | null {
  let entry: RegistryEntry
  try {
    entry = JSON.parse(text) as RegistryEntry
  } catch {
    return null
  }
  if (typeof entry.sessionId !== 'string' || typeof entry.pid !== 'number') return null
  const cwd = typeof entry.cwd === 'string' ? entry.cwd : ''
  return {
    sessionId: entry.sessionId,
    hostSessionId: typeof entry.hostSessionId === 'string' && /^local_[A-Za-z0-9-]{1,64}$/.test(entry.hostSessionId) ? entry.hostSessionId : null,
    name: entry.name?.trim() || folderOf(cwd) || entry.sessionId.slice(0, 8),
    cwd,
    entrypoint: surfaceLabel(entry.entrypoint),
    busy: BUSY.has(entry.status ?? ''),
  }
}

/** A subagent's `agent-<id>.meta.json`. */
export type AgentMeta = { label: string; type: string; finished: boolean }

export function parseAgentMeta(text: string): AgentMeta | null {
  try {
    const meta = JSON.parse(text) as { description?: string; agentType?: string; finished?: boolean }
    return {
      label: meta.description?.trim() || meta.agentType || 'agent',
      type: meta.agentType ?? 'agent',
      finished: meta.finished === true,
    }
  } catch {
    return null
  }
}

/** The agent id in `agent-<id>.jsonl`; null for any other file. */
export function agentIdOf(fileName: string): string | null {
  const match = /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(fileName)
  return match ? match[1]! : null
}

/** The last segment of a path, either separator. */
export function folderOf(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

export function surfaceLabel(entrypoint: string | undefined): string {
  switch (entrypoint) {
    case 'claude-desktop':
      return 'desktop'
    case 'claude-vscode':
      return 'VS Code'
    case 'cli':
      return 'CLI'
    case undefined:
      return '?'
    default:
      return entrypoint.replace(/^claude-/, '')
  }
}

/** The folder name Claude Code files a project's transcripts under: each non-alphanumeric becomes `-`. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

const MAX_LINE = 80

function clip(text: string): string {
  // Markdown marks read as noise in one plain line.
  const line = text
    .replace(/\*\*|__|`/g, '')
    .replace(/^#+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line
}

/** A short phrase for one tool call: the tool and what it acts on. */
export function describeTool(name: string, input: Record<string, unknown>): string {
  const str = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : undefined)
  const path = str('file_path') ?? str('notebook_path')
  const target =
    str('description') ?? (path && folderOf(path)) ?? str('pattern') ?? str('url') ?? str('query') ?? str('skill') ?? str('command') ?? str('prompt')
  const tool = name.startsWith('mcp__') ? (name.split('__').pop() ?? name) : name
  return clip(target ? `${tool}: ${target}` : tool)
}

type Block = { type?: string; name?: string; input?: Record<string, unknown>; text?: string }
type Line = { type?: string; isSidechain?: boolean; message?: { content?: string | Block[] } }

/**
 * What a transcript did last: its last tool call, else the first line of its
 * last reply, else its last prompt. `sidechain` reads a subagent's own file,
 * whose lines are all marked as side-chain.
 */
export function lastLineOf(text: string, sidechain = false): string | null {
  const lines = text.split('\n')
  let prompt: string | null = null
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 400); i -= 1) {
    const raw = lines[i]
    if (!raw || raw[0] !== '{') continue
    let line: Line
    try {
      line = JSON.parse(raw) as Line
    } catch {
      continue
    }
    if (line.isSidechain && !sidechain) continue
    const content = line.message?.content
    if (line.type === 'assistant' && Array.isArray(content)) {
      for (let j = content.length - 1; j >= 0; j -= 1) {
        const block = content[j]!
        if (block.type === 'tool_use' && block.name) return describeTool(block.name, block.input ?? {})
        if (block.type === 'text' && block.text?.trim()) return clip(block.text.trim().split('\n')[0]!)
      }
    }
    if (line.type === 'user' && prompt === null) {
      if (typeof content === 'string' && content.trim() && !content.startsWith('<')) prompt = clip(content)
      else if (Array.isArray(content)) {
        const block = content.find(b => b.type === 'text' && b.text?.trim() && !b.text.startsWith('<'))
        if (block?.text) prompt = clip(block.text)
      }
    }
  }
  return prompt
}

/** Whether an item belongs in the pane: running, or its prompt cache still warm. */
export function isShown(item: { active: boolean; lastAt: number }, now: number, ttlMs: number): boolean {
  return item.active || now - item.lastAt < ttlMs
}

/** Keeps what is active or warm: a session shows when it or any of its agents does. */
export function visible(sessions: readonly SessionView[], now: number, ttlMs: number): SessionView[] {
  return sessions
    .map(session => ({ ...session, agents: session.agents.filter(agent => isShown(agent, now, ttlMs)) }))
    .filter(session => isShown(session, now, ttlMs) || session.agents.length > 0)
    .sort((a, b) => rank(b) - rank(a) || b.lastAt - a.lastAt)
}

const rank = (session: SessionView) => (session.active || session.agents.some(agent => agent.active) ? 1 : 0)

/** Orders agents as a tree: each parent followed by its children, active first. */
export function ordered(agents: readonly AgentView[]): { agent: AgentView; depth: number }[] {
  const ids = new Set(agents.map(agent => agent.id))
  const children = new Map<string | null, AgentView[]>()
  for (const agent of agents) {
    const parent = agent.parentId && ids.has(agent.parentId) ? agent.parentId : null
    children.set(parent, [...(children.get(parent) ?? []), agent])
  }
  const out: { agent: AgentView; depth: number }[] = []
  const walk = (parent: string | null, depth: number) => {
    const level = [...(children.get(parent) ?? [])].sort((a, b) => Number(b.active) - Number(a.active) || b.lastAt - a.lastAt)
    for (const agent of level) {
      out.push({ agent, depth })
      walk(agent.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

/** The argv that hands a URL to the OS, by platform. */
export function openUrlArgv(url: string, isWindows: boolean, isMac: boolean): string[] {
  if (isWindows) return ['rundll32', 'url.dll,FileProtocolHandler', url]
  return [isMac ? 'open' : 'xdg-open', url]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The Claude Code extension's link that opens one of its sessions in VS Code; null for an id it would refuse. */
export function vscodeLink(sessionId: string): string | null {
  return UUID.test(sessionId) ? `vscode://anthropic.claude-code/open?session=${sessionId}` : null
}

/**
 * The `code` command lines that bring a VS Code session to the front: first
 * the window of its folder (focused when open, opened when not), then the
 * extension's link, which VS Code hands to the window just focused.
 */
export function vscodeArgvs(cwd: string, link: string, isWindows: boolean): string[][] {
  // `code` is a .cmd script on Windows, run through cmd.
  const code = isWindows ? ['cmd', '/d', '/c', 'code'] : ['code']
  // cmd reads `&`, `|`, `<`, `>`, `^`, `%`, `!` and quotes in a folder name ("R&D") as its own
  // syntax: such a folder is not focused first, and the link alone opens the session.
  const isSafe = cwd !== '' && !(isWindows && /[&|<>^%!"]/.test(cwd))
  return [
    ...(isSafe ? [[...code, cwd]] : []),
    [...code, '--open-url', link],
  ]
}

/** The desktop app's link that brings one of its sessions to the front. */
export function desktopLink(hostSessionId: string): string {
  return `claude://code/continue?session=${encodeURIComponent(hostSessionId)}&source=desktop_action`
}
