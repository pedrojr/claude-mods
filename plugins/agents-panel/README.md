# agents-panel

A side pane for Claude Code that lists the agents and subagents of the current session, live, and takes you to the transcript of any one of them with a click.

```
3 running · 2 done                      ← Main
● Review auth module   Explore · 1m12s
  ● Find token checks  Explore · 34s
◐ Draft migration      general-purpose · 2m05s
✓ Map repo layout      Explore · 48s
```

- Each row shows a status mark, the task's description, the agent type and how long it has run (or ran).
  - `●` running, `◌` pending, `◐` waiting, `○` idle (a teammate between messages), `✓` completed, `✗` failed, `■` killed.
- Subagents sit indented under the agent that spawned them; active agents come first.
- Click a row (or press its number, 1 to 9, while the pane has focus) to put that agent's transcript in the main view, the same switch the built-in tasks list makes. The row you are viewing is marked `▶`.
- `← Main` (or `m`) goes back to the main conversation.
- Finished agents stay listed, dimmed, up to the last 15.

## Where it shows

The mod shows only in sessions that load it, so install it first (below). Plugins cannot add an icon or a menu item to the app, so the mod gives three ways in:

- **Desktop app (and other app surfaces):** the pane opens by itself at session start and whenever an agent is spawned, as a column on the right.
- **Terminal:** the pane opens only when you ask, because the CLI already has its own tasks list. With the transcript in fullscreen mode it docks on the right; otherwise it sits above the prompt.
- **`/agents-panel`**, on either surface, opens it. It runs mid-turn, while agents are working.
- **`● 2 agents running [Agents]`**: while the pane is closed and the session has agents, this one-line chip sits above the prompt; its button opens the pane.

Once you close the pane (its close mark, or `ctrl+x x` in the terminal), it stops opening by itself for the rest of that session. The chip and the command still bring it back.

## Install

From a shell (user scope, so it loads in every session, desktop app included):

```bash
claude plugin marketplace add pedrojr/claude-mods
claude plugin install agents-panel@claude-mods --scope user
```

Sessions already open do not pick it up: start a new one. See the [repository README](../../README.md) for the terminal prompt and desktop app install steps.

## Settings

None. Edit `POLL_MS`, `MAX_FINISHED` and `DOCK_COLUMNS` at the top of `hooks/register.tsx` to change the refresh rate, how many finished agents stay listed and the docked width.
