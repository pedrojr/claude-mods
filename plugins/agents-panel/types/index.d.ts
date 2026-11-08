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

export type Snapshot = {
  agents: AgentRow[]
  /** `$.clock.now()` at the last refresh; elapsed times are drawn against it. */
  now: number
}

declare module 'claude-code' {
  interface PluginState {
    'agents-panel': { snapshot: Shaped<Snapshot> }
  }
}
