import type { EngineInterface as Engine } from 'claude-code'

import type { ChangesSnapshot, DiffView, Selection } from '../types'
import { diffArgv, parseDiff } from './diff'
import { changeKey, parseStatus } from './git'

export const NO_CHANGES: ChangesSnapshot = {
  root: null,
  branch: null,
  ahead: 0,
  behind: 0,
  merge: [],
  staged: [],
  changes: [],
  isTruncated: false,
  error: null,
}

export const NO_DIFF: DiffView = {
  key: '',
  hunks: '',
  added: 0,
  removed: 0,
  isBinary: false,
  isTruncated: false,
  isCombined: false,
  error: null,
}

// The repository root, found once per working directory (a reload finds it again).
let rootOf: { cwd: string; root: string | null } | null = null

async function findRoot($: Engine): Promise<string | null> {
  const cwd = await $.session.cwd()
  if (rootOf?.cwd === cwd) return rootOf.root
  const result = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd })
  const root = result.exitCode === 0 ? result.stdout.trim().replace(/\\/g, '/') || null : null
  rootOf = { cwd, root }
  return root
}

/** `git status` of the session's repository, grouped as VS Code groups it. */
export async function readStatus($: Engine): Promise<ChangesSnapshot> {
  let root: string | null
  try {
    root = await findRoot($)
  } catch {
    return { ...NO_CHANGES, error: 'git did not run. Is it installed and on PATH?' }
  }
  if (!root) return { ...NO_CHANGES, error: 'Not a git repository.' }
  const result = await $.process.run(['git', 'status', '--porcelain=v1', '-b', '-z', '--untracked-files=all'], { cwd: root })
  if (result.exitCode !== 0) return { ...NO_CHANGES, root, error: result.stderr.trim().split('\n')[0] || 'git status failed.' }
  return { root, ...parseStatus(result.stdout), error: null }
}

/** The selected file's diff, from its repository root. */
export async function readDiff($: Engine, picked: NonNullable<Selection>): Promise<DiffView> {
  const view = { ...NO_DIFF, key: changeKey(picked) }
  try {
    const result = await $.process.run(diffArgv(picked), { cwd: picked.root })
    // `--no-index` exits 1 when the files differ, which they always do there.
    if (result.exitCode > 1 || (result.exitCode === 1 && !picked.untracked)) {
      return { ...view, error: result.stderr.trim().split('\n')[0] || `git diff exited ${result.exitCode}.` }
    }
    return { ...view, ...parseDiff(result.stdout) }
  } catch (error) {
    return { ...view, error: String(error) }
  }
}
