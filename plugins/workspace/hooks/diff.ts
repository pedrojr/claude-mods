import type { FileChange } from '../types'

// The Code element draws at most 100000 characters; keep room for its own work.
export const MAX_CHARS = 90_000

/** The git command that prints a file's diff, run from the repository root. */
export function diffArgv(change: FileChange): string[] {
  const base = ['git', '-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff']
  // An untracked file: everything in it is new.
  if (change.untracked) return [...base, '--no-index', '--', '/dev/null', change.path]
  if (change.staged) {
    const paths = change.origPath ? [change.origPath, change.path] : [change.path]
    return [...base, '--cached', '-M', '--', ...paths]
  }
  return [...base, '--', change.path]
}

export type Parsed = {
  /** Only the hunks, from the first `@@` line, cut at a hunk boundary past MAX_CHARS. */
  hunks: string
  added: number
  removed: number
  isBinary: boolean
  isTruncated: boolean
  /** True for a merge conflict's combined diff (`@@@`), which is drawn as plain text. */
  isCombined: boolean
}

/** A hunk's header rewritten to count only the lines kept after it: `@@ -1,900 +1,900 @@` → `@@ -1,40 +1,40 @@`. */
function recount(hunk: readonly string[]): string {
  const body = hunk.slice(1)
  const old = body.filter(line => line.startsWith(' ') || line.startsWith('-')).length
  const now = body.filter(line => line.startsWith(' ') || line.startsWith('+')).length
  return hunk[0]!.replace(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/, (_, a: string, b: string) => `@@ -${a},${old} +${b},${now} @@`)
}

/** Reads git's diff output: drops the file header, counts lines, clips long diffs. */
export function parseDiff(stdout: string): Parsed {
  const lines = stdout.replace(/\r\n/g, '\n').split('\n')
  const isBinary = lines.some(line => /^Binary files .* differ$/.test(line))
  const first = lines.findIndex(line => line.startsWith('@@'))
  if (first < 0) return { hunks: '', added: 0, removed: 0, isBinary, isTruncated: false, isCombined: false }
  const isCombined = lines[first]!.startsWith('@@@')
  const kept: string[] = []
  let size = 0
  let isTruncated = false
  // Where the hunk being read starts in `kept`.
  let hunkAt = 0
  for (let i = first; i < lines.length; i++) {
    const line = lines[i]!
    // A second file's header: stop there.
    if (line.startsWith('diff --git ')) break
    if (line.startsWith('@@') && size + line.length > MAX_CHARS) {
      isTruncated = true
      break
    }
    if (size + line.length + 1 > MAX_CHARS) {
      isTruncated = true
      if (hunkAt > 0) {
        // A hunk cut in the middle does not parse: drop it whole.
        kept.length = hunkAt
      } else if (!isCombined) {
        // The first hunk alone is too long (a large new file): keep its start, its header counting what is kept.
        kept[0] = recount(kept)
      }
      break
    }
    if (line.startsWith('@@')) hunkAt = kept.length
    kept.push(line)
    size += line.length + 1
  }
  while (kept.length && kept[kept.length - 1] === '') kept.pop()
  // Counted from what is kept, so a hunk dropped above adds nothing.
  let added = 0
  let removed = 0
  if (!isCombined) {
    for (const line of kept) {
      if (line.startsWith('@@')) continue
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  }
  // Tabs and newlines are the only control characters the element takes.
  const hunks = kept.join('\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
  return { hunks, added, removed, isBinary, isTruncated, isCombined }
}
