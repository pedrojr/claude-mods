// Pure helpers for the session list: parsing the registry Claude Code keeps in
// <config>/sessions/<pid>.json and the tail of a session's transcript.

import type { SessionRow } from '../types'

/** One `<config>/sessions/<pid>.json` as Claude Code writes it (the fields this mod reads). */
type RegistryEntry = {
  pid?: number
  sessionId?: string
  cwd?: string
  name?: string
  status?: string
  entrypoint?: string
  startedAt?: number
  updatedAt?: number
  statusUpdatedAt?: number
}

/** Parses one registry file; null when it is not a session entry. */
export function parseRegistry(text: string): Omit<SessionRow, 'activity' | 'isSelf'> | null {
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
    pid: entry.pid,
    name: entry.name?.trim() || folderOf(cwd) || entry.sessionId.slice(0, 8),
    cwd,
    status: typeof entry.status === 'string' ? entry.status : 'idle',
    entrypoint: surfaceLabel(entry.entrypoint),
    since: entry.statusUpdatedAt ?? entry.updatedAt ?? entry.startedAt ?? 0,
  }
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

const MAX_ACTIVITY = 70

function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > MAX_ACTIVITY ? `${line.slice(0, MAX_ACTIVITY - 1)}…` : line
}

/** A short phrase for one tool call: the tool and what it acts on. */
export function describeTool(name: string, input: Record<string, unknown>): string {
  const str = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : undefined)
  const target =
    str('description') ??
    (str('file_path') && folderOf(str('file_path')!)) ??
    (str('notebook_path') && folderOf(str('notebook_path')!)) ??
    str('pattern') ??
    str('url') ??
    str('query') ??
    str('skill') ??
    str('command') ??
    str('prompt')
  const tool = name.startsWith('mcp__') ? (name.split('__').pop() ?? name) : name
  return clip(target ? `${tool}: ${target}` : tool)
}

type Block = { type?: string; name?: string; input?: Record<string, unknown>; text?: string }
type Line = { type?: string; isSidechain?: boolean; message?: { content?: string | Block[] } }

/**
 * What a session did last, from the tail of its transcript: its last tool call,
 * else the first line of its last reply, else its last prompt.
 */
export function activityFromTranscript(text: string): string | null {
  const lines = text.split('\n')
  let prompt: string | null = null
  // Only the last few hundred lines matter.
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 400); i -= 1) {
    const raw = lines[i]
    if (!raw || raw[0] !== '{') continue
    let line: Line
    try {
      line = JSON.parse(raw) as Line
    } catch {
      continue
    }
    if (line.isSidechain) continue
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

const BUSY = new Set(['busy', 'running', 'working', 'waiting'])

export const isBusy = (status: string) => BUSY.has(status)

/** Busy sessions first, then by most recent status change. */
export function sortSessions(rows: readonly SessionRow[]): SessionRow[] {
  return [...rows].sort((a, b) => Number(isBusy(b.status)) - Number(isBusy(a.status)) || b.since - a.since)
}
