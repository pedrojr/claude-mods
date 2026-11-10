/** Token counts as the API reports them. */
export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

/** A name and how many times it showed up. */
export type Count = { name: string; count: number }

/** One session's share of the period, its subagents included. */
export type SessionUsage = {
  /** Its title, else its first prompt, else its folder and id. */
  name: string
  /** The model that used most of its tokens. */
  model: string
  tokens: number
  /** Estimated at API list prices. */
  costUsd: number
  responses: number
}

/** The period's usage across every session on this machine. */
export type Report = {
  /** Local midnight the period starts at, epoch ms: the report covers from here to `now`. */
  dayStart: number
  /** Epoch ms of the last refresh. */
  now: number
  /** 1 for today, 7 for the last seven days (today included). */
  days: number
  tokens: Tokens
  /**
   * Estimated cost at API list prices. On a subscription this is not what is
   * billed; it shows what the same use would cost on the API.
   */
  costUsd: number
  /** The sessions that used the most tokens, at most 5. */
  topSessions: SessionUsage[]
  /** API responses per model, most used first, with the model's total tokens and estimated cost. */
  models: (Count & { tokens: number; costUsd: number })[]
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
  /** The period the pane shows: 1 (today) or 7 days. */
  days: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-report': { snapshot: Shaped<Snapshot> }
  }
}
