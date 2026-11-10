# changed-files

A side pane that lists the files changed in the session's git repository, the way the Source Control view in VS Code lists them, with the diff of the file you click shown below the list.

```
⎇ main ↑7 · 5 files                    ↻

Staged Changes 2
 R old.ts → new.ts hooks
 M README.md

Changes 3
 D gone.txt
 U todo.md notes
 M ▶ git.ts hooks
────────────────────────────────────────
git.ts hooks                           ✕
Working tree · +2 −1

 1   const a = 1
 2 - const b = 2
 2 + const b = 3
 3 + const c = 4
```

## The list

- Files are grouped into Merge Changes (conflicts), Staged Changes (the index against HEAD) and Changes (the working tree, untracked files included). A file staged and then edited again shows in both groups.
- The letter before each file is its status: `M` modified, `A` added, `D` deleted, `R` renamed, `C` copied, `T` type changed, `U` untracked, `!` conflict. The colors follow VS Code.
- The top line shows the branch and how many commits it is ahead (`↑`) or behind (`↓`) its upstream. `↻` (or `r` while the pane has the keyboard) refreshes it.

## The diff

- Clicking a file shows its diff under the list, drawn with Claude Code's own diff view: line numbers, removed and added lines in red and green, and syntax colors for the file's language. Clicking the same file again, or `✕` (`x`), hides it.
- The line under the file name says which side the diff is: `Staged` (the index against HEAD), `Working tree` (the file against the index) or `Untracked` (the whole file is new), with the count of added and removed lines. A staged rename says what the file was called before.
- Binary files show a note instead of a diff. A merge conflict shows git's combined diff as plain text.
- Diffs over about 90,000 characters are cut at a hunk boundary, with a note at the end.

## When it updates

The list and the shown diff are read again when the session starts, after every Edit, Write or Bash call, at the end of every turn and every 3 seconds while the pane is open. Nothing polls while the pane is closed.

## Opening it

In the desktop app the pane opens by itself 1.5 seconds after the session starts, so that it lands below the agents pane. Claude Code gives mods no way to order panes, so the order comes from which pane opens first. In a terminal, run `/changes`. Once you close the pane it stays closed until you run `/changes` again.

## Settings

None. `POLL_MS`, `OPEN_DELAY_MS` and `MAX_FILES` (500) are at the top of `hooks/register.tsx` and `hooks/git.ts`.
