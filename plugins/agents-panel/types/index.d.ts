/** One agent or subagent as the pane draws it. */
export type AgentView = {
  /** The agent id: the suffix of `subagents/agent-<id>.jsonl`, and `$.agent.list()`'s id. */
  id: string
  label: string
  type: string
  /** True while it runs. */
  active: boolean
  /** Epoch ms of its transcript's last write. */
  lastAt: number
  /** Its last tool call, reply or prompt; null when unknown. */
  lastLine: string | null
  /** The agent that spawned it, when known (this session's agents only). */
  parentId: string | null
}

/** One Claude Code session on this machine, with its agents. */
export type SessionView = {
  sessionId: string
  /** The desktop app's id (`local_<uuid>`), which its deep link opens; null outside the app. */
  hostSessionId: string | null
  name: string
  cwd: string
  /** Where it runs: `desktop`, `CLI`, `VS Code`, ... */
  entrypoint: string
  /** True for the session this pane is drawn in. */
  isSelf: boolean
  /** True while a turn runs. */
  active: boolean
  lastAt: number
  lastLine: string | null
  agents: AgentView[]
}

export type Snapshot = {
  /** Sessions with something active or a prompt cache still warm, busiest first. */
  sessions: SessionView[]
  /** `$.clock.now()` at the last refresh. */
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
