# usage-report

A pane for Claude Code with today's usage, or the last 7 days', across every session on your machine. Open it with `/report` or `/report week`.

```
today 00:00–15:42        7 days   ↻ Refresh

Tokens · 45M
input                                762
output                              360k
cache read                           43M
cache write                         1.5M
cache hit                            97%
estimated cost (API prices)       $24.43

Models · 373 responses
claude-opus-5-5     329 · 40M tok · $23.45
claude-sonnet-5-5   27 · 2.2M tok · $0.92
claude-haiku-5-5    17 · 2.4M tok · $0.07

Top sessions
1. Revisão da barra de sessão e componentes
   opus-5-5 · 19M tok · $7.99
2. Pontos de melhoria/revisão no projeto ragnar:
   opus-5-5 · 13M tok · $7.82

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

The day starts at local midnight; the 7-day view starts at midnight six days ago. Everything comes from the transcripts Claude Code writes under `~/.claude/projects/`, so sessions from the desktop app, the terminal and VS Code all count, including ones that never loaded this mod.

- **Tokens:** input, output, cache read and cache write, summed from each API response's `usage`. A response split over several transcript lines counts once.
- **Cache hit:** the share of input tokens read from the prompt cache (cache read divided by input, cache read and cache write). Green from 80%, yellow from 50%.
- **Estimated cost:** each response priced at the first-party API list price of its model (cache writes at the 1-hour rate, twice the input price). On a subscription you are not billed this; it shows what the same use would cost on the API. Models missing from the `PRICES` table in `hooks/stats.ts` count as $0.
- **Models:** API responses per model, with that model's total tokens and estimated cost.
- **Top sessions:** the five sessions that used the most tokens, their subagents included. Each one is named by its title, else its first prompt, else its folder. The model shown is the one that used most of its tokens.
- **Effort:** API responses per effort level (`low`, `medium`, `high`, ...). Responses with no effort recorded show as `default`.
- **Tool calls:** every call, split into ok, error (the tool failed) and denied (a permission rule, a hook or you refused it). It also lists the five most used tools and the three that failed most. MCP tools show by their own name, without the `mcp__<server>__` prefix.
- **Retries:** a failed or denied call followed by another call to the same tool. It is a rough count: a second call to the same tool for another reason also counts.
- **API errors:** responses the API answered with an error, such as overload or rate limits.
- **Interrupted turns:** turns you stopped.
- **Sessions and subagents:** main sessions and subagents with at least one response or tool call today, with subagents grouped by type.

## Using it

- `/report` (or `/report today`) reads today's transcripts, opens the pane and focuses it. `/report week` (or `7d`, `semana`) shows the last 7 days. It runs mid-turn.
- While the pane is open it refreshes every minute and after every turn of this session. `↻ Refresh` (or `r`) refreshes now; `7 days` / `Today` (or `w`) switches the period.
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
- Tokens are the API's own counts. The cost is an estimate from list prices that can go out of date; `usage-bar` shows the plan limits.
- Deleted or moved transcripts are not counted.

## Privacy

The mod only reads local files under your Claude Code config folder (`CLAUDE_CONFIG_DIR`, or `~/.claude`). Nothing leaves the machine.
