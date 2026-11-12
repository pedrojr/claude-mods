# usage-advisor

Watches how a session spends tokens and shows an icon at the end of usage-bar's line, with the number of tips the session calls for. A click on the icon, or `/advisor`, opens a pane and runs an audit of the project: what each session loads before your first prompt, the last 10 sessions, a diagnosis ranked by impact, changes you can approve one at a time, and the three habits that would save you the most.

The mod only reads. It changes no file, setting, MCP server, hook, skill or agent.

## The icon above the prompt

```text
Sessão ◕ 77% (1h 17min) │ Semana ◑ 45% (4d 20h) │ Contexto ◔ 27% (273k/1M) │ ◷ 38m │ ◆ 2
```

`◆ 2` means the session calls for two tips; `◇` in gray means none. A click on the icon opens the Advisor pane and runs the audit. The tips are listed at the top of the pane's Audit tab, the one that saves the most first, and `/advisor tips` lists them as text. The mod counts as the session runs:

| Tip | When |
| --- | --- |
| Re-read file | A file was read whole more than once, and a read was over ~1k tokens |
| Large output | A tool result was over ~5k tokens (the command or file is named) |
| Context fill | The context is at 60% of the window or more |
| Cold cache | You came back after more than an hour, and the whole context was written to the cache again |
| Model switch | The model changed with more than 20k tokens of context, which re-reads all of it uncached |
| Preload | What the session loads before the first prompt takes 15% of the window or more |

`/advisor hide` hides the icon and `/advisor show` brings it back.

The icon is drawn in the terminal and the desktop app. VS Code draws nothing above the prompt, but `/advisor` and its pane work there.

## The audit pane

`/advisor` opens the pane and reads the data in the background. It has three tabs (keys `1`, `2`, `3`; `r` refreshes):

1. Audit
   - The current model and effort, the context window, and the preload as a share of the window.
   - What can change the model during a session: model-router, the `opusplan` model, `availableModels`.
   - A. Each item of the preload, largest first: memory files (CLAUDE.md and the files they import), each MCP server with its tool count, skill and agent descriptions, the system prompt and built-in tools. Highlights: MCP servers no recent session called, memory files over ~5k tokens, a set of memory files over ~10k, skill or agent descriptions over 250 tokens, and lines repeated across memory files.
   - B. The last 10 sessions of the project: turns, requests, input, output, cache write and cache read, cache hit rate, largest context, duration, models and effort.
   - C. The diagnosis: each problem with its tokens, how often it happens, its impact and the evidence.
2. Changes shows one proposal at a time (`p` and `n` move between them), with what to change, why, the estimated gain per session and the risk. Put in the prompt (`a`) writes that proposal into the prompt box without sending it, so you can edit it and press Enter. Send to Claude (`s`) sends it at once. Both carry the instruction to show you the exact change and wait for your OK.
3. Habits lists up to three habits, one sentence each. A habit shows up only when the sessions read give evidence for it.

On the Audit and Habits tabs, Put all in the prompt (`f`) writes the whole result into the prompt box: the diagnosis, every proposed change and the habits, ending with the instruction to apply the changes one at a time and wait for your OK before each.

Every figure carries its source:

- `MEASURED`: read as is. That covers token counts in the transcripts, the context window, and the model and effort of the last request.
- `ESTIMATED`: an approximation. The preload comes from Claude Code's local estimate. The size of a tool result is its characters divided by 4. `/advisor full` counts the preload with the token-count API instead, one request per tool and memory file, and the preload then reads `MEASURED`.
- `UNAVAILABLE`: Claude Code does not expose it. That covers MCP servers that are configured but did not start, and the model fallback on API overload.

### How problems are ranked

Problems of different kinds are put on one scale, input-equivalent tokens, using the list prices: a cache read costs a tenth of an input token, and a 1-hour cache write costs two. The preload and MCP tools are written once a session and read on every request. A re-read or a large output enters the conversation once and is read on the requests that follow. A cold start writes again what a read would have served. Impact is high from 50k input-equivalent tokens per session, medium from 10k.

### Why the audit is in a pane

Text that a plugin command returns goes into the next requests to the model. A long report printed there would cost the tokens it is meant to save, so `/advisor` replies with one short line and the audit stays in the pane. The result reaches the model only when you put it in the prompt and send it.

## How the icon gets to usage-bar's line

usage-advisor draws nothing there itself. It publishes the tip count in its `icon` state, and usage-bar reads it and draws the icon at the end of its line. A press on the icon runs `/advisor`. Without usage-bar there is no icon, and `/advisor` opens the pane the same way.

## Install

From a shell:

```bash
claude plugin marketplace add pedrojr/claude-mods
claude plugin install usage-advisor@claude-mods --scope user
```

See the [repository README](../../README.md) for the terminal prompt and desktop app install steps.

## Notes

- The mod adds no tokens to your sessions. It writes nothing to the system prompt, and `/advisor` replies with one line.
- The live counters only see the main conversation. Subagents have their own context.
- The cold-cache tip assumes the 1-hour cache Claude Code uses on subscriptions. The audit does not assume a lifetime: it reads the cache writes in the transcripts after any pause over 5 minutes.
- Transcripts are read from `~/.claude/projects/<project>/` (or `CLAUDE_CONFIG_DIR`). Those over 4 MiB are streamed.
- The tips and the pane follow the language of the chat, Portuguese or English, read from your prompts. Before the first prompt they follow the app: the `language` setting of Claude Code, then VS Code's display language, then `LC_ALL`, `LC_MESSAGES` or `LANG`, then Windows' display language. In Portuguese the tags read `MEDIDO`, `ESTIMADO` and `INDISPONÍVEL`.
