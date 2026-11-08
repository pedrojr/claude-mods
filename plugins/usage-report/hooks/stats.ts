// Pure helpers: today's usage from the transcripts Claude Code keeps on disk.
//   <config>/projects/<slug>/<sessionId>.jsonl                          a session
//   <config>/projects/<slug>/<sessionId>/subagents/agent-<id>.jsonl     its subagents
//   <config>/projects/<slug>/<sessionId>/subagents/agent-<id>.meta.json

import type { Count, Report, Tokens } from '../types'

/** One API response, counted once even when its blocks span several lines. */
export type MessageRow = { model: string; effort: string | null; tokens: Tokens; at: number }

/** One tool call and how it ended; `outcome` is null while no result is filed. */
export type CallRow = { tool: string; outcome: 'ok' | 'error' | 'denied' | null }

/** What one transcript holds for the day. Keyed by id so a line seen twice counts once. */
export type FileStats = {
  messages: Record<string, MessageRow>
  calls: Record<string, CallRow>
  /** A failed call followed by another call to the same tool. */
  retries: number
  /** Responses the API answered with an error (overload, rate limit, ...). */
  apiErrors: number
  /** Turns the person stopped. */
  interrupts: number
}

export const emptyTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

export const totalOf = (t: Tokens): number => t.input + t.output + t.cacheRead + t.cacheWrite

/** Each count the larger of two readings of the same response. */
export const maxTokens = (a: Tokens, b: Tokens): Tokens => ({
  input: Math.max(a.input, b.input),
  output: Math.max(a.output, b.output),
  cacheRead: Math.max(a.cacheRead, b.cacheRead),
  cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
})

type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}
type Block = { type?: string; id?: string; name?: string; tool_use_id?: string; is_error?: boolean; text?: string }
type Line = {
  type?: string
  timestamp?: string
  isSidechain?: boolean
  isApiErrorMessage?: boolean
  effort?: string
  toolDenialKind?: string
  message?: { id?: string; model?: string; usage?: Usage; content?: string | Block[] }
}

const INTERRUPT = '[Request interrupted by user'

/** `mcp__<server>__<tool>` reads as its tool's own name; built-in tools stay as they are. */
export const toolName = (name: string): string => (name.startsWith('mcp__') ? (name.split('__').pop() ?? name) : name)
const num = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0)

/**
 * Reads one transcript's lines from `dayStart` (epoch ms) on. A main transcript
 * skips side-chain lines: the subagent's own file holds them.
 */
export function parseTranscript(text: string, dayStart: number, sidechain = false): FileStats {
  const parser = createParser(dayStart, sidechain)
  for (const raw of text.split('\n')) parser.line(raw)
  return parser.stats
}

/** The same reading, fed one line at a time: for a transcript streamed in pieces. */
export function createParser(dayStart: number, sidechain = false): { line: (raw: string) => void; stats: FileStats } {
  const stats: FileStats = { messages: {}, calls: {}, retries: 0, apiErrors: 0, interrupts: 0 }
  // The tool of the last failed call, until the next call shows whether it was tried again.
  let failedTool: string | null = null
  const feed = (raw: string): void => {
    // Cheap filter before parsing: only these lines count.
    if (!raw.startsWith('{') || !(raw.includes('"assistant"') || raw.includes('"user"'))) return
    let line: Line
    try {
      line = JSON.parse(raw) as Line
    } catch {
      return
    }
    if (line.isSidechain && !sidechain) return
    const at = line.timestamp ? Date.parse(line.timestamp) : NaN
    if (!(at >= dayStart)) return
    const content = line.message?.content

    if (line.type === 'assistant') {
      if (line.isApiErrorMessage) {
        stats.apiErrors += 1
        return
      }
      const id = line.message?.id
      const model = line.message?.model
      if (id && model && model !== '<synthetic>') {
        const u = line.message?.usage ?? {}
        const tokens: Tokens = {
          input: num(u.input_tokens),
          output: num(u.output_tokens),
          cacheRead: num(u.cache_read_input_tokens),
          cacheWrite: num(u.cache_creation_input_tokens),
        }
        const seen = stats.messages[id]
        // A response's blocks are written one line each, and an early line can
        // carry the usage as it stood mid-stream: keep the largest reading.
        stats.messages[id] = seen
          ? { ...seen, tokens: maxTokens(seen.tokens, tokens) }
          : { model, effort: typeof line.effort === 'string' ? line.effort : null, at, tokens }
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type !== 'tool_use' || !block.id || !block.name) continue
          if (stats.calls[block.id]) continue
          const tool = toolName(block.name)
          if (failedTool !== null && failedTool === tool) stats.retries += 1
          failedTool = null
          stats.calls[block.id] = { tool, outcome: null }
        }
      }
      return
    }

    if (line.type === 'user') {
      if (typeof content === 'string') {
        if (content.startsWith(INTERRUPT)) stats.interrupts += 1
        return
      }
      if (!Array.isArray(content)) return
      for (const block of content) {
        if (block.type === 'text' && block.text?.startsWith(INTERRUPT)) stats.interrupts += 1
        if (block.type !== 'tool_result' || !block.tool_use_id) continue
        const call = stats.calls[block.tool_use_id]
        if (!call) continue
        call.outcome = line.toolDenialKind ? 'denied' : block.is_error ? 'error' : 'ok'
        if (call.outcome !== 'ok') failedTool = call.tool
      }
    }
  }
  return { line: feed, stats }
}

/** A subagent's type from its `agent-<id>.meta.json`. */
export function agentTypeOf(metaText: string): string {
  try {
    const meta = JSON.parse(metaText) as { agentType?: string }
    return meta.agentType?.trim() || 'agent'
  } catch {
    return 'agent'
  }
}

/** The agent id in `agent-<id>.jsonl`; null for any other file. */
export function agentIdOf(fileName: string): string | null {
  const match = /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(fileName)
  return match ? match[1]! : null
}

/** Local midnight of the day `now` falls in. */
export function startOfDay(now: number): number {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

const bump = (map: Map<string, number>, key: string, by = 1) => map.set(key, (map.get(key) ?? 0) + by)

const ranked = (map: Map<string, number>): Count[] =>
  [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

/** One transcript as `report` takes it. */
export type FileInput = { kind: 'session' | 'agent'; agentType?: string; stats: FileStats }

/** Adds up the day's transcripts, counting a message or a call once across files. */
export function report(files: readonly FileInput[], dayStart: number, now: number, skipped: number): Report {
  const messages = new Map<string, MessageRow>()
  const calls = new Map<string, CallRow>()
  let retries = 0
  let apiErrors = 0
  let interrupts = 0
  let sessions = 0
  const agentTypes = new Map<string, number>()
  for (const file of files) {
    const s = file.stats
    const ids = Object.keys(s.messages)
    // A file with nothing today does not count as a session or agent of the day.
    if (ids.length === 0 && Object.keys(s.calls).length === 0) continue
    if (file.kind === 'session') sessions += 1
    else bump(agentTypes, file.agentType ?? 'agent')
    for (const id of ids) {
      const row = s.messages[id]!
      const seen = messages.get(id)
      messages.set(id, seen ? { ...seen, tokens: maxTokens(seen.tokens, row.tokens) } : row)
    }
    for (const [id, call] of Object.entries(s.calls)) {
      const seen = calls.get(id)
      if (!seen || (seen.outcome === null && call.outcome !== null)) calls.set(id, call)
    }
    retries += s.retries
    apiErrors += s.apiErrors
    interrupts += s.interrupts
  }

  const tokens = emptyTokens()
  const byModel = new Map<string, Tokens>()
  const modelCounts = new Map<string, number>()
  const effortCounts = new Map<string, number>()
  for (const m of messages.values()) {
    const own = byModel.get(m.model) ?? emptyTokens()
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
      tokens[key] += m.tokens[key]
      own[key] += m.tokens[key]
    }
    byModel.set(m.model, own)
    bump(modelCounts, m.model)
    bump(effortCounts, m.effort ?? 'default')
  }

  const toolCounts = new Map<string, number>()
  const failCounts = new Map<string, number>()
  let ok = 0
  let errors = 0
  let denied = 0
  for (const call of calls.values()) {
    bump(toolCounts, call.tool)
    if (call.outcome === 'ok') ok += 1
    else if (call.outcome === 'error') errors += 1
    else if (call.outcome === 'denied') denied += 1
    if (call.outcome === 'error' || call.outcome === 'denied') bump(failCounts, call.tool)
  }

  return {
    dayStart,
    now,
    tokens,
    models: ranked(modelCounts).map(c => ({ ...c, tokens: totalOf(byModel.get(c.name)!) })),
    efforts: ranked(effortCounts),
    tools: { total: calls.size, ok, errors, denied, top: ranked(toolCounts).slice(0, 5), failing: ranked(failCounts).slice(0, 3) },
    retries,
    apiErrors,
    interrupts,
    sessions,
    agents: { total: [...agentTypes.values()].reduce((a, b) => a + b, 0), byType: ranked(agentTypes) },
    skipped,
  }
}

/** 1234 → 1.2k, 2_500_000 → 2.5M. */
export function compact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`
}

export const percent = (part: number, whole: number): string => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '0%')

/** The report as plain lines, for the command's reply and surfaces without the pane. */
export function reportText(r: Report): string {
  const t = r.tokens
  const lines = [
    `Usage today`,
    `Tokens: ${compact(totalOf(t))} (input ${compact(t.input)} · output ${compact(t.output)} · cache read ${compact(t.cacheRead)} · cache write ${compact(t.cacheWrite)})`,
    `Models: ${r.models.map(m => `${m.name} ${m.count} (${compact(m.tokens)} tok)`).join(' · ') || 'none'}`,
    `Effort: ${r.efforts.map(e => `${e.name} ${e.count}`).join(' · ') || 'none'}`,
    `Tool calls: ${r.tools.total} · ok ${r.tools.ok} · error ${r.tools.errors} · denied ${r.tools.denied}`,
    `Retries ${r.retries} · API errors ${r.apiErrors} · interrupted ${r.interrupts}`,
    `Sessions ${r.sessions} · subagents ${r.agents.total}${r.agents.byType.length ? ` (${r.agents.byType.map(a => `${a.name} ${a.count}`).join(', ')})` : ''}`,
  ]
  if (r.skipped > 0) lines.push(`${r.skipped} transcript(s) could not be read.`)
  return lines.join('\n')
}
