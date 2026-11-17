import type { EngineInterface as Engine } from 'claude-code'

import type { Lang } from '../types'

/** `pt-BR`, `pt_PT.UTF-8`, `Portuguese` read as pt; `en-US` as en; anything else is null. */
export function langOf(value: unknown): Lang | null {
  if (typeof value !== 'string') return null
  const v = value.trim().replace(/^[("'\s]+/, '')
  if (/^pt|^portugu/i.test(v)) return 'pt'
  if (/^en/i.test(v)) return 'en'
  return null
}

let found: Promise<Lang> | null = null

/**
 * The operating system's display language: Windows' UI culture, macOS's first
 * preferred language, else the locale variables. A language without a
 * translation falls back to English. Read once per module load.
 */
export function osLang($: Engine): Promise<Lang> {
  found ??= (async (): Promise<Lang> => {
    const [os, home] = await Promise.all([$.env.get('OS'), $.env.get('HOME')])
    const ask = async (argv: string[]): Promise<Lang | null> => {
      const out = await $.process.run(argv).catch(() => null)
      return out?.exitCode === 0 ? langOf(out.stdout) : null
    }
    if (os === 'Windows_NT') {
      const fromWindows = await ask(['powershell', '-NoProfile', '-Command', '(Get-UICulture).Name'])
      if (fromWindows) return fromWindows
    } else if ((home ?? '').startsWith('/Users/')) {
      const fromMac = await ask(['defaults', 'read', '-g', 'AppleLanguages'])
      if (fromMac) return fromMac
    }
    const fromEnv = langOf(await $.env.get('LC_ALL')) ?? langOf(await $.env.get('LC_MESSAGES')) ?? langOf(await $.env.get('LANG'))
    return fromEnv ?? 'en'
  })().catch(() => 'en' as Lang)
  return found
}

export const T = {
  en: {
    title: 'Usage',
    command: "Show today's usage (or the week's): tokens, cache hit, estimated cost, models, top sessions, tool calls, errors",
    usage: 'Usage: /report [today | week]',
    unreadable: 'Usage report: the transcripts could not be read.',
    opened: (tokens: string, days: number) => `Usage report opened (${tokens} tokens ${days === 1 ? 'today' : `in the last ${days} days`}).`,
    reading: 'Reading the transcripts…',
    none: 'No report yet.',
    today: 'today',
    updating: ' · updating…',
    sevenDays: '7 days',
    todayButton: 'Today',
    refresh: '↻ Refresh',
    tokens: 'Tokens',
    input: 'input',
    output: 'output',
    cacheRead: 'cache read',
    cacheWrite: 'cache write',
    cacheHit: 'cache hit',
    cost: 'estimated cost (API prices)',
    models: 'Models',
    responses: 'responses',
    empty: 'none',
    topSessions: 'Top sessions',
    effort: 'Effort',
    toolCalls: 'Tool calls',
    ok: 'ok',
    error: 'error',
    denied: 'denied',
    mostUsed: 'most used',
    mostFailed: 'most failed',
    failures: 'Failures',
    retries: 'retries after a failed call',
    apiErrors: 'API errors',
    interrupted: 'interrupted turns',
    sessions: 'Sessions',
    sessionsRow: 'sessions',
    subagents: 'subagents',
    skipped: (n: number) => `${n} transcript(s) could not be read.`,
    // Plain-text report.
    headToday: 'Usage today',
    headDays: (n: number) => `Usage, last ${n} days`,
    textCacheHit: (p: string) => `Cache hit: ${p} of input read from the cache`,
    textCost: 'Estimated cost at API prices',
    textRetries: 'Retries',
    textInterrupted: 'interrupted',
  },
  pt: {
    title: 'Uso',
    command: 'Mostra o uso de hoje (ou da semana): tokens, acerto de cache, custo estimado, modelos, sessões que mais gastaram, chamadas de ferramenta, erros',
    usage: 'Uso: /report [today | week]',
    unreadable: 'Relatório de uso: não deu para ler os transcripts.',
    opened: (tokens: string, days: number) => `Relatório de uso aberto (${tokens} tokens ${days === 1 ? 'hoje' : `nos últimos ${days} dias`}).`,
    reading: 'Lendo os transcripts…',
    none: 'Nenhum relatório ainda.',
    today: 'hoje',
    updating: ' · atualizando…',
    sevenDays: '7 dias',
    todayButton: 'Hoje',
    refresh: '↻ Atualizar',
    tokens: 'Tokens',
    input: 'entrada',
    output: 'saída',
    cacheRead: 'leitura de cache',
    cacheWrite: 'escrita de cache',
    cacheHit: 'acerto de cache',
    cost: 'custo estimado (preços da API)',
    models: 'Modelos',
    responses: 'respostas',
    empty: 'nenhum',
    topSessions: 'Sessões que mais gastaram',
    effort: 'Effort',
    toolCalls: 'Chamadas de ferramenta',
    ok: 'ok',
    error: 'erro',
    denied: 'negadas',
    mostUsed: 'mais usadas',
    mostFailed: 'mais falharam',
    failures: 'Falhas',
    retries: 'novas tentativas após falha',
    apiErrors: 'erros da API',
    interrupted: 'turnos interrompidos',
    sessions: 'Sessões',
    sessionsRow: 'sessões',
    subagents: 'subagentes',
    skipped: (n: number) => `${n} transcript(s) não puderam ser lidos.`,
    headToday: 'Uso hoje',
    headDays: (n: number) => `Uso, últimos ${n} dias`,
    textCacheHit: (p: string) => `Acerto de cache: ${p} da entrada lida do cache`,
    textCost: 'Custo estimado a preços da API',
    textRetries: 'Novas tentativas',
    textInterrupted: 'interrompidos',
  },
} as const
