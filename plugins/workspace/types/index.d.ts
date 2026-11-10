// ---- Agents ----

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

export type AgentsSnapshot = {
  /** Sessions with something active or a prompt cache still warm, busiest first. */
  sessions: SessionView[]
  /** `$.clock.now()` at the last refresh. */
  now: number
}

// ---- Changes ----

/** VS Code's letter: Modified, Added, Deleted, Renamed, Copied, Type change, Untracked, `!` conflict. */
export type Status = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '!'

/** One changed file, as git status reports it, relative to the repository root with `/`. */
export type FileChange = {
  path: string
  /** The old path of a staged rename or copy; null otherwise. */
  origPath: string | null
  status: Status
  /** True in the Staged Changes group (the index against HEAD). */
  staged: boolean
  /** True for a file git does not track yet. */
  untracked: boolean
}

/** VS Code's groups: Merge Changes, Staged Changes, Changes. */
export type Groups = {
  merge: FileChange[]
  staged: FileChange[]
  changes: FileChange[]
}

export type ChangesSnapshot = Groups & {
  /** The repository root, absolute; null outside a repository. */
  root: string | null
  branch: string | null
  ahead: number
  behind: number
  /** True when the list stopped at its limit. */
  isTruncated: boolean
  /** Why the list is empty when git could not answer; null when it did. */
  error: string | null
}

/** The file whose diff the pane shows; null when none is selected. */
export type Selection = (FileChange & {
  /** The repository root the path is relative to. */
  root: string
}) | null

/** The selected file's diff, as the pane draws it. */
export type DiffView = {
  /** The row key of the file it was read for; empty when nothing is selected. */
  key: string
  /** Unified-diff hunks only, ready for `<Code format="diff">`. */
  hunks: string
  added: number
  removed: number
  isBinary: boolean
  isTruncated: boolean
  /** A merge conflict's combined diff, drawn as plain text. */
  isCombined: boolean
  /** Why there is no diff when git failed; null when it ran. */
  error: string | null
}

// ---- The pane ----

/** The pane's three sections. */
export type SectionId = 'agents' | 'changes' | 'diff'

export type PaneState = {
  /** True while the pane is drawn on a surface. */
  isOpen: boolean
  /** True once the person closed it; it then opens only when they ask. */
  closedByPerson: boolean
  /** The sections the person folded to their title line. */
  collapsed: SectionId[]
  /** True when the Agents section also lists idle sessions and agents (warm cache, nothing running). */
  showIdle: boolean
}

declare module 'claude-code' {
  interface PluginState {
    workspace: {
      agents: Shaped<AgentsSnapshot>
      changes: Shaped<ChangesSnapshot>
      selection: Shaped<Selection>
      diff: Shaped<DiffView>
      pane: Shaped<PaneState>
    }
  }
}
