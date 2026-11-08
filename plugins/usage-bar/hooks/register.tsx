import { atom, read, update } from 'claude-code'
import type { Register, SessionRateLimit } from 'claude-code'

import type { Cache, Lang, Window, Windows } from '../types'

const windows = atom({ plugin: 'usage-bar', key: 'windows' } as const, {
  session: null,
  week: null,
} as Windows)

const cache = atom({ plugin: 'usage-bar', key: 'cache' } as const, {
  lastResponseAt: null,
  tokens: null,
  checkedAt: 0,
} as Cache)

const lang = atom({ plugin: 'usage-bar', key: 'lang' } as const, 'en' as Lang)

const BAR_WIDTH = 12
// Prompt cache lifetime. Claude Code uses a 1-hour TTL on subscriptions and
// 5 minutes on some API setups; the engine does not tell plugins which one.
const CACHE_TTL_MS = 60 * 60 * 1000
const CHECK_EVERY_MS = 60 * 1000
const STORE_PREFIX = 'cache:'
const STORE_LANG = 'lang'
const STORE_KEEP_MS = 30 * 24 * 60 * 60 * 1000

const LABELS: Record<Lang, { session: string; week: string }> = {
  en: { session: 'Session', week: 'Week' },
  pt: { session: 'Sessão', week: 'Semana' },
  es: { session: 'Sesión', week: 'Semana' },
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

function pick(rateLimits: readonly SessionRateLimit[]): Windows {
  const find = (kind: string): Window | null => {
    const limit = rateLimits.find(r => r.kind === kind)
    return limit ? { percent: limit.percentUsed, resetsAt: limit.resetsAt ?? null } : null
  }
  return { session: find('five_hour'), week: find('seven_day') }
}

function bar(percent: number): { full: string; empty: string } {
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((percent / 100) * BAR_WIDTH)))
  return { full: '█'.repeat(filled), empty: '█'.repeat(BAR_WIDTH - filled) }
}

function tone(percent: number): 'success' | 'warning' | 'error' {
  if (percent >= 80) return 'error'
  if (percent >= 50) return 'warning'
  return 'success'
}

const pad = (n: number) => String(n).padStart(2, '0')

// Reset time only. Session: "16:00". Week: "09/11 15:00" (day/month; month/day in English).
function resetLabel(iso: string | null, withDate: boolean, l: Lang): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (!withDate) return time
  const date = l === 'en' ? `${pad(d.getMonth() + 1)}/${pad(d.getDate())}` : `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`
  return `${date} ${time}`
}

// "61k", "1.2M", "850".
function tokenLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
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
    await update($, windows, () => pick(usage.rateLimits))
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

    // Recheck once a minute: counts the warm cache down, then flips to the
    // expired icon. Once expired nothing changes on screen, so no redraw.
    $.clock.every(CHECK_EVERY_MS, () => {
      void (async () => {
        const at = await $.clock.now()
        const c = await read($, cache)
        if (c.lastResponseAt !== null && !isExpired(c)) {
          await update($, cache, v => ({ ...v, checkedAt: at }))
        }
      })()
    })

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
    const detected = detectLang(e.text)
    if (detected && detected !== (await read($, lang))) {
      await update($, lang, () => detected)
      await $.store.set(STORE_LANG, detected)
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, windows, () => pick(e.rateLimits))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const [usage, id, now] = await Promise.all([$.session.usage(), $.session.id(), $.clock.now()])
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
    const [value, c, l] = await Promise.all([read($, windows), read($, cache), read($, lang)])
    const expired = isExpired(c)
    const hasCache = c.lastResponseAt !== null
    if (e.props.hasSurvey || (value.session === null && value.week === null && !hasCache)) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const labels = LABELS[l]

    const item = (key: string, label: string, w: Window | null, withDate: boolean) => {
      if (w === null) {
        return (
          <Text key={key} dimColor>
            {label} --
          </Text>
        )
      }
      const { full, empty } = bar(w.percent)
      const reset = resetLabel(w.resetsAt, withDate, l)
      return (
        <Text key={key}>
          <Text bold>{label}</Text>
          <Text> </Text>
          <Text color={tone(w.percent)}>{full}</Text>
          <Text color="subtle">{empty}</Text>
          <Text> </Text>
          <Text bold color={tone(w.percent)}>
            {String(Math.round(w.percent)).padStart(3, ' ')}%
          </Text>
          {reset ? <Text dimColor> [{reset}]</Text> : null}
        </Text>
      )
    }

    // Same on every surface, after the week, one or the other, never both:
    //   warm:    " │ ◷ 46m"  (time the prompt cache has left; yellow in its last 5 minutes)
    //   expired: " │ ◷ ~61k" (tokens the next message re-caches)
    const left = minutesLeft(c)
    const cacheBody = expired ? (
      <Text key="cache" color="warning">
        ◷{c.tokens !== null ? <Text dimColor> ~{tokenLabel(c.tokens)}</Text> : null}
      </Text>
    ) : left !== null ? (
      <Text key="cache" color={left <= WARN_MINUTES ? 'warning' : undefined} dimColor={left > WARN_MINUTES}>
        ◷ {left}m
      </Text>
    ) : null
    const cacheItem = cacheBody
      ? [
          <Text key="sep2" dimColor>
            │
          </Text>,
          cacheBody,
        ]
      : null

    return (
      <Box flexDirection="row" gap={2}>
        {item('session', labels.session, value.session, false)}
        <Text key="sep" dimColor>
          │
        </Text>
        {item('week', labels.week, value.week, true)}
        {cacheItem}
      </Box>
    )
  })
}
