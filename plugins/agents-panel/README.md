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

- **Desktop app (and other app surfaces):** the pane opens by itself at session start and whenever an agent is spawned.
- **Terminal:** the pane opens only when you ask, with `/agents-panel`, because the CLI already has its own tasks list. With the transcript in fullscreen mode it docks on the right; otherwise it sits above the prompt. Close it with `ctrl+x x`.

## Install

At the prompt of a Claude Code terminal session (replace `<owner>` with the GitHub account that holds the repository):

```
/plugin install agents-panel --marketplace <owner>/claude-mods
```

See the [repository README](../../README.md) for the shell and desktop app install steps.

## Settings

None. Edit `POLL_MS`, `MAX_FINISHED` and `DOCK_COLUMNS` at the top of `hooks/register.tsx` to change the refresh rate, how many finished agents stay listed and the docked width.
