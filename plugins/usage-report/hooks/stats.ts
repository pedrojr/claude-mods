// Pure helpers: today's usage from the transcripts Claude Code keeps on disk.
//   <config>/projects/<slug>/<sessionId>.jsonl                          a session
//   <config>/projects/<slug>/<sessionId>/subagents/agent-<id>.jsonl     its subagents
//   <config>/projects/<slug>/<sessionId>/subagents/agent-<id>.meta.json

import type { Count, Report, SessionUsage, Tokens } from '../types'

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
  /** The session's title (`/rename` or the app's), the last one written. */
  title: string | null
  /** The first prompt of the period, cut short: the name when there is no title. */
  firstPrompt: string | null
}

/** Dollars per million tokens. Cache writes at the 1-hour rate (2x input) Claude Code uses on subscriptions. */
type Price = { input: number; output: number; cacheRead: number; cacheWrite: number }

const price = (input: number, output: number, cacheRead = input / 10): Price => ({ input, output, cacheRead, cacheWrite: input * 2 })

/** First-party API list prices, by model id prefix; the longest matching prefix wins. */
export const PRICES: Readonly<Record<string, Price>> = {
  'claude-fable-5-2': price(8, 40, 0.2),
  'claude-fable-5-1': price(10, 50),
  'claude-fable-5': price(10, 50),
  'claude-mythos-5-2': price(8, 40, 0.2),
  'claude-mythos-5': price(10, 50),
  'claude-opus-5-5': price(4, 20, 0.2),
  'claude-opus-5': price(5, 25),
  'claude-opus-4': price(5, 25),
  'claude-sonnet-5-5': price(2, 10, 0.1),
  'claude-sonnet-5': price(2, 10),
  'claude-sonnet-4': price(3, 15),
  'claude-haiku-5-5': price(0.1, 0.5),
  'claude-haiku-4': price(1, 5),
}

/** Estimated list-price cost of a response; 0 for a model not in the table. */
export function costOf(model: string, t: Tokens): number {
  const key = Object.keys(PRICES)
    .filter(k => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0]
  if (!key) return 0
  const p = PRICES[key]!
  return (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead + t.cacheWrite * p.cacheWrite) / 1_000_000
}

/** Share of the input tokens read from the prompt cache. */
export const cacheHitRate = (t: Tokens): number => {
  const read = t.input + t.cacheRead + t.cacheWrite
  return read > 0 ? t.cacheRead / read : 0
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
  customTitle?: string
  isMeta?: boolean
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
  const stats: FileStats = { messages: {}, calls: {}, retries: 0, apiErrors: 0, interrupts: 0, title: null, firstPrompt: null }
  // The tool of the last failed call, until the next call shows whether it was tried again.
  let failedTool: string | null = null
  const feed = (raw: string): void => {
    // Cheap filter before parsing: only these lines count.
    if (!raw.startsWith('{') || !(raw.includes('"assistant"') || raw.includes('"user"') || raw.includes('"custom-title"'))) return
    let line: Line
    try {
      line = JSON.parse(raw) as Line
    } catch {
      return
    }
    // A title line has no timestamp: it names the session whatever the period.
    if (line.type === 'custom-title') {
      if (typeof line.customTitle === 'string' && line.customTitle.trim()) stats.title = line.customTitle.trim().slice(0, 80)
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
        else if (stats.firstPrompt === null && !line.isMeta && !sidechain && !content.startsWith('<')) {
          const text = content.trim().split('\n')[0]!.trim()
          if (text) stats.firstPrompt = text.length > 60 ? `${text.slice(0, 59)}…` : text
        }
        return
      }
      if (!Array.isArray(content)) return
      for (const block of content) {
        if (block.type === 'text' && block.text?.startsWith(INTERRUPT)) stats.interrupts += 1
        else if (block.type === 'text' && stats.firstPrompt === null && !line.isMeta && !sidechain && block.text && !block.text.startsWith('<')) {
          const text = block.text.trim().split('\n')[0]!.trim()
          if (text) stats.firstPrompt = text.length > 60 ? `${text.slice(0, 59)}…` : text
        }
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

/** Local midnight of the day `now` falls in, or of `days - 1` days before it. */
export function startOfDay(now: number, days = 1): number {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  day.setDate(day.getDate() - (days - 1))
  return day.getTime()
}

/** `/report`, `/report today` → 1; `/report week`, `/report 7d`, `/report semana` → 7; anything else null. */
export function parseDays(args: string): number | null {
  const word = args.trim().toLowerCase()
  if (word === '' || word === 'today' || word === 'day' || word === 'hoje' || word === 'hoy' || word === '1d') return 1
  if (word === 'week' || word === '7d' || word === '7' || word === 'semana') return 7
  return null
}

/** "$12.40", "$0.03". */
export const usd = (n: number): string => `$${n >= 100 ? n.toFixed(0) : n.toFixed(2)}`

const bump = (map: Map<string, number>, key: string, by = 1) => map.set(key, (map.get(key) ?? 0) + by)

const ranked = (map: Map<string, number>): Count[] =>
  [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

/**
 * One transcript as `report` takes it. `sessionId` ties a subagent's file to
 * its session; `project` is the session's folder name, the last-resort label.
 */
export type FileInput = {
  kind: 'session' | 'agent'
  agentType?: string
  sessionId?: string
  project?: string
  stats: FileStats
}

/** The sessions that used the most tokens, with their subagents' responses counted in. */
function topSessions(files: readonly FileInput[], limit: number): SessionUsage[] {
  const by = new Map<string, { name: string; messages: Map<string, MessageRow> }>()
  for (const file of files) {
    if (!file.sessionId) continue
    const entry = by.get(file.sessionId) ?? { name: '', messages: new Map<string, MessageRow>() }
    if (file.kind === 'session') {
      entry.name = file.stats.title ?? file.stats.firstPrompt ?? `${file.project ?? 'session'} · ${file.sessionId.slice(0, 8)}`
    }
    for (const [id, row] of Object.entries(file.stats.messages)) {
      const seen = entry.messages.get(id)
      entry.messages.set(id, seen ? { ...seen, tokens: maxTokens(seen.tokens, row.tokens) } : row)
    }
    by.set(file.sessionId, entry)
  }
  const rows: SessionUsage[] = []
  for (const [id, entry] of by) {
    if (entry.messages.size === 0) continue
    let tokens = 0
    let cost = 0
    const perModel = new Map<string, number>()
    for (const m of entry.messages.values()) {
      const t = totalOf(m.tokens)
      tokens += t
      cost += costOf(m.model, m.tokens)
      bump(perModel, m.model, t)
    }
    const model = ranked(perModel)[0]?.name ?? ''
    rows.push({ name: entry.name || id.slice(0, 8), model, tokens, costUsd: cost, responses: entry.messages.size })
  }
  return rows.sort((a, b) => b.tokens - a.tokens).slice(0, limit)
}

/** Adds up the period's transcripts, counting a message or a call once across files. */
export function report(files: readonly FileInput[], dayStart: number, now: number, skipped: number, days = 1): Report {
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
  const costByModel = new Map<string, number>()
  let costUsd = 0
  for (const m of messages.values()) {
    const cost = costOf(m.model, m.tokens)
    costUsd += cost
    costByModel.set(m.model, (costByModel.get(m.model) ?? 0) + cost)
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
    days,
    tokens,
    costUsd,
    topSessions: topSessions(files, 5),
    models: ranked(modelCounts).map(c => ({ ...c, tokens: totalOf(byModel.get(c.name)!), costUsd: costByModel.get(c.name) ?? 0 })),
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
    r.days === 1 ? `Usage today` : `Usage, last ${r.days} days`,
    `Tokens: ${compact(totalOf(t))} (input ${compact(t.input)} · output ${compact(t.output)} · cache read ${compact(t.cacheRead)} · cache write ${compact(t.cacheWrite)})`,
    `Cache hit: ${percent(t.cacheRead, t.input + t.cacheRead + t.cacheWrite)} of input read from the cache`,
    `Estimated cost at API prices: ${usd(r.costUsd)}`,
    `Models: ${r.models.map(m => `${m.name} ${m.count} (${compact(m.tokens)} tok, ${usd(m.costUsd)})`).join(' · ') || 'none'}`,
    ...(r.topSessions.length
      ? ['Top sessions:', ...r.topSessions.map((s, i) => `  ${i + 1}. ${s.name} · ${s.model} · ${compact(s.tokens)} tok · ${usd(s.costUsd)}`)]
      : []),
    `Effort: ${r.efforts.map(e => `${e.name} ${e.count}`).join(' · ') || 'none'}`,
    `Tool calls: ${r.tools.total} · ok ${r.tools.ok} · error ${r.tools.errors} · denied ${r.tools.denied}`,
    `Retries ${r.retries} · API errors ${r.apiErrors} · interrupted ${r.interrupts}`,
    `Sessions ${r.sessions} · subagents ${r.agents.total}${r.agents.byType.length ? ` (${r.agents.byType.map(a => `${a.name} ${a.count}`).join(', ')})` : ''}`,
  ]
  if (r.skipped > 0) lines.push(`${r.skipped} transcript(s) could not be read.`)
  return lines.join('\n')
}
