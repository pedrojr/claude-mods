/** Mirrors the engine's AgentStatus; the contract cannot import it. */
export type AgentStatus = 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'

/** One agent as the pane draws it: what `$.agent.list()` said, plus timing. */
export type AgentRow = {
  id: string
  label: string
  type: string
  status: AgentStatus
  parentId: string | null
  /** `$.clock.now()` when the pane first saw it. */
  firstSeenAt: number
  /** `$.clock.now()` when it was first seen in a final status; null while it runs. */
  endedAt: number | null
}

/** One open Claude Code session on this machine, from `<config>/sessions/<pid>.json`. */
export type SessionRow = {
  sessionId: string
  pid: number
  /** The session's title (the desktop app's, or one derived from the folder). */
  name: string
  cwd: string
  /** `busy` while a turn runs, `idle` otherwise; other words pass through. */
  status: string
  /** Where it runs: `desktop`, `CLI`, `VS Code`, ... */
  entrypoint: string
  /** Epoch ms of its last status change. */
  since: number
  /** Its last tool call or reply, from its transcript; null when unknown. */
  activity: string | null
  /** True for the session this pane is drawn in. */
  isSelf: boolean
}

export type Snapshot = {
  agents: AgentRow[]
  /** Every open session on this machine, this one included. */
  sessions: SessionRow[]
  /** `$.clock.now()` at the last refresh; elapsed times are drawn against it. */
  now: number
}

export type PaneState = {
  /** True while the pane is drawn on a surface. */
  isOpen: boolean
  /** True once the person closed it; it then opens only when they ask. */
  closedByPerson: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'agents-panel': { snapshot: Shaped<Snapshot>; pane: PaneState }
  }
}
