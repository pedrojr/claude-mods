# usage-report

A pane for Claude Code with today's usage across every session on your machine. Open it with `/report`.

```
00:00–15:42                     ↻ Refresh

Tokens · 36M
input                                540
output                              211k
cache read                           35M
cache write                         776k

Models · 266 responses
claude-opus-5-5          254 · 35M tok
claude-sonnet-5-5        12 · 867k tok

Effort
medium                        266 · 100%

Tool calls · 415
ok                             393 · 95%
error                                  6
denied                                15
most used: Bash 161, Edit 83, Write 46, Read 36, update_plan 33
most failed: Bash 14, WebFetch 5, Grep 1

Failures
retries after a failed call           16
API errors                             0
interrupted turns                      1

Sessions
sessions                               6
subagents                              0
```

## What it counts

The day starts at local midnight. Everything comes from the transcripts Claude Code writes under `~/.claude/projects/`, so sessions from the desktop app, the terminal and VS Code all count, including ones that never loaded this mod.

- **Tokens:** input, output, cache read and cache write, summed from each API response's `usage`. A response split over several transcript lines counts once.
- **Models:** API responses per model, with that model's total tokens.
- **Effort:** API responses per effort level (`low`, `medium`, `high`, ...). Responses with no effort recorded show as `default`.
- **Tool calls:** every call, split into ok, error (the tool failed) and denied (a permission rule, a hook or you refused it). It also lists the five most used tools and the three that failed most. MCP tools show by their own name, without the `mcp__<server>__` prefix.
- **Retries:** a failed or denied call followed by another call to the same tool. It is a rough count: a second call to the same tool for another reason also counts.
- **API errors:** responses the API answered with an error, such as overload or rate limits.
- **Interrupted turns:** turns you stopped.
- **Sessions and subagents:** main sessions and subagents with at least one response or tool call today, with subagents grouped by type.

## Using it

- `/report` reads the transcripts, opens the pane and focuses it. It runs mid-turn.
- While the pane is open it refreshes every minute and after every turn of this session. `↻ Refresh` (or `r`) refreshes now.
- Where no pane can be shown, `/report` replies with the same report as plain text.

## Cost

No model tokens: the mod runs outside the conversation. Each transcript is read again only when its size or modification time changed. Files over 4 MiB are streamed through the OS (`type` on Windows, `cat` elsewhere), because the plugin file API reads up to 4 MiB.

## Install

From a shell:

```bash
claude plugin marketplace add pedrojr/claude-mods
claude plugin install usage-report@claude-mods --scope user
```

Sessions already open do not pick it up: start a new one.

## Settings

None. The constants at the top of `hooks/register.tsx` set the refresh rate (`POLL_MS`) and the docked width (`DOCK_COLUMNS`).

## Limits

- The transcript format is internal to Claude Code and may change in a future version.
- Tokens are the API's own counts. The mod does not convert them to cost or to plan limits; `usage-bar` shows the plan limits.
- Deleted or moved transcripts are not counted.

## Privacy

The mod only reads local files under your Claude Code config folder (`CLAUDE_CONFIG_DIR`, or `~/.claude`). Nothing leaves the machine.
