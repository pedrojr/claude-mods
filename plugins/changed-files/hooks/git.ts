import type { FileChange, Groups, Status } from '../types'

// Past this many files the list stops; a tree with that many changes is not read by eye.
export const MAX_FILES = 500

/** Branch line of `git status -b`: "## main...origin/main [ahead 1, behind 2]". */
export function parseBranch(line: string): { branch: string | null; ahead: number; behind: number } {
  const text = line.replace(/^## /, '')
  const ahead = Number(/ahead (\d+)/.exec(text)?.[1] ?? 0)
  const behind = Number(/behind (\d+)/.exec(text)?.[1] ?? 0)
  // "No commits yet on main", "HEAD (no branch)", "main...origin/main [...]".
  const noCommits = /^No commits yet on (.+)$/.exec(text)
  if (noCommits) return { branch: noCommits[1] ?? null, ahead, behind }
  if (text.startsWith('HEAD (no branch)')) return { branch: 'detached', ahead, behind }
  const name = text.split(/\.\.\.| /)[0]
  return { branch: name || null, ahead, behind }
}

const CONFLICTS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

/** VS Code's letter for a porcelain code. */
function letter(code: string): Status {
  switch (code) {
    case 'M':
    case 'A':
    case 'D':
    case 'R':
    case 'C':
    case 'T':
      return code
    default:
      return 'M'
  }
}

/**
 * `git status --porcelain=v1 -b -z` split into VS Code's groups: merge
 * conflicts, staged changes and working-tree changes (untracked included).
 * A file staged and then edited again is in both Staged and Changes.
 */
export function parseStatus(stdout: string): Groups & { branch: string | null; ahead: number; behind: number; isTruncated: boolean } {
  const tokens = stdout.split('\0')
  const groups: Groups = { merge: [], staged: [], changes: [] }
  let head = { branch: null as string | null, ahead: 0, behind: 0 }
  let count = 0
  let isTruncated = false
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? ''
    if (!token) continue
    if (token.startsWith('## ')) {
      head = parseBranch(token)
      continue
    }
    const x = token[0] ?? ' '
    const y = token[1] ?? ' '
    const path = token.slice(3)
    // A rename or copy carries its old path as the next token.
    const origPath = x === 'R' || x === 'C' ? (tokens[++i] ?? null) : null
    if (count >= MAX_FILES) {
      isTruncated = true
      continue
    }
    count++
    const xy = x + y
    if (CONFLICTS.has(xy)) {
      groups.merge.push({ path, origPath: null, status: '!', staged: false, untracked: false })
      continue
    }
    if (xy === '??') {
      groups.changes.push({ path, origPath: null, status: 'U', staged: false, untracked: true })
      continue
    }
    if (xy === '!!') continue
    if (x !== ' ') groups.staged.push({ path, origPath, status: letter(x), staged: true, untracked: false })
    if (y !== ' ') groups.changes.push({ path, origPath: null, status: letter(y), staged: false, untracked: false })
  }
  const byPath = (a: FileChange, b: FileChange) => a.path.localeCompare(b.path)
  groups.merge.sort(byPath)
  groups.staged.sort(byPath)
  groups.changes.sort(byPath)
  return { ...groups, ...head, isTruncated }
}

/** "plugins/usage-bar/hooks/register.tsx" as its name and its folder. */
export function splitPath(path: string): { name: string; dir: string } {
  const clean = path.replace(/\/$/, '')
  const cut = clean.lastIndexOf('/')
  return cut < 0 ? { name: clean, dir: '' } : { name: clean.slice(cut + 1), dir: clean.slice(0, cut) }
}

/** The theme color VS Code gives each letter. */
export function statusColor(status: Status, untracked: boolean): string {
  if (untracked || status === 'A' || status === 'U') return 'success'
  if (status === 'D' || status === '!') return 'error'
  if (status === 'R' || status === 'C') return 'suggestion'
  return 'warning'
}

/** The row's identity: one file can sit in Staged and in Changes at once. */
export function changeKey(change: FileChange): string {
  return `${change.staged ? 'staged' : change.untracked ? 'untracked' : 'changes'}:${change.path}`
}
