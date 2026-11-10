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

export type Snapshot = Groups & {
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

/** The file whose diff the pane shows under the list; null when none is selected. */
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

export type PaneState = {
  /** True while the pane is drawn on a surface. */
  isOpen: boolean
  /** True once the person closed it; it then opens only when they ask. */
  closedByPerson: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'changed-files': {
      snapshot: Shaped<Snapshot>
      selection: Shaped<Selection>
      diff: Shaped<DiffView>
      pane: PaneState
    }
  }
}
