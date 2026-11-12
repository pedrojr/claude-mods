// Pure helpers for what the current session does: the tips the icon on
// usage-bar's line counts and the pane lists, ranked by the tokens each one would save.

import type { Lang, Live, Tip } from '../types'

/** A tool result over this many estimated tokens is a large output. */
export const BIG_OUTPUT_TOKENS = 5_000
/** A file re-read only counts when the read was at least this large. */
export const REREAD_MIN_TOKENS = 1_000
/** The prompt cache lifetime Claude Code uses on subscriptions; some API setups use 5 minutes. */
export const CACHE_TTL_MS = 60 * 60 * 1000
/** Below this much context, a cold cache or a model switch costs little. */
export const WARM_CONTEXT_TOKENS = 20_000
/** Context fill, in percent, from which a tip suggests /compact. */
export const CONTEXT_WARN_PERCENT = 60
/** Preload share of the window, in percent, from which a tip points to /advisor. */
export const PRELOAD_WARN_PERCENT = 15
/** How many large outputs and switches the live state keeps. */
export const MAX_KEPT = 20

export const emptyLive = (): Live => ({
  reads: {},
  bigOutputs: [],
  prompts: 0,
  lastModel: null,
  lastEffort: null,
  modelSwitches: [],
  lastResponseAt: null,
  coldStarts: [],
  contextTokens: null,
  contextWindow: null,
  preloadTokens: null,
})

/** Characters to tokens, the usual estimate of about 4 characters a token. */
export const estimateTokens = (chars: number): number => Math.ceil(chars / 4)

/** "61k", "1.2M", "850". */
export function tokenLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`
  return String(Math.round(tokens))
}

/** The last part of a path, either slash. */
export const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/** "claude-opus-5-5" reads "opus"; an id of no known family stays as it is. */
export function shortModel(id: string): string {
  return ['haiku', 'sonnet', 'opus', 'fable'].find(m => id.toLowerCase().includes(m)) ?? id
}

// Common short words of each language; the one with most hits wins. The same
// lists as usage-bar's, less Spanish, which reads as English here.
const WORDS: Record<Lang, readonly string[]> = {
  en: ['the', 'and', 'is', 'are', 'what', 'how', 'this', 'that', 'with', 'for', 'you', 'please', 'add', 'make', 'should', 'it'],
  pt: ['não', 'que', 'uma', 'para', 'com', 'está', 'isso', 'esse', 'essa', 'você', 'também', 'como', 'fazer', 'mais', 'pode', 'deve', 'ao', 'são'],
}

export function detectLang(text: string): Lang | null {
  const words = text.toLowerCase().match(/[a-zà-ÿ]+/g) ?? []
  if (words.length < 3) return null
  const set = new Set(words)
  const pt = WORDS.pt.filter(w => set.has(w)).length + (/[ãõç]/.test(text) ? 2 : 0)
  const en = WORDS.en.filter(w => set.has(w)).length
  if (Math.max(pt, en) < 2) return null
  return pt > en ? 'pt' : 'en'
}

/** A one-line description of a tool call, for the evidence of a large output. */
export function describeCall(tool: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : null)
  const raw = str('command') ?? str('file_path') ?? str('pattern') ?? str('url') ?? str('query') ?? str('description') ?? tool
  const one = raw.replace(/\s+/g, ' ').trim()
  const short = tool === 'Read' && str('file_path') ? baseName(one) : one
  return short.length > 48 ? `${short.slice(0, 47)}…` : short
}

const TEXT = {
  reread: {
    pt: (file: string, n: number, t: string) => `${file} foi lido ${n}x (~${t} tokens cada). Peça só um trecho (offset/limit) em vez de reler.`,
    en: (file: string, n: number, t: string) => `${file} was read ${n} times (~${t} tokens each). Ask for a range (offset/limit) instead of a full re-read.`,
  },
  big: {
    pt: (tool: string, what: string, t: string) => `Saída de ${tool} com ~${t} tokens (${what}). Filtre com head, grep ou --quiet.`,
    en: (tool: string, what: string, t: string) => `${tool} output of ~${t} tokens (${what}). Filter it with head, grep or --quiet.`,
  },
  context: {
    pt: (p: number, t: string) => `Contexto em ${p}% (${t}). Use /compact, ou /clear se a tarefa mudou.`,
    en: (p: number, t: string) => `Context at ${p}% (${t}). Run /compact, or /clear if the task changed.`,
  },
  cold: {
    pt: (m: number, t: string) => `Pausa de ${m} min: o cache expirou e ~${t} tokens foram reescritos. Para tarefa nova, /clear antes.`,
    en: (m: number, t: string) => `${m} min pause: the cache expired and ~${t} tokens were written again. For a new task, /clear first.`,
  },
  switch: {
    pt: (from: string, to: string, t: string) => `Troca de modelo ${from}→${to} com ~${t} de contexto: tudo foi lido de novo, sem cache.`,
    en: (from: string, to: string, t: string) => `Model switch ${from}→${to} with ~${t} of context: all of it was read again, uncached.`,
  },
  preload: {
    pt: (p: number, t: string) => `O preload ocupa ${p}% da janela (~${t}) antes do primeiro prompt. Detalhes em /advisor.`,
    en: (p: number, t: string) => `The preload takes ${p}% of the window (~${t}) before the first prompt. Details in /advisor.`,
  },
  calm: {
    pt: (p: number | null) => (p === null ? 'Nenhum desperdício visto nesta sessão.' : `Nenhum desperdício visto. Preload: ${p}% da janela.`),
    en: (p: number | null) => (p === null ? 'No waste seen in this session.' : `No waste seen. Preload: ${p}% of the window.`),
  },
} as const

const pct = (part: number, whole: number): number => Math.round((part / whole) * 100)

/** Every tip the session's state calls for, the most tokens first. */
export function liveTips(live: Live, lang: Lang): Tip[] {
  const tips: Tip[] = []
  for (const [path, r] of Object.entries(live.reads)) {
    if (r.count < 2 || r.tokens < REREAD_MIN_TOKENS) continue
    tips.push({ id: `reread:${path}`, tokens: (r.count - 1) * r.tokens, text: TEXT.reread[lang](baseName(path), r.count, tokenLabel(r.tokens)) })
  }
  const biggest = [...live.bigOutputs].sort((a, b) => b.tokens - a.tokens)[0]
  if (biggest) {
    const total = live.bigOutputs.reduce((n, o) => n + o.tokens, 0)
    tips.push({ id: 'big', tokens: total, text: TEXT.big[lang](biggest.tool, biggest.what, tokenLabel(biggest.tokens)) })
  }
  if (live.contextTokens !== null && live.contextWindow) {
    const p = pct(live.contextTokens, live.contextWindow)
    if (p >= CONTEXT_WARN_PERCENT) {
      tips.push({ id: 'context', tokens: live.contextTokens, text: TEXT.context[lang](p, tokenLabel(live.contextTokens)) })
    }
  }
  const cold = live.coldStarts[live.coldStarts.length - 1]
  if (cold) {
    const total = live.coldStarts.reduce((n, c) => n + c.contextTokens, 0)
    tips.push({ id: 'cold', tokens: total, text: TEXT.cold[lang](cold.idleMinutes, tokenLabel(cold.contextTokens)) })
  }
  const sw = live.modelSwitches[live.modelSwitches.length - 1]
  if (sw) {
    const total = live.modelSwitches.reduce((n, s) => n + s.contextTokens, 0)
    tips.push({ id: 'switch', tokens: total, text: TEXT.switch[lang](shortModel(sw.from), shortModel(sw.to), tokenLabel(sw.contextTokens)) })
  }
  if (live.preloadTokens !== null && live.contextWindow) {
    const p = pct(live.preloadTokens, live.contextWindow)
    if (p >= PRELOAD_WARN_PERCENT) {
      tips.push({ id: 'preload', tokens: live.preloadTokens, text: TEXT.preload[lang](p, tokenLabel(live.preloadTokens)) })
    }
  }
  return tips.sort((a, b) => b.tokens - a.tokens)
}

/** The line the pane shows when there is no tip. */
export function calmText(live: Live, lang: Lang): string {
  const p = live.preloadTokens !== null && live.contextWindow ? pct(live.preloadTokens, live.contextWindow) : null
  return TEXT.calm[lang](p)
}

/** A Read that takes the whole file, the only kind a re-read wastes. */
export function isFullRead(input: Record<string, unknown>): boolean {
  return input.offset === undefined && input.limit === undefined && input.pages === undefined
}
