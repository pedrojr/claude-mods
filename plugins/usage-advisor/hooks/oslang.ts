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
