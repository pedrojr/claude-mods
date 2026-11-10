import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register, SessionRateLimit } from 'claude-code'

import type { Cache, Lang, Meter, Window, Windows } from '../types'

// Change the tag when Windows' fields change: it drops what an earlier version stored.
const windows = atom(
  { plugin: 'usage-bar', key: 'windows' } as const,
  { session: null, week: null, at: 0 } as Windows,
  { shape: 'windows-2' },
)

const cache = atom({ plugin: 'usage-bar', key: 'cache' } as const, {
  lastResponseAt: null,
  tokens: null,
  checkedAt: 0,
} as Cache)

const lang = atom({ plugin: 'usage-bar', key: 'lang' } as const, 'en' as Lang)

const meter = atom({ plugin: 'usage-bar', key: 'meter' } as const, {
  contextTokens: null,
  contextWindow: null,
  costUsd: null,
} as Meter)

function meterOf(usage: { context: { tokens?: number; window?: number }; cost?: { usd: number } }): Meter {
  return {
    contextTokens: usage.context.tokens ?? null,
    contextWindow: usage.context.window ?? null,
    costUsd: usage.cost?.usd ?? null,
  }
}

async function remeter($: Engine, usage: Parameters<typeof meterOf>[0]): Promise<void> {
  const next = meterOf(usage)
  const prev = await read($, meter)
  if (JSON.stringify(prev) !== JSON.stringify(next)) await update($, meter, () => next)
}

// Prompt cache lifetime. Claude Code uses a 1-hour TTL on subscriptions and
// 5 minutes on some API setups; the engine does not tell plugins which one.
const CACHE_TTL_MS = 60 * 60 * 1000
const CHECK_EVERY_MS = 60 * 1000
const STORE_PREFIX = 'cache:'
const STORE_LANG = 'lang'
const STORE_KEEP_MS = 30 * 24 * 60 * 60 * 1000
// Every session on the machine writes its newest rate-limit reading here, so an
// idle session's bar follows what the others spend.
const SHARED_FILE = 'plugins/data/usage-bar/limits.json'

// The once-a-minute timer. A reload or a lost hooks worker drops it with the
// module; every hook below starts it again when it is gone.
let ticker: { cancel: () => void } | null = null
let sharedPath: string | null | undefined

const LABELS: Record<Lang, { session: string; week: string; context: string }> = {
  en: { session: 'Session', week: 'Week', context: 'Context' },
  pt: { session: 'Sessão', week: 'Semana', context: 'Contexto' },
  es: { session: 'Sesión', week: 'Semana', context: 'Contexto' },
}

// Common short words of each language; the one with most hits wins.
const WORDS: Record<Lang, readonly string[]> = {
  en: ['the', 'and', 'is', 'are', 'what', 'how', 'this', 'that', 'with', 'for', 'you', 'please', 'add', 'make', 'should', 'it'],
  pt: ['não', 'que', 'uma', 'para', 'com', 'está', 'isso', 'esse', 'essa', 'você', 'também', 'como', 'fazer', 'mais', 'pode', 'deve', 'ao', 'são'],
  es: ['que', 'una', 'para', 'con', 'está', 'esto', 'ese', 'esa', 'usted', 'también', 'como', 'hacer', 'más', 'puede', 'debe', 'los', 'las', 'del', 'por favor', 'qué'],
}

function detectLang(text: string): Lang | null {
  const tokens = text.toLowerCase().match(/[a-zà-ÿ]+/g) ?? []
  if (tokens.length < 3) return null
  const set = new Set(tokens)
  const score = (l: Lang) => WORDS[l].filter(w => set.has(w)).length
  // Letters only one language uses tip the balance.
  const pt = score('pt') + (/[ãõç]/.test(text) ? 2 : 0)
  const es = score('es') + (/[ñ¿¡]/.test(text) ? 2 : 0)
  const en = score('en')
  const best = Math.max(pt, es, en)
  if (best < 2) return null
  return best === pt ? 'pt' : best === es ? 'es' : 'en'
}

function pick(rateLimits: readonly SessionRateLimit[], at: number): Windows {
  const find = (kind: string): Window | null => {
    const limit = rateLimits.find(r => r.kind === kind)
    return limit ? { percent: limit.percentUsed, resetsAt: limit.resetsAt ?? null } : null
  }
  return { session: find('five_hour'), week: find('seven_day'), at }
}

/** A window whose reset time has passed starts over at 0%, before any new reading says so. */
function current(w: Window | null, now: number): Window | null {
  if (w === null || w.resetsAt === null) return w
  const resets = Date.parse(w.resetsAt)
  return Number.isFinite(resets) && now >= resets ? { percent: 0, resetsAt: null } : w
}

function parseShared(text: string): Windows | null {
  try {
    const v = JSON.parse(text) as Partial<Windows>
    if (typeof v.at !== 'number') return null
    const ok = (w: unknown): w is Window | null =>
      w === null || (typeof w === 'object' && typeof (w as Window).percent === 'number')
    if (!ok(v.session ?? null) || !ok(v.week ?? null)) return null
    return { session: v.session ?? null, week: v.week ?? null, at: v.at }
  } catch {
    return null
  }
}

async function sharedFile($: Engine): Promise<string | null> {
  if (sharedPath !== undefined) return sharedPath
  const [explicit, home, profile] = await Promise.all([
    $.env.get('CLAUDE_CONFIG_DIR'),
    $.env.get('HOME'),
    $.env.get('USERPROFILE'),
  ])
  const base = home ?? profile
  const dir = explicit ?? (base ? `${base.replace(/[\\/]+$/, '')}/.claude` : null)
  sharedPath = dir ? `${dir.replace(/[\\/]+$/, '')}/${SHARED_FILE}` : null
  return sharedPath
}

async function readShared($: Engine): Promise<Windows | null> {
  const path = await sharedFile($)
  if (!path) return null
  return $.fs.read(path).then(parseShared, () => null)
}

/**
 * Keeps the newest of this session's reading and the shared one: takes the
 * shared one when another session measured later, writes ours when it is newer.
 */
async function sync($: Engine, mine: Windows | null): Promise<void> {
  const shared = await readShared($)
  const local = mine ?? (await read($, windows))
  if (shared && shared.at > local.at) {
    await update($, windows, () => shared)
    return
  }
  if (local.at > 0 && (local.session || local.week) && (!shared || local.at > shared.at)) {
    const path = await sharedFile($)
    if (path) await $.fs.write(path, JSON.stringify(local)).catch(() => {})
  }
}

/** A reading this session's own API response just reported. */
async function measured($: Engine, rateLimits: readonly SessionRateLimit[]): Promise<void> {
  if (rateLimits.length === 0) return
  const value = pick(rateLimits, await $.clock.now())
  await update($, windows, () => value)
  await sync($, value)
}

/** Once a minute: counts the cache down and picks up what other sessions measured. */
async function tick($: Engine): Promise<void> {
  const at = await $.clock.now()
  await update($, cache, v => ({ ...v, checkedAt: at }))
  await sync($, null)
}

function arm($: Engine): void {
  if (ticker) return
  ticker = $.clock.every(CHECK_EVERY_MS, () => {
    tick($).catch(() => {})
  })
}

// A one-character progress ring, filled by quarters: ○ ◔ ◑ ◕ ●.
const RINGS = ['○', '◔', '◑', '◕', '●'] as const
function ring(percent: number): string {
  const p = Math.max(0, Math.min(100, percent))
  return RINGS[p >= 100 ? 4 : p <= 0 ? 0 : Math.min(3, Math.max(1, Math.round(p / 25)))]
}

function tone(percent: number): 'success' | 'warning' | 'error' {
  if (percent >= 80) return 'error'
  if (percent >= 50) return 'warning'
  return 'success'
}

const pad = (n: number) => String(n).padStart(2, '0')

// Time left until the reset: "8min", "13h 48min", "2d 05h"; null when unknown or passed.
function resetLabel(iso: string | null, now: number): string | null {
  if (!iso) return null
  const at = Date.parse(iso)
  if (!Number.isFinite(at) || at <= now) return null
  const minutes = Math.ceil((at - now) / 60000)
  if (minutes < 60) return `${minutes}min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${pad(minutes % 60)}min`
  return `${Math.floor(hours / 24)}d ${pad(hours % 24)}h`
}

// "$2.96" in English, "US$ 2.96" otherwise.
function costLabel(usd: number, l: Lang): string {
  const value = usd >= 100 ? usd.toFixed(0) : usd.toFixed(2)
  return l === 'en' ? `$${value}` : `US$ ${value}`
}

// "61k", "1.2M", "1M", "850".
function tokenLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`
  return String(tokens)
}

function isExpired(c: Cache): boolean {
  return c.lastResponseAt !== null && c.checkedAt - c.lastResponseAt > CACHE_TTL_MS
}

// Whole minutes the cache has left, rounded up; null when unknown or expired.
function minutesLeft(c: Cache): number | null {
  if (c.lastResponseAt === null) return null
  const left = CACHE_TTL_MS - (c.checkedAt - c.lastResponseAt)
  return left > 0 ? Math.ceil(left / 60000) : null
}

const WARN_MINUTES = 5

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const [usage, id, now, savedLang] = await Promise.all([
      $.session.usage(),
      $.session.id(),
      $.clock.now(),
      $.store.get(STORE_LANG),
    ])
    await remeter($, usage)
    // A reading of unknown age: any session's shared reading replaces it.
    await update($, windows, w => (w.at > 0 ? w : pick(usage.rateLimits, 0)))
    if (savedLang === 'en' || savedLang === 'pt' || savedLang === 'es') {
      await update($, lang, () => savedLang)
    }

    // Restore the last response time kept for this session (survives restarts and reloads).
    const saved = (await $.store.get(STORE_PREFIX + id)) as Partial<Cache> | undefined
    await update($, cache, c => ({
      lastResponseAt: c.lastResponseAt ?? saved?.lastResponseAt ?? null,
      tokens: c.tokens ?? saved?.tokens ?? usage.context.tokens ?? null,
      checkedAt: now,
    }))

    // Drop entries of sessions idle for more than 30 days.
    for (const key of await $.store.keys()) {
      if (!key.startsWith(STORE_PREFIX)) continue
      const entry = (await $.store.get(key)) as Partial<Cache> | undefined
      if (!entry?.lastResponseAt || now - entry.lastResponseAt > STORE_KEEP_MS) {
        await $.store.delete(key)
      }
    }

    // Recheck once a minute: counts the warm cache down, flips to the expired
    // icon, and follows the rate limits other sessions measured.
    ticker?.cancel()
    ticker = null
    arm($)
    await sync($, null).catch(() => {})

    return next(e)
  })

  // On resume or fork the engine itself says how long the transcript was idle
  // and how many tokens the first request will re-cache: the same figures as
  // its own "prompt cache likely expired" notice.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.seconds_since_last_response !== undefined) {
      const [now, id] = await Promise.all([$.clock.now(), $.session.id()])
      const value: Cache = {
        lastResponseAt: now - e.seconds_since_last_response * 1000,
        tokens: e.context_tokens ?? null,
        checkedAt: now,
      }
      await update($, cache, () => value)
      await $.store.set(STORE_PREFIX + id, { lastResponseAt: value.lastResponseAt, tokens: value.tokens })
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    arm($)
    const detected = detectLang(e.text)
    if (detected && detected !== (await read($, lang))) {
      await update($, lang, () => detected)
      await $.store.set(STORE_LANG, detected)
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    arm($)
    await measured($, e.rateLimits).catch(() => {})
    await remeter($, e)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    arm($)
    const usage = await $.session.usage()
    // Any response, a subagent's too, is a fresh rate-limit reading.
    await measured($, usage.rateLimits).catch(() => {})
    await remeter($, usage)
    // A subagent's turn warms its own cache, not the main conversation's.
    if (e.agentId !== undefined) return next(e)
    const [id, now] = await Promise.all([$.session.id(), $.clock.now()])
    const value: Cache = {
      lastResponseAt: now,
      tokens: usage.context.tokens ?? null,
      checkedAt: now,
    }
    await update($, cache, () => value)
    await $.store.set(STORE_PREFIX + id, { lastResponseAt: value.lastResponseAt, tokens: value.tokens })
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [stored, c, l, m] = await Promise.all([read($, windows), read($, cache), read($, lang), read($, meter)])
    const value = { session: current(stored.session, c.checkedAt), week: current(stored.week, c.checkedAt) }
    const expired = isExpired(c)
    const hasCache = c.lastResponseAt !== null
    if (e.props.hasSurvey || (value.session === null && value.week === null && !hasCache)) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const labels = LABELS[l]
    // "(8min)" after the percent; `extra` (the session cost) follows the reset time.
    const tailOf = (w: Window, extra: string | null = null) => {
      const reset = resetLabel(w.resetsAt, c.checkedAt)
      return [reset ? `(${reset})` : null, extra].filter(Boolean).join(' ') || null
    }
    //   "US$ 2.96", drawn in the session item after its reset time.
    const cost = m.costUsd !== null && m.costUsd > 0 ? costLabel(m.costUsd, l) : null
    const sessionTail = value.session ? tailOf(value.session, cost) : null
    const weekTail = value.week ? tailOf(value.week) : null
    //   "Context ◔ 23% (225k/1M)"
    const context =
      m.contextTokens !== null && m.contextWindow
        ? {
            percent: (m.contextTokens / m.contextWindow) * 100,
            tail: `(${tokenLabel(m.contextTokens)}/${tokenLabel(m.contextWindow)})`,
          }
        : null

    // Same on every surface, after the week, one or the other, never both:
    //   warm:    " │ ◷ 46m"  (time the prompt cache has left; yellow in its last 5 minutes)
    //   expired: " │ ◷ ~61k" (tokens the next message re-caches)
    const left = minutesLeft(c)

    //   "Sessão ◕ 72% (23min)": the ring and the percent in the window's tone.
    const meterText = (key: string, label: string, percent: number, tail: string | null) => (
      <Text key={key}>
        <Text bold>{label}</Text>
        <Text color={tone(percent)}> {ring(percent)} </Text>
        <Text bold color={tone(percent)}>
          {Math.round(percent)}%
        </Text>
        {tail ? <Text dimColor> {tail}</Text> : null}
      </Text>
    )

    const item = (key: string, label: string, w: Window | null, tail: string | null, extra: string | null) => {
      if (w === null) {
        return (
          <Text key={key} dimColor>
            {label} --{extra ? ` ${extra}` : ''}
          </Text>
        )
      }
      return meterText(key, label, w.percent, tail)
    }

    const sep = (key: string) => (
      <Text key={key} dimColor>
        │
      </Text>
    )

    const contextItem = context
      ? [sep('sep-ctx'), meterText('context', labels.context, context.percent, context.tail)]
      : null

    const cacheBody = expired ? (
      <Text key="cache" color="warning">
        ◷{c.tokens !== null ? <Text dimColor> ~{tokenLabel(c.tokens)}</Text> : null}
      </Text>
    ) : left !== null ? (
      <Text key="cache" color={left <= WARN_MINUTES ? 'warning' : undefined} dimColor={left > WARN_MINUTES}>
        ◷ {left}m
      </Text>
    ) : null
    const cacheItem = cacheBody ? [sep('sep2'), cacheBody] : null

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {item('session', labels.session, value.session, sessionTail, cost)}
        {sep('sep')}
        {item('week', labels.week, value.week, weekTail, null)}
        {contextItem}
        {cacheItem}
      </Box>
    )
  })
}
