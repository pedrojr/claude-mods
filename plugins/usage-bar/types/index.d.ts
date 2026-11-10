export type Window = { percent: number; resetsAt: string | null }

/**
 * The account's rate-limit windows. `at` is when that reading was taken
 * (`$.clock.now()` ms, 0 before any): sessions share their newest reading.
 */
export type Windows = { session: Window | null; week: Window | null; at: number }

/** When the last main-thread response came back, and the context it left. */
export type Cache = {
  lastResponseAt: number | null
  tokens: number | null
  /** `$.clock.now()` at the last check; flips the icon on once the TTL passes. */
  checkedAt: number
}

/** This session's own figures: the context window's fill and what the session cost. */
export type Meter = { contextTokens: number | null; contextWindow: number | null; costUsd: number | null }

/** The language the labels are drawn in, detected from the person's prompts. */
export type Lang = 'en' | 'pt' | 'es'

declare module 'claude-code' {
  interface PluginState {
    'usage-bar': { windows: Windows; cache: Cache; lang: Lang; meter: Meter }
  }
}
