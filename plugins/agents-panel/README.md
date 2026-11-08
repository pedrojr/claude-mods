# agents-panel

A side pane for Claude Code that gathers in one place everything running on your machine: every open session (desktop app, terminal, VS Code), the agents and subagents of the current session, and a short line on what each one is doing right now.

```
2 busy · 6 idle · 2 agents                     ← Main
● Commit and agents mod
  this session · claude-mods · 4m12s
  ↳ Edit: register.tsx
  ● Review auth module   Explore · 1m12s
    ● Find token checks  Explore · 34s
● Refactor billing
  desktop · work · 2m05s
  ↳ Bash: Run tests
○ resumos-60
  VS Code · resumos · idle 1h20m
  ↳ Summarize the notes
```

- **Sessions** come from the registry Claude Code keeps in `~/.claude/sessions/`, one entry per open session. Busy ones come first, marked `●`, with how long they have been busy. Idle ones are dimmed, marked `○`, and limited to the 12 most recent.
- **The line under each session** (`↳`) is what it did last: its latest tool call (`Bash: Run tests`, `Edit: register.tsx`), or else the first line of its last reply, or its last prompt. It is read from the session's transcript in `~/.claude/projects/` and re-read only when that file changes.
- **Agents** of the current session sit under it, nested by the agent that spawned them, with status and elapsed time: `●` running, `◌` pending, `◐` waiting, `○` idle, `✓` completed, `✗` failed, `■` killed. Finished agents stay listed, dimmed, up to the last 15.

## Clicking

- **An agent** (or its number, 1 to 9, while the pane has focus) puts that agent's transcript in the main view. The row you are viewing is marked `▶`. `← Main` (or `m`) goes back.
- **This session** goes back to its main conversation.
- **Another session** copies its session id and says where it runs. A plugin cannot switch the app or another terminal to a different session; find it in the desktop app's sidebar, or run `claude --resume <id>` once it is closed.

## Where it shows

The mod shows only in sessions that load it, so install it first (below). Plugins cannot add an icon or a menu item to the app, so the mod gives three ways in:

- **Desktop app (and other app surfaces):** the pane opens by itself at session start and whenever an agent is spawned, as a column on the right.
- **Terminal:** the pane opens only when you ask, because the CLI already has its own tasks list. With the transcript in fullscreen mode it docks on the right; otherwise it sits above the prompt.
- **`/agents-panel`**, on either surface, opens it. It runs mid-turn, while agents are working.
- **`● 1 other session busy · 2 agents running [Agents]`**: while the pane is closed and something is running, this one-line chip sits above the prompt; its button opens the pane.

Once you close the pane (its close mark, or `ctrl+x x` in the terminal), it stops opening by itself for the rest of that session. The chip and the command still bring it back.

The list refreshes every 3 seconds. Each session that has the mod installed draws its own pane; sessions without it still show up in the others' lists.

## Install

From a shell (user scope, so it loads in every session, desktop app included):

```bash
claude plugin marketplace add pedrojr/claude-mods
claude plugin install agents-panel@claude-mods --scope user
```

Sessions already open do not pick it up: start a new one. See the [repository README](../../README.md) for the terminal prompt and desktop app install steps.

## Settings

None. Edit the constants at the top of `hooks/register.tsx`: `POLL_MS` (refresh rate), `MAX_FINISHED` (finished agents kept), `MAX_IDLE_SESSIONS` (idle sessions listed), `MAX_TRANSCRIPT_BYTES` (larger transcripts get no activity line) and `DOCK_COLUMNS` (docked width).

## Privacy

The mod only reads local files under your Claude Code config folder (`CLAUDE_CONFIG_DIR`, or `~/.claude`): the session registry and the tail of each open session's transcript. Nothing leaves the machine.
