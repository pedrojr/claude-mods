/** Token counts as the API reports them. */
export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

/** A name and how many times it showed up. */
export type Count = { name: string; count: number }

/** Today's usage across every session on this machine. */
export type Report = {
  /** Local midnight, epoch ms: the report covers from here to `now`. */
  dayStart: number
  /** Epoch ms of the last refresh. */
  now: number
  tokens: Tokens
  /** API responses per model, most used first, with the model's total tokens. */
  models: (Count & { tokens: number })[]
  /** API responses per effort level; `default` when the transcript has none. */
  efforts: Count[]
  tools: {
    total: number
    ok: number
    errors: number
    /** Refused by a permission rule, a hook or the person. */
    denied: number
    /** Most called tools. */
    top: Count[]
    /** Tools with the most errors and denials. */
    failing: Count[]
  }
  /** A failed tool call followed by another call to the same tool. */
  retries: number
  /** Responses the API answered with an error. */
  apiErrors: number
  /** Turns the person stopped. */
  interrupts: number
  /** Main sessions with activity today. */
  sessions: number
  /** Subagents with activity today, by type. */
  agents: { total: number; byType: Count[] }
  /** Transcripts that could not be read. */
  skipped: number
}

export type Snapshot = {
  /** Null until the first refresh ends. */
  report: Report | null
  /** True while a refresh runs. */
  loading: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'usage-report': { snapshot: Shaped<Snapshot> }
  }
}
