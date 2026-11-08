export type Window = { percent: number; resetsAt: string | null }

export type Windows = { session: Window | null; week: Window | null }

/** When the last main-thread response came back, and the context it left. */
export type Cache = {
  lastResponseAt: number | null
  tokens: number | null
  /** `$.clock.now()` at the last check; flips the icon on once the TTL passes. */
  checkedAt: number
}

/** The language the labels are drawn in, detected from the person's prompts. */
export type Lang = 'en' | 'pt' | 'es'

declare module 'claude-code' {
  interface PluginState {
    'usage-bar': { windows: Windows; cache: Cache; lang: Lang }
  }
}
