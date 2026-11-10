# workspace

One side pane for the session's work, in three sections stacked top to bottom:

1. **Agents**: the sessions and agents running on the machine.
2. **Changes**: the files changed in the session's git repository.
3. **Diff**: the diff of the file you click in Changes.

```
╭─────────────────────────────────────────╮
│ ▾ AGENTS 2 running            +3 idle   │
│ ● Commit and agents mod  this session   │
│   ↳ Edit: register.tsx                  │
│   ● Review auth module  Explore · 12s   │
│     ↳ Grep: verifyToken                 │
╰─────────────────────────────────────────╯
╭─────────────────────────────────────────╮
│ ▾ CHANGES ⎇ main ↑2 · 4 files        ↻  │
│ Staged · 1                              │
│ M README.md                             │
│                                         │
│ Not staged · 3                          │
│ D gone.txt                              │
│ U todo.md notes                         │
│ M git.ts hooks ◂                        │
╰─────────────────────────────────────────╯
╭─────────────────────────────────────────╮
│ ▾ DIFF git.ts                        ✕  │
│ hooks/git.ts                            │
│ not staged · +2 −1                      │
│                                         │
│  1   const a = 1                        │
│  2 - const b = 2                        │
│  2 + const b = 3                        │
│  3 + const c = 4                        │
╰─────────────────────────────────────────╯
```

Each section has a thin frame in its own light color (orange for Agents, blue for Changes, purple for Diff), and its title is in the same color. Click a title to fold the section down to that one line, and click it again to unfold it.

## Agents

- Sessions from every surface on the machine (desktop app, terminal, VS Code), with their agents and subagents nested under them. They come from the registry Claude Code keeps in `~/.claude/sessions/`.
- The pane lists this session, plus every session and agent that is running. Idle ones (finished, prompt cache still warm) are hidden behind `+N idle` on the title line; click it to list them, and `hide idle` to hide them again. Items whose prompt cache has expired (1 hour after their last write) are not listed at all.
- The dot is green while the item runs and gray otherwise. Next to the title is where it runs (or the agent type) and how long ago it last wrote.
- Under a running item, `↳` shows what it is doing: its latest tool call (`Bash: Run tests`), the first line of its last reply, or its last prompt.

Clicking a title:

- **This session** goes back to its main conversation.
- **An agent of this session** puts its transcript in the main view. `← Main` (or `m`) on the title line goes back.
- **A session in the desktop app** brings it to the front through the app's link `claude://code/continue?session=local_<id>`.
- **A session in VS Code** focuses the VS Code window of its folder (`code <folder>`), then opens the session through `vscode://anthropic.claude-code/open?session=<id>`. If `code` is not on the PATH, a toast says where the session runs.
- **A session in the terminal** cannot be brought to the front by a mod, so a toast says where it runs.
- **An agent of another session** opens the session it belongs to.

## Changes

- Files are grouped as VS Code groups them: Conflicts, Staged (the index against HEAD) and Not staged (the working tree, untracked files included). A file staged and then edited again is in both groups.
- The letter before each file is its status: `M` modified, `A` added, `D` deleted, `R` renamed, `C` copied, `T` type changed, `U` untracked, `!` conflict. The colors follow VS Code.
- The title line shows the branch, how many commits it is ahead (`↑`) or behind (`↓`) its upstream, and the file count. `↻` (or `r`) reads git again.
- Clicking a file shows its diff in the Diff section and marks it with `◂`. Clicking it again hides the diff.

## Diff

- Drawn with Claude Code's own diff view: line numbers, removed and added lines in red and green, and syntax colors for the file's language.
- Above the diff are the file's folder and name, then which side it is (`staged`, `not staged` or `new file`) with the count of added and removed lines. A staged rename says what the file was called before.
- `✕` (or `x`) closes the diff. Binary files show a note instead of a diff, and a merge conflict shows git's combined diff as plain text. Diffs over about 90,000 characters are cut at a hunk boundary, with a note at the end.

## When it updates

Every 3 seconds the pane reads the session registry again, plus the transcripts that changed. While the pane is open it also reads `git status` and the shown diff again. Git is also read after every Edit, Write or Bash call and at the end of every turn.

## Opening it

- **Desktop app (and other app surfaces):** the pane opens by itself when the session starts and whenever an agent is spawned.
- **Terminal:** the pane opens only when you ask. With the transcript in fullscreen mode it docks on the right; otherwise it sits above the prompt.
- **`/workspace`** opens it on any surface. It also runs mid-turn, while agents are working.
- **`● 1 other session active · 2 agents running [Workspace]`**: while the pane is closed and something else runs, this one-line chip sits above the prompt, and its button opens the pane.

Once you close the pane, it stops opening by itself for the rest of that session. The chip and `/workspace` still bring it back.

## Cost

No model tokens: the mod runs outside the conversation. The only footprint in the conversation is the `/workspace` entry in the command list.

## Settings

None. The constants are at the top of the files: `POLL_MS` and `DOCK_COLUMNS` in `hooks/register.tsx`, `CACHE_TTL_MS` in `hooks/agents.ts` (set it to 5 minutes if your prompt cache lives 5 minutes), and `MAX_FILES` (500) in `hooks/git.ts`.

## Limits

The session registry and transcript layout under `~/.claude` are Claude Code internals, not a public format. A future version may change them and empty the Agents list until the mod is updated.

## Privacy

The mod reads local files under your Claude Code config folder (`CLAUDE_CONFIG_DIR`, or `~/.claude`) and runs `git` in the session's repository. Nothing leaves the machine. Opening a desktop session runs the OS's URL opener (`rundll32 url.dll,FileProtocolHandler` on Windows, `open` on macOS, `xdg-open` on Linux) with the app's `claude://` link. Opening a VS Code session runs the `code` command.
