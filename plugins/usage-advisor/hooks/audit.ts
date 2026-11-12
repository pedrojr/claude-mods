// Pure helpers of the audit /advisor opens: the recent sessions of the project
// from the transcripts Claude Code keeps on disk, the context a session starts
// with, and what follows from both (diagnosis, proposed changes, habits).
//
//   <config>/projects/<slug>/<sessionId>.jsonl   one session, one JSON object a line

import type { Audit, Basis, Lang, PreloadItem, Problem, Proposal, SessionRow } from '../types'
import { BIG_OUTPUT_TOKENS, REREAD_MIN_TOKENS, WARM_CONTEXT_TOKENS, baseName, describeCall, estimateTokens, shortModel, tokenLabel } from './live'

/** How many recent sessions the audit reads. */
export const SESSIONS_READ = 10
/** A memory file above this many tokens is flagged; the set of them above SET. */
export const MEMORY_FILE_WARN = 5_000
export const MEMORY_SET_WARN = 10_000
/** A skill or agent description above this many tokens is flagged. */
export const DESCRIPTION_WARN = 250
/** A response after a pause longer than this that re-writes the cache is a cold start. */
export const PAUSE_MS = 5 * 60 * 1000
/** Requests over this much context count toward a long session. */
export const LONG_CONTEXT_TOKENS = 150_000
/** A session whose cache hit is under this share is flagged. */
export const LOW_CACHE_HIT = 0.7

// Input-equivalent weights, from the list prices: a cache read costs a tenth of
// an input token, a 1-hour cache write twice one. They put problems of
// different kinds on one scale for the ranking.
const READ_WEIGHT = 0.1
const WRITE_WEIGHT = 2

/** The folder Claude Code names a project's transcripts after: every character not a letter or a digit becomes "-". */
export const projectSlug = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-')

type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}
type Block = {
  type?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  text?: string
  content?: string | { type?: string; text?: string }[]
}
type Line = {
  type?: string
  timestamp?: string
  isSidechain?: boolean
  isMeta?: boolean
  isApiErrorMessage?: boolean
  effort?: string
  customTitle?: string
  message?: { id?: string; model?: string; usage?: Usage; content?: string | Block[] }
}

type Response = { model: string; effort: string | null; at: number; input: number; output: number; cacheRead: number; cacheWrite: number }

const num = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0)

function resultChars(content: Block['content']): number {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  return content.reduce((n, c) => n + (typeof c.text === 'string' ? c.text.length : 0), 0)
}

function promptText(line: Line): string | null {
  if (line.isMeta) return null
  const content = line.message?.content
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? (content.find(b => b.type === 'text' && typeof b.text === 'string')?.text ?? null)
        : null
  if (text === null) return null
  // Command wrappers, hook output and interruptions are no prompts the person typed.
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.startsWith('<') || trimmed.startsWith('[Request interrupted')) return null
  return trimmed
}

/** Reads one session's transcript line by line. */
export function createSessionParser(id: string): { line: (raw: string) => void; result: () => SessionRow } {
  const responses = new Map<string, Response>()
  const calls = new Map<string, { tool: string; input: Record<string, unknown> }>()
  const reads = new Map<string, { count: number; tokens: number }>()
  const bigOutputs: SessionRow['bigOutputs'] = []
  const servers = new Set<string>()
  let turns = 0
  let title: string | null = null
  let firstPrompt: string | null = null
  let startedAt = Infinity
  let endedAt = 0

  const line = (raw: string): void => {
    if (!raw.startsWith('{')) return
    let l: Line
    try {
      l = JSON.parse(raw) as Line
    } catch {
      return
    }
    if (l.type === 'custom-title') {
      if (typeof l.customTitle === 'string' && l.customTitle.trim()) title = l.customTitle.trim().slice(0, 60)
      return
    }
    if (l.isSidechain || (l.type !== 'assistant' && l.type !== 'user')) return
    const at = l.timestamp ? Date.parse(l.timestamp) : NaN
    if (Number.isFinite(at)) {
      startedAt = Math.min(startedAt, at)
      endedAt = Math.max(endedAt, at)
    }
    const content = l.message?.content

    if (l.type === 'assistant') {
      if (l.isApiErrorMessage) return
      const mid = l.message?.id
      const model = l.message?.model
      if (mid && model && model !== '<synthetic>' && Number.isFinite(at)) {
        const u = l.message?.usage ?? {}
        const seen = responses.get(mid)
        // A response's blocks are written one line each; keep the largest reading.
        responses.set(mid, {
          model,
          effort: seen?.effort ?? (typeof l.effort === 'string' ? l.effort : null),
          at: seen?.at ?? at,
          input: Math.max(seen?.input ?? 0, num(u.input_tokens)),
          output: Math.max(seen?.output ?? 0, num(u.output_tokens)),
          cacheRead: Math.max(seen?.cacheRead ?? 0, num(u.cache_read_input_tokens)),
          cacheWrite: Math.max(seen?.cacheWrite ?? 0, num(u.cache_creation_input_tokens)),
        })
      }
      if (!Array.isArray(content)) return
      for (const b of content) {
        if (b.type !== 'tool_use' || !b.id || !b.name || calls.has(b.id)) continue
        const input = b.input ?? {}
        calls.set(b.id, { tool: b.name, input })
        if (b.name.startsWith('mcp__')) servers.add(b.name.split('__')[1] ?? b.name)
      }
      return
    }

    const prompt = promptText(l)
    if (prompt !== null) {
      turns += 1
      if (firstPrompt === null) firstPrompt = prompt.split('\n')[0]!.slice(0, 60)
    }
    if (!Array.isArray(content)) return
    for (const b of content) {
      if (b.type !== 'tool_result' || !b.tool_use_id) continue
      const call = calls.get(b.tool_use_id)
      if (!call) continue
      const tokens = estimateTokens(resultChars(b.content))
      const path = typeof call.input.file_path === 'string' ? call.input.file_path : null
      if (call.tool === 'Read' && path && call.input.offset === undefined && call.input.limit === undefined) {
        const r = reads.get(path) ?? { count: 0, tokens: 0 }
        reads.set(path, { count: r.count + 1, tokens })
      }
      if (tokens >= BIG_OUTPUT_TOKENS) bigOutputs.push({ tool: call.tool, what: describeCall(call.tool, call.input), tokens })
    }
  }

  const result = (): SessionRow => {
    const list = [...responses.values()].sort((a, b) => a.at - b.at)
    const coldStarts: SessionRow['coldStarts'] = []
    let modelSwitches = 0
    let maxContext = 0
    list.forEach((r, i) => {
      maxContext = Math.max(maxContext, r.input + r.cacheRead + r.cacheWrite)
      const prev = list[i - 1]
      if (!prev) return
      if (prev.model !== r.model) modelSwitches += 1
      // A pause, then most of the context written again instead of read.
      const gap = r.at - prev.at
      if (gap > PAUSE_MS && r.cacheWrite >= WARM_CONTEXT_TOKENS && r.cacheWrite > r.cacheRead) {
        coldStarts.push({ idleMinutes: Math.round(gap / 60_000), tokens: r.cacheWrite })
      }
    })
    const sum = (k: 'input' | 'output' | 'cacheRead' | 'cacheWrite') => list.reduce((n, r) => n + r[k], 0)
    const rereads = [...reads.entries()]
      .filter(([, r]) => r.count >= 2 && r.tokens >= REREAD_MIN_TOKENS)
      .map(([path, r]) => ({ path, count: r.count, tokens: (r.count - 1) * r.tokens }))
      .sort((a, b) => b.tokens - a.tokens)
    return {
      id,
      name: title ?? firstPrompt ?? id.slice(0, 8),
      startedAt: Number.isFinite(startedAt) ? startedAt : 0,
      endedAt,
      turns,
      requests: list.length,
      input: sum('input'),
      output: sum('output'),
      cacheWrite: sum('cacheWrite'),
      cacheRead: sum('cacheRead'),
      maxContext,
      models: [...new Set(list.map(r => r.model))],
      efforts: [...new Set(list.map(r => r.effort).filter((e): e is string => e !== null))],
      modelSwitches,
      rereads,
      bigOutputs: bigOutputs.sort((a, b) => b.tokens - a.tokens).slice(0, 10),
      coldStarts,
      mcpServers: [...servers],
    }
  }

  return { line, result }
}

export function parseSession(id: string, text: string): SessionRow {
  const p = createSessionParser(id)
  for (const raw of text.split('\n')) p.line(raw)
  return p.result()
}

/** Share of the input read from the cache. */
export const cacheHit = (s: Pick<SessionRow, 'input' | 'cacheRead' | 'cacheWrite'>): number => {
  const all = s.input + s.cacheRead + s.cacheWrite
  return all > 0 ? s.cacheRead / all : 0
}

/** The breakdown fields the preload is read from (SessionContextBreakdown, narrowed). */
export type Breakdown = {
  categories: readonly { name: string; tokens: number; kind: string }[]
  memoryFiles: readonly { path: string; type: string; tokens: number }[]
  mcpTools: readonly { name: string; serverName: string; tokens: number; isLoaded: boolean }[]
  agents: readonly { agentType: string; source: string; tokens: number }[]
  skills?: { tokens: number; skillFrontmatter: readonly { name: string; tokens: number; pluginName?: string }[] }
  slashCommands?: { tokens: number; includedCommands: number }
}

/** The categories that grow with the conversation, not the preload. Matched by name: no kind tells them apart. */
const isConversation = (name: string): boolean => /message|free|buffer/i.test(name)

/**
 * What a session starts with, the largest first: each memory file, each MCP
 * server, each skill and agent description, and the rest of each category.
 */
export function preloadOf(b: Breakdown): { items: PreloadItem[]; total: number } {
  const items: PreloadItem[] = []
  for (const f of b.memoryFiles) items.push({ kind: 'memory', name: baseName(f.path), tokens: f.tokens, detail: `${f.type} · ${f.path}` })
  const servers = new Map<string, { tokens: number; tools: number }>()
  for (const t of b.mcpTools) {
    if (!t.isLoaded) continue
    const s = servers.get(t.serverName) ?? { tokens: 0, tools: 0 }
    servers.set(t.serverName, { tokens: s.tokens + t.tokens, tools: s.tools + 1 })
  }
  for (const [name, s] of servers) items.push({ kind: 'mcp', name, tokens: s.tokens, detail: `${s.tools} tools` })
  for (const s of b.skills?.skillFrontmatter ?? []) {
    items.push({ kind: 'skills', name: s.name, tokens: s.tokens, detail: s.pluginName ? `plugin ${s.pluginName}` : 'skill' })
  }
  for (const a of b.agents) items.push({ kind: 'agents', name: a.agentType, tokens: a.tokens, detail: a.source })
  if (b.slashCommands) {
    items.push({ kind: 'commands', name: 'slash commands', tokens: b.slashCommands.tokens, detail: `${b.slashCommands.includedCommands} commands` })
  }
  // The categories the items above do not already cover: the system prompt and the built-in tools.
  const covered = items.reduce((n, i) => n + i.tokens, 0)
  const used = b.categories.filter(c => c.kind === 'used' && !isConversation(c.name))
  const usedTotal = used.reduce((n, c) => n + c.tokens, 0)
  for (const c of used) {
    if (/memory|mcp|skill|agent|command/i.test(c.name)) continue
    items.push({ kind: /tool/i.test(c.name) ? 'tools' : /system/i.test(c.name) ? 'system' : 'other', name: c.name, tokens: c.tokens, detail: 'category' })
  }
  const total = Math.max(usedTotal, covered)
  return { items: items.filter(i => i.tokens > 0).sort((a, b) => b.tokens - a.tokens), total }
}

/** Lines of 25 characters or more that appear in more than one memory file. */
export function duplicateLines(files: readonly { path: string; text: string }[]): { line: string; paths: string[] }[] {
  const where = new Map<string, Set<string>>()
  for (const f of files) {
    for (const raw of f.text.split('\n')) {
      const line = raw.trim().replace(/\s+/g, ' ')
      if (line.length < 25 || /^[#>*\-|`]+$/.test(line)) continue
      const set = where.get(line) ?? new Set<string>()
      set.add(f.path)
      where.set(line, set)
    }
  }
  return [...where.entries()].filter(([, p]) => p.size > 1).map(([line, p]) => ({ line, paths: [...p] }))
}

const L = {
  pt: {
    preload: 'Preload da sessão',
    preloadEvidence: (n: number, top: string) => `${n} itens; o maior é ${top}`,
    everyRequest: 'toda requisição',
    mcpUnused: (s: string) => `MCP "${s}" sem uso`,
    mcpEvidence: (tools: number, n: number) => `${tools} ferramentas carregadas, 0 chamadas nas últimas ${n} sessões`,
    memoryBig: (f: string) => `${f} grande`,
    memoryEvidence: (t: string) => `~${t} tokens, acima do limite de ~5k`,
    memorySet: 'Conjunto de CLAUDE.md grande',
    memorySetEvidence: (t: string, n: number) => `${n} arquivos somam ~${t}, acima de ~10k`,
    duplicates: 'Conteúdo repetido entre arquivos de memória',
    duplicatesEvidence: (n: number, ex: string) => `${n} linhas repetidas; ex.: "${ex}"`,
    describeBig: (k: string, name: string) => `Descrição grande: ${k} ${name}`,
    describeEvidence: (t: string) => `~${t} tokens só na descrição`,
    rereads: 'Arquivos relidos por inteiro',
    rereadsEvidence: (top: string, n: number) => `${top} lido ${n}x numa sessão`,
    big: 'Saídas grandes de ferramentas',
    bigEvidence: (what: string, t: string) => `maior: ${what} (~${t})`,
    cold: 'Cache expirado após pausa',
    coldEvidence: (m: number, t: string) => `ex.: pausa de ${m} min reescreveu ~${t}`,
    switches: 'Troca de modelo no meio da sessão',
    switchesEvidence: (n: number) => `${n} trocas; cada uma relê o contexto sem cache`,
    long: 'Sessões longas',
    longEvidence: (n: number, t: string) => `${n} requisições acima de 150k; maior contexto ${t}`,
    lowHit: 'Baixo aproveitamento de cache',
    lowHitEvidence: (s: string, p: number) => `${s}: ${p}% de cache hit`,
    sessionsOf: (k: number, n: number) => `${k} de ${n} sessões`,
  },
  en: {
    preload: 'Session preload',
    preloadEvidence: (n: number, top: string) => `${n} items; the largest is ${top}`,
    everyRequest: 'every request',
    mcpUnused: (s: string) => `MCP "${s}" unused`,
    mcpEvidence: (tools: number, n: number) => `${tools} tools loaded, 0 calls in the last ${n} sessions`,
    memoryBig: (f: string) => `Large ${f}`,
    memoryEvidence: (t: string) => `~${t} tokens, over the ~5k limit`,
    memorySet: 'Large set of CLAUDE.md files',
    memorySetEvidence: (t: string, n: number) => `${n} files add up to ~${t}, over ~10k`,
    duplicates: 'Content repeated across memory files',
    duplicatesEvidence: (n: number, ex: string) => `${n} repeated lines; e.g. "${ex}"`,
    describeBig: (k: string, name: string) => `Large description: ${k} ${name}`,
    describeEvidence: (t: string) => `~${t} tokens in the description alone`,
    rereads: 'Files re-read whole',
    rereadsEvidence: (top: string, n: number) => `${top} read ${n} times in one session`,
    big: 'Large tool outputs',
    bigEvidence: (what: string, t: string) => `largest: ${what} (~${t})`,
    cold: 'Cache expired after a pause',
    coldEvidence: (m: number, t: string) => `e.g. a ${m} min pause wrote ~${t} again`,
    switches: 'Model switch mid-session',
    switchesEvidence: (n: number) => `${n} switches; each re-reads the context uncached`,
    long: 'Long sessions',
    longEvidence: (n: number, t: string) => `${n} requests over 150k; largest context ${t}`,
    lowHit: 'Low cache use',
    lowHitEvidence: (s: string, p: number) => `${s}: ${p}% cache hit`,
    sessionsOf: (k: number, n: number) => `${k} of ${n} sessions`,
  },
} as const

/** What the diagnosis reads. */
export type DiagnosisInput = {
  lang: Lang
  preload: PreloadItem[]
  preloadTokens: number
  preloadBasis: Basis
  contextWindow: number | null
  sessions: SessionRow[]
  duplicates: { line: string; paths: string[] }[]
}

function impactOf(weightPerSession: number): Problem['impact'] {
  return weightPerSession >= 50_000 ? 'high' : weightPerSession >= 10_000 ? 'medium' : 'low'
}

/** The diagnosis of phase 1C, the largest estimated impact first. Each problem's weight is in input-equivalent tokens. */
export function diagnose(d: DiagnosisInput): (Problem & { weight: number })[] {
  const t = L[d.lang]
  const n = Math.max(d.sessions.length, 1)
  const requests = d.sessions.reduce((k, s) => k + s.requests, 0)
  // A token of the preload is written once a session and read on every request.
  const preloadWeight = (tokens: number) => tokens * (WRITE_WEIGHT * n + READ_WEIGHT * requests)
  const avgRequests = requests / n
  // A token that enters the conversation is written once and read on about half the requests left.
  const carriedWeight = (tokens: number) => tokens * (WRITE_WEIGHT + (READ_WEIGHT * avgRequests) / 2)
  const out: (Problem & { weight: number })[] = []
  const push = (p: Omit<Problem, 'impact' | 'tokensLabel'> & { weight: number; tokensLabel?: string }) =>
    out.push({ ...p, tokensLabel: p.tokensLabel ?? `~${tokenLabel(p.tokens)}`, impact: impactOf(p.weight / n) })

  const top = d.preload[0]
  if (top && d.preloadTokens > 0) {
    const share = d.contextWindow ? ` (${Math.round((d.preloadTokens / d.contextWindow) * 100)}%)` : ''
    push({
      id: 'preload',
      title: t.preload,
      tokens: d.preloadTokens,
      tokensLabel: `~${tokenLabel(d.preloadTokens)}${share}`,
      frequency: t.everyRequest,
      evidence: t.preloadEvidence(d.preload.length, `${top.name} ~${tokenLabel(top.tokens)}`),
      basis: d.preloadBasis,
      weight: preloadWeight(d.preloadTokens),
    })
  }

  const used = new Set(d.sessions.flatMap(s => s.mcpServers.map(x => x.toLowerCase())))
  for (const item of d.preload.filter(i => i.kind === 'mcp')) {
    // Wire names replace what is not a letter, digit, - or _ with _.
    const wire = item.name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase()
    if (d.sessions.length === 0 || used.has(wire)) continue
    push({
      id: `mcp:${item.name}`,
      title: t.mcpUnused(item.name),
      tokens: item.tokens,
      frequency: t.everyRequest,
      evidence: t.mcpEvidence(Number.parseInt(item.detail, 10) || 0, d.sessions.length),
      basis: d.preloadBasis,
      weight: preloadWeight(item.tokens),
    })
  }

  const memory = d.preload.filter(i => i.kind === 'memory')
  for (const f of memory.filter(m => m.tokens > MEMORY_FILE_WARN)) {
    push({
      id: `memory:${f.detail}`,
      title: t.memoryBig(f.name),
      tokens: f.tokens,
      frequency: t.everyRequest,
      evidence: t.memoryEvidence(tokenLabel(f.tokens)),
      basis: d.preloadBasis,
      weight: preloadWeight(f.tokens / 2),
    })
  }
  const memoryTotal = memory.reduce((k, m) => k + m.tokens, 0)
  if (memoryTotal > MEMORY_SET_WARN) {
    push({
      id: 'memory-set',
      title: t.memorySet,
      tokens: memoryTotal,
      frequency: t.everyRequest,
      evidence: t.memorySetEvidence(tokenLabel(memoryTotal), memory.length),
      basis: d.preloadBasis,
      weight: preloadWeight((memoryTotal - MEMORY_SET_WARN) / 2),
    })
  }
  if (d.duplicates.length > 0) {
    const tokens = estimateTokens(d.duplicates.reduce((k, x) => k + x.line.length * (x.paths.length - 1), 0))
    const ex = d.duplicates[0]!.line
    push({
      id: 'duplicates',
      title: t.duplicates,
      tokens,
      frequency: t.everyRequest,
      evidence: t.duplicatesEvidence(d.duplicates.length, ex.length > 40 ? `${ex.slice(0, 39)}…` : ex),
      basis: 'estimated',
      weight: preloadWeight(tokens),
    })
  }
  for (const item of d.preload.filter(i => (i.kind === 'skills' || i.kind === 'agents') && i.tokens > DESCRIPTION_WARN)) {
    push({
      id: `describe:${item.kind}:${item.name}`,
      title: t.describeBig(item.kind === 'skills' ? 'skill' : 'agent', item.name),
      tokens: item.tokens,
      frequency: t.everyRequest,
      evidence: t.describeEvidence(tokenLabel(item.tokens)),
      basis: d.preloadBasis,
      weight: preloadWeight(item.tokens - DESCRIPTION_WARN),
    })
  }

  if (d.sessions.length === 0) return out.sort((a, b) => b.weight - a.weight)
  const withIt = (f: (s: SessionRow) => boolean) => d.sessions.filter(f).length

  const rereads = d.sessions.flatMap(s => s.rereads)
  if (rereads.length > 0) {
    const tokens = rereads.reduce((k, r) => k + r.tokens, 0)
    const worst = [...rereads].sort((a, b) => b.count - a.count)[0]!
    push({
      id: 'rereads',
      title: t.rereads,
      tokens,
      frequency: t.sessionsOf(withIt(s => s.rereads.length > 0), d.sessions.length),
      evidence: t.rereadsEvidence(baseName(worst.path), worst.count),
      basis: 'estimated',
      weight: carriedWeight(tokens),
    })
  }
  const big = d.sessions.flatMap(s => s.bigOutputs)
  if (big.length > 0) {
    const tokens = big.reduce((k, o) => k + o.tokens, 0)
    const worst = [...big].sort((a, b) => b.tokens - a.tokens)[0]!
    push({
      id: 'big',
      title: t.big,
      tokens,
      frequency: t.sessionsOf(withIt(s => s.bigOutputs.length > 0), d.sessions.length),
      evidence: t.bigEvidence(`${worst.tool} ${worst.what}`, tokenLabel(worst.tokens)),
      basis: 'estimated',
      weight: carriedWeight(tokens),
    })
  }
  const cold = d.sessions.flatMap(s => s.coldStarts)
  if (cold.length > 0) {
    const tokens = cold.reduce((k, c) => k + c.tokens, 0)
    const worst = [...cold].sort((a, b) => b.tokens - a.tokens)[0]!
    push({
      id: 'cold',
      title: t.cold,
      tokens,
      frequency: t.sessionsOf(withIt(s => s.coldStarts.length > 0), d.sessions.length),
      evidence: t.coldEvidence(worst.idleMinutes, tokenLabel(worst.tokens)),
      basis: 'measured',
      weight: tokens * (WRITE_WEIGHT - READ_WEIGHT),
    })
  }
  const switches = d.sessions.reduce((k, s) => k + s.modelSwitches, 0)
  if (switches > 0) {
    // The context at a switch, taken as the session's average request.
    const tokens = d.sessions.reduce((k, s) => k + (s.modelSwitches > 0 ? (s.maxContext / 2) * s.modelSwitches : 0), 0)
    push({
      id: 'switches',
      title: t.switches,
      tokens,
      frequency: t.sessionsOf(withIt(s => s.modelSwitches > 0), d.sessions.length),
      evidence: t.switchesEvidence(switches),
      basis: 'estimated',
      weight: tokens * (WRITE_WEIGHT - READ_WEIGHT),
    })
  }
  const long = d.sessions.filter(s => s.maxContext > LONG_CONTEXT_TOKENS)
  if (long.length > 0) {
    // What the requests past 100k of context read beyond it, roughly half of their requests.
    const tokens = long.reduce((k, s) => k + ((s.maxContext - 100_000) * s.requests) / 2, 0)
    const largest = Math.max(...long.map(s => s.maxContext))
    push({
      id: 'long',
      title: t.long,
      tokens,
      frequency: t.sessionsOf(long.length, d.sessions.length),
      evidence: t.longEvidence(long.reduce((k, s) => k + Math.round(s.requests / 2), 0), tokenLabel(largest)),
      basis: 'estimated',
      weight: tokens * READ_WEIGHT,
    })
  }
  const low = d.sessions.filter(s => s.requests >= 5 && cacheHit(s) < LOW_CACHE_HIT)
  if (low.length > 0) {
    const tokens = low.reduce((k, s) => k + s.input + s.cacheWrite, 0)
    const worst = [...low].sort((a, b) => cacheHit(a) - cacheHit(b))[0]!
    push({
      id: 'low-hit',
      title: t.lowHit,
      tokens,
      frequency: t.sessionsOf(low.length, d.sessions.length),
      evidence: t.lowHitEvidence(worst.name, Math.round(cacheHit(worst) * 100)),
      basis: 'measured',
      weight: tokens * 0.5,
    })
  }
  return out.sort((a, b) => b.weight - a.weight)
}

const P = {
  pt: {
    ask: (change: string, why: string) =>
      `Proposta do usage-advisor: ${change}\nMotivo: ${why}\nAntes de alterar qualquer arquivo ou configuração, me mostre exatamente o que vai mudar e espere meu OK.`,
    mcp: (s: string) => ({
      change: `Desativar o MCP "${s}" neste projeto (/mcp, ou "disabledMcpjsonServers" no settings do projeto).`,
      risk: `As ferramentas de ${s} somem até você reativar.`,
    }),
    memory: (f: string, path: string) => ({
      change: `Enxugar ${f} (${path}): tirar o que só vale às vezes e mover para um arquivo lido sob demanda.`,
      risk: 'O que sai do arquivo deixa de valer em toda sessão.',
    }),
    memorySet: { change: 'Revisar o conjunto de CLAUDE.md e imports: cortar regras que não mudam o comportamento.', risk: 'Regras cortadas deixam de valer.' },
    duplicates: (n: number) => ({ change: `Remover as ${n} linhas repetidas entre os arquivos de memória, deixando cada regra em um só lugar.`, risk: 'Baixo: o conteúdo continua em um arquivo.' }),
    describe: (k: string, name: string) => ({
      change: `Encurtar a descrição de ${k} "${name}", ou desativar o plugin que a traz se não for usada.`,
      risk: 'Uma descrição curta demais faz o modelo esquecer de usá-la.',
    }),
    big: (what: string) => ({
      change: `Reduzir a saída de "${what}": filtrar com head, grep, tail ou uma flag como --quiet.`,
      risk: 'Saída filtrada pode esconder um erro; peça a saída completa quando falhar.',
    }),
    gain: (t: string) => `~${t} tokens por sessão`,
    gainPerRequest: (t: string) => `~${t} tokens de contexto por requisição`,
  },
  en: {
    ask: (change: string, why: string) =>
      `usage-advisor proposal: ${change}\nWhy: ${why}\nBefore changing any file or setting, show me exactly what will change and wait for my OK.`,
    mcp: (s: string) => ({
      change: `Turn off the "${s}" MCP server in this project (/mcp, or "disabledMcpjsonServers" in the project settings).`,
      risk: `${s}'s tools are gone until you turn it back on.`,
    }),
    memory: (f: string, path: string) => ({
      change: `Trim ${f} (${path}): move what applies only sometimes into a file read on demand.`,
      risk: 'What leaves the file no longer applies in every session.',
    }),
    memorySet: { change: 'Review the set of CLAUDE.md files and imports: cut rules that change no behaviour.', risk: 'Cut rules no longer apply.' },
    duplicates: (n: number) => ({ change: `Remove the ${n} lines repeated across memory files, keeping each rule in one place.`, risk: 'Low: the content stays in one file.' }),
    describe: (k: string, name: string) => ({
      change: `Shorten the description of ${k} "${name}", or turn off the plugin that brings it if it goes unused.`,
      risk: 'A description too short makes the model forget to use it.',
    }),
    big: (what: string) => ({
      change: `Cut down the output of "${what}": filter it with head, grep, tail or a flag such as --quiet.`,
      risk: 'A filtered output can hide an error; ask for the full output when it fails.',
    }),
    gain: (t: string) => `~${t} tokens per session`,
    gainPerRequest: (t: string) => `~${t} tokens of context per request`,
  },
} as const

/** The changes of phase 2, one per configuration problem, in the diagnosis's order. */
export function propose(problems: readonly Problem[], preload: readonly PreloadItem[], sessions: readonly SessionRow[], lang: Lang): Proposal[] {
  const p = P[lang]
  const n = Math.max(sessions.length, 1)
  const out: Proposal[] = []
  const add = (id: string, change: string, why: string, gain: string, risk: string) =>
    out.push({ id, change, why, gain, risk, prompt: p.ask(change, why) })
  for (const pr of problems) {
    const why = `${pr.title}: ${pr.evidence}.`
    if (pr.id.startsWith('mcp:')) {
      const s = pr.id.slice(4)
      const m = p.mcp(s)
      add(pr.id, m.change, why, p.gainPerRequest(tokenLabel(pr.tokens)), m.risk)
    } else if (pr.id.startsWith('memory:')) {
      const item = preload.find(i => i.kind === 'memory' && `memory:${i.detail}` === pr.id)
      const path = item?.detail.split(' · ')[1] ?? pr.title
      const m = p.memory(item?.name ?? 'CLAUDE.md', path)
      add(pr.id, m.change, why, p.gainPerRequest(tokenLabel(pr.tokens / 2)), m.risk)
    } else if (pr.id === 'memory-set') {
      add(pr.id, p.memorySet.change, why, p.gainPerRequest(tokenLabel((pr.tokens - MEMORY_SET_WARN) / 2)), p.memorySet.risk)
    } else if (pr.id === 'duplicates') {
      const m = p.duplicates(Number.parseInt(pr.evidence, 10) || 0)
      add(pr.id, m.change, why, p.gainPerRequest(tokenLabel(pr.tokens)), m.risk)
    } else if (pr.id.startsWith('describe:')) {
      const [, kind, name] = pr.id.split(':')
      const m = p.describe(kind === 'skills' ? 'skill' : 'agent', name ?? '')
      add(pr.id, m.change, why, p.gainPerRequest(tokenLabel(pr.tokens - DESCRIPTION_WARN)), m.risk)
    } else if (pr.id === 'big') {
      // One proposal per command that keeps coming back large.
      const counts = new Map<string, { n: number; tokens: number }>()
      for (const o of sessions.flatMap(s => s.bigOutputs)) {
        const c = counts.get(o.what) ?? { n: 0, tokens: 0 }
        counts.set(o.what, { n: c.n + 1, tokens: c.tokens + o.tokens })
      }
      for (const [what, c] of [...counts.entries()].sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 3)) {
        const m = p.big(what)
        add(`big:${what}`, m.change, `${why} (${c.n}x)`, p.gain(tokenLabel(c.tokens / n)), m.risk)
      }
    }
  }
  return out
}

const H = {
  pt: {
    rereads: (f: string, n: number, t: string) => `Pare de pedir releituras inteiras: ${f} foi lido ${n}x numa sessão; peça a função ou o trecho (~${t} tokens a menos).`,
    cold: (k: number, t: string) => `Use /clear ao voltar de uma pausa para outra tarefa: ${k} retomadas reescreveram ~${t} tokens de cache.`,
    long: (k: number, t: string) => `Comece sessão nova por tarefa: ${k} sessões passaram de 150k de contexto (máximo ${t}).`,
    big: (what: string, t: string) => `Peça saídas filtradas: "${what}" trouxe ~${t} tokens de uma vez.`,
    switches: (k: number) => `Escolha o modelo no início da sessão: ${k} trocas no meio releram o contexto sem cache.`,
    lowHit: (s: string, p: number) => `Evite editar CLAUDE.md, MCPs ou skills no meio da sessão: "${s}" teve só ${p}% de cache hit.`,
    none: 'Sem evidência de desperdício nos hábitos das sessões lidas.',
  },
  en: {
    rereads: (f: string, n: number, t: string) => `Stop asking for whole re-reads: ${f} was read ${n} times in one session; ask for the function or the range (~${t} tokens less).`,
    cold: (k: number, t: string) => `Run /clear when you come back from a pause to another task: ${k} returns wrote ~${t} tokens of cache again.`,
    long: (k: number, t: string) => `Start a new session for each task: ${k} sessions went past 150k of context (largest ${t}).`,
    big: (what: string, t: string) => `Ask for filtered output: "${what}" brought ~${t} tokens at once.`,
    switches: (k: number) => `Pick the model at the start of the session: ${k} switches mid-session re-read the context uncached.`,
    lowHit: (s: string, p: number) => `Avoid editing CLAUDE.md, MCP servers or skills mid-session: "${s}" got only ${p}% cache hit.`,
    none: 'No evidence of wasteful habits in the sessions read.',
  },
} as const

/** The three habits of phase 3: only those the sessions give evidence of, the largest impact first. */
export function habits(problems: readonly (Problem & { weight: number })[], sessions: readonly SessionRow[], lang: Lang): string[] {
  const h = H[lang]
  const out: { weight: number; text: string }[] = []
  for (const pr of problems) {
    if (pr.id === 'rereads') {
      const worst = [...sessions.flatMap(s => s.rereads)].sort((a, b) => b.count - a.count)[0]
      if (worst) out.push({ weight: pr.weight, text: h.rereads(baseName(worst.path), worst.count, tokenLabel(pr.tokens)) })
    } else if (pr.id === 'cold') {
      out.push({ weight: pr.weight, text: h.cold(sessions.reduce((k, s) => k + s.coldStarts.length, 0), tokenLabel(pr.tokens)) })
    } else if (pr.id === 'long') {
      const long = sessions.filter(s => s.maxContext > LONG_CONTEXT_TOKENS)
      out.push({ weight: pr.weight, text: h.long(long.length, tokenLabel(Math.max(...long.map(s => s.maxContext)))) })
    } else if (pr.id === 'big') {
      const worst = [...sessions.flatMap(s => s.bigOutputs)].sort((a, b) => b.tokens - a.tokens)[0]
      if (worst) out.push({ weight: pr.weight, text: h.big(worst.what, tokenLabel(worst.tokens)) })
    } else if (pr.id === 'switches') {
      out.push({ weight: pr.weight, text: h.switches(sessions.reduce((k, s) => k + s.modelSwitches, 0)) })
    } else if (pr.id === 'low-hit') {
      const worst = [...sessions].filter(s => s.requests >= 5).sort((a, b) => cacheHit(a) - cacheHit(b))[0]
      if (worst) out.push({ weight: pr.weight, text: h.lowHit(worst.name, Math.round(cacheHit(worst) * 100)) })
    }
  }
  const top = out.sort((a, b) => b.weight - a.weight).slice(0, 3).map(x => x.text)
  return top.length > 0 ? top : [h.none]
}

/** What can change the model during a session without the person asking, from the merged settings. */
export function modelSwitchers(settings: Readonly<Record<string, unknown>>, lang: Lang): string[] {
  const out: string[] = []
  const plugins = settings.enabledPlugins
  const enabled = typeof plugins === 'object' && plugins !== null ? Object.entries(plugins as Record<string, unknown>) : []
  if (enabled.some(([k, v]) => k.startsWith('model-router@') && v === true)) {
    out.push(lang === 'pt' ? 'model-router: escolhe modelo e effort a cada prompt e sobe o modelo quando preciso' : 'model-router: picks model and effort on each prompt and moves the model up when needed')
  }
  if (settings.model === 'opusplan') {
    out.push(lang === 'pt' ? 'model "opusplan": opus no plan mode, sonnet fora dele' : 'model "opusplan": opus in plan mode, sonnet outside it')
  }
  if (Array.isArray(settings.availableModels)) {
    out.push(lang === 'pt' ? `availableModels limita a: ${settings.availableModels.join(', ')}` : `availableModels limits to: ${settings.availableModels.join(', ')}`)
  }
  return out
}

/**
 * The audit as a prompt the person can edit and send: the diagnosis, the
 * proposed changes and the habits, with the instruction to apply one change at
 * a time and wait for approval before each.
 */
export function auditPrompt(a: Pick<Audit, 'lang' | 'problems' | 'proposals' | 'habits'>): string {
  const pt = a.lang === 'pt'
  const impact = (i: Problem['impact']) => (pt ? { high: 'alto', medium: 'médio', low: 'baixo' }[i] : i)
  const lines: string[] = [pt ? 'Resultado do usage-advisor (auditoria de tokens deste projeto).' : 'usage-advisor result (token audit of this project).', '']
  lines.push(pt ? 'Diagnóstico:' : 'Diagnosis:')
  a.problems.forEach((p, i) =>
    lines.push(`${i + 1}. ${p.title}: ${p.tokensLabel}, ${p.frequency}, ${pt ? 'impacto' : 'impact'} ${impact(p.impact)} [${p.basis}]. ${p.evidence}.`),
  )
  if (a.proposals.length > 0) {
    lines.push('', pt ? 'Mudanças propostas:' : 'Proposed changes:')
    a.proposals.forEach((p, i) => lines.push(`${i + 1}. ${p.change} ${pt ? 'Ganho' : 'Gain'}: ${p.gain}. ${pt ? 'Risco' : 'Risk'}: ${p.risk}`))
  }
  lines.push('', pt ? 'Hábitos:' : 'Habits:', ...a.habits.map((h, i) => `${i + 1}. ${h}`), '')
  lines.push(
    pt
      ? 'Aplique as mudanças uma por vez, na ordem. Antes de alterar qualquer arquivo ou configuração, me mostre exatamente o que vai mudar e espere meu OK.'
      : 'Apply the changes one at a time, in order. Before changing any file or setting, show me exactly what will change and wait for my OK.',
  )
  return lines.join('\n')
}

/** "opus", "sonnet" for a list of model ids. */
export const modelsLabel = (ids: readonly string[]): string => ids.map(shortModel).join(', ') || '-'
