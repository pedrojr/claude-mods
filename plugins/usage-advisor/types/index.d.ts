export type Lang = 'en' | 'pt'

/**
 * How a figure was obtained. `measured`: read as is (API usage in the
 * transcripts, the token-count API). `estimated`: an approximation (a local
 * token estimate, characters / 4). `unavailable`: nothing to read it from.
 */
export type Basis = 'measured' | 'estimated' | 'unavailable'

/** What the current session did that costs tokens, counted as it happens. */
export type Live = {
  /** Full reads of each file in the main conversation, and the estimated tokens of the last one. */
  reads: Record<string, { count: number; tokens: number }>
  /** Tool results over the large-output threshold, newest last. */
  bigOutputs: { tool: string; what: string; tokens: number }[]
  /** Prompts the person typed. */
  prompts: number
  /** The model of the last main-loop request, and how many times it changed with a warm context. */
  lastModel: string | null
  lastEffort: string | null
  modelSwitches: { from: string; to: string; contextTokens: number }[]
  /** When the last main-loop response came back, for the prompt-cache lifetime. */
  lastResponseAt: number | null
  /** Context re-written after the cache expired: one entry per return after a pause. */
  coldStarts: { idleMinutes: number; contextTokens: number }[]
  /** The live context window. */
  contextTokens: number | null
  contextWindow: number | null
  /** The preload share of the window, from the first breakdown of the session. */
  preloadTokens: number | null
}

/** One piece of advice the icon counts and the pane lists. */
export type Tip = {
  id: string
  /** Estimated tokens the habit or setting wastes; the pane shows the largest first. */
  tokens: number
  text: string
}

/** One item of the context the session starts with. */
export type PreloadItem = {
  kind: 'system' | 'tools' | 'mcp' | 'memory' | 'skills' | 'agents' | 'commands' | 'other'
  name: string
  tokens: number
  /** For a memory file, its path; for an MCP server, its tool count. */
  detail: string
}

/** One of the recent sessions of this project, from its transcript. */
export type SessionRow = {
  id: string
  name: string
  startedAt: number
  endedAt: number
  turns: number
  requests: number
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  /** Largest context a request of the session was answered over. */
  maxContext: number
  models: string[]
  efforts: string[]
  modelSwitches: number
  /** Files read more than once, with the estimated tokens of the reads past the first. */
  rereads: { path: string; count: number; tokens: number }[]
  /** Tool results over the large-output threshold. */
  bigOutputs: { tool: string; what: string; tokens: number }[]
  /** Responses that re-wrote a large cached context after a pause. */
  coldStarts: { idleMinutes: number; tokens: number }[]
  /** MCP servers whose tools the session called, by wire prefix. */
  mcpServers: string[]
}

/** A row of the diagnosis table. */
export type Problem = {
  id: string
  title: string
  /** Estimated tokens over the sessions read (or per session for preload items). */
  tokens: number
  tokensLabel: string
  frequency: string
  impact: 'high' | 'medium' | 'low'
  evidence: string
  basis: Basis
}

/** A proposed change of phase 2. Nothing is applied by the mod. */
export type Proposal = {
  id: string
  change: string
  why: string
  gain: string
  risk: string
  /** What "Ask Claude" sends: the change, with the instruction to confirm first. */
  prompt: string
}

/** The audit the pane shows. */
export type Audit = {
  at: number
  lang: Lang
  model: string | null
  effort: string | null
  /** What could change the model during a session without the person asking. */
  switchers: string[]
  contextWindow: number | null
  windowBasis: Basis
  preload: PreloadItem[]
  preloadTokens: number
  preloadBasis: Basis
  /** Findings of phase 1A: unused MCP servers, large memory files, duplicates, large descriptions. */
  flags: string[]
  sessions: SessionRow[]
  sessionsBasis: Basis
  /** Why the sessions could not be read, when they could not. */
  sessionsNote: string | null
  problems: Problem[]
  proposals: Proposal[]
  habits: string[]
}

/** What usage-bar draws at the end of its line, published by this mod. */
export type Icon = {
  /** Tips the session calls for. */
  count: number
  /** The person hid the icon with /advisor hide. */
  isHidden: boolean
}

export type Pane = {
  isOpen: boolean
  loading: boolean
  /** The proposal shown, one at a time. */
  proposal: number
  /** The section shown: the diagnosis (phase 1), the changes (phase 2) or the habits (phase 3). */
  tab: 'audit' | 'changes' | 'habits'
}

declare module 'claude-code' {
  interface PluginState {
    'usage-advisor': {
      live: Shaped<Live>
      audit: Shaped<Audit | null>
      pane: Shaped<Pane>
      icon: Icon
      lang: Lang
      isChatLang: boolean
      isHidden: boolean
    }
  }
}
