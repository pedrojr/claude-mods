# agents-panel

A side pane for Claude Code that shows, in one place, what is running on your machine: the sessions, agents and subagents that are active or still have a warm prompt cache, each with a one-line note on what it did last.

```
2 active · 3 sessions
● Commit and agents mod  this session · 0s
  ↳ Edit: register.tsx
  ● Review auth module  Explore · 12s
    ↳ Grep: verifyToken
● Refactor billing  desktop · 4s
  ↳ Bash: Run tests
● Summarize notes  VS Code · 21m
  ↳ Wrote the summary to notes.md.
```

## What shows

- **Sessions** from every surface on the machine: desktop app, terminal, VS Code. They come from the registry Claude Code keeps in `~/.claude/sessions/`.
- **Agents and subagents** of every session, nested under it. This session's are nested by the agent that spawned them.
- Only what is **active**, or whose **prompt cache has not expired** (1 hour after its last write). Cold, idle items drop off the list.
- **The dot** is green while the item runs and light gray otherwise.
- **The line under each item** (`↳`) is always shown: its latest tool call (`Bash: Run tests`, `Edit: register.tsx`), or the first line of its last reply, or its last prompt. It comes from the item's transcript and is re-read only when that file changes.
- Next to each title: where it runs (or the agent type) and how long ago it last wrote.

## Clicking a title

- **A session in the desktop app** brings that session to the front, through the app's own link `claude://code/continue?session=local_<id>`. If the app's entry points are switched off, nothing happens.
- **This session** goes back to its main conversation.
- **An agent of this session** puts its transcript in the main view. `← Main` (or `m`) goes back.
- **An agent of another session** opens the session it belongs to.
- **A session in the terminal or VS Code** cannot be brought to the front by a plugin; a toast says where it runs.

## Where it shows

The mod shows only in sessions that load it, so install it first (below). Plugins cannot add an icon or a menu item to the app, so the mod gives three ways in:

- **Desktop app (and other app surfaces):** the pane opens by itself at session start and whenever an agent is spawned, as a column on the right.
- **Terminal:** the pane opens only when you ask, because the CLI already has its own tasks list. With the transcript in fullscreen mode it docks on the right; otherwise it sits above the prompt.
- **`/agents-panel`**, on either surface, opens it. It runs mid-turn, while agents are working.
- **`● 1 other session active · 2 agents running [Agents]`**: while the pane is closed and something else runs, this one-line chip sits above the prompt; its button opens the pane.

Once you close the pane (its close mark, or `ctrl+x x` in the terminal), it stops opening by itself for the rest of that session. The chip and the command still bring it back.

## Cost

No model tokens: the mod runs outside the conversation. It checks the registry and file times every 3 seconds and reads a transcript only when it changed and is warm. The only footprint in the conversation is the `/agents-panel` entry in the command list.

## Install

From a shell (user scope, so it loads in every session, desktop app included):

```bash
claude plugin marketplace add pedrojr/claude-mods
claude plugin install agents-panel@claude-mods --scope user
```

Sessions already open do not pick it up: start a new one. See the [repository README](../../README.md) for the terminal prompt and desktop app install steps.

## Settings

None. Edit the constants at the top of `hooks/register.tsx`: `POLL_MS` (refresh rate), `CACHE_TTL_MS` (set 5 minutes if your prompt cache lives 5 minutes), `MAX_TRANSCRIPT_BYTES` (larger transcripts get no last line) and `DOCK_COLUMNS` (docked width).

## Limits

The session registry and transcript layout under `~/.claude` are Claude Code internals, not a public format; a future version may change them and empty the list until the mod is updated.

## Privacy

The mod only reads local files under your Claude Code config folder (`CLAUDE_CONFIG_DIR`, or `~/.claude`). Nothing leaves the machine. Opening a desktop session runs the OS's URL opener (`rundll32 url.dll,FileProtocolHandler` on Windows, `open` on macOS, `xdg-open` on Linux) with the app's `claude://` link.
