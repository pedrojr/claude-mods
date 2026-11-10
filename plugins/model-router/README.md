# model-router

Picks the model and effort for a session from its first prompt, then keeps them until the session ends. It also gives each subagent a model and effort that fit its own part of the work, so large tasks cost less.

## How the session is routed

1. When you send the first prompt, the mod rates how hard it is. A short command or a quick question (`git status`, `rode os testes`, `what is the default port?`) is rated by simple rules. Any other prompt goes to Haiku at low effort, which answers with one of four ratings. It rates the hardest single part of the prompt, so a list of ordinary changes counts as standard.
   - A prompt with no task of its own (`ok`, `sim, pode seguir`, `continue`) is not rated. On a resumed session the mod rates the last real prompt of the conversation instead. On a new session the session keeps its own model and effort, and `/route` says why.
2. It estimates the starting context: the prompt, the files you mention with `@`, and the conversation so far when you resume one. More than 100k tokens counts as large.
3. It picks the model and effort:

   | Rating | Normal context | Large context (over 100k tokens) |
   | --- | --- | --- |
   | simple | haiku / medium | sonnet / medium |
   | standard | sonnet / medium | sonnet / high |
   | hard | opus / medium | opus / high |
   | critical | opus / high | opus / high |

4. The choice locks at the first model request and every later request in the main conversation uses it. The model never changes mid-task, so the prompt cache stays warm.

The status line shows the route, for example `route sonnet/high`.

The mod steps aside when you take over:

- After `/model` or a fallback to another model, requests go out as the engine sends them, and the status line reads `paused`.
- After `/effort`, the routed model stays and the effort is yours.
- After `/clear`, the next prompt is rated again, since it starts a new conversation.

A resumed session keeps the route it had.

## How subagents are routed

- A section added to the system prompt gives the main model the same table. It asks the model to split large tasks into parts and to set `model` and `effort` on each Agent call by the difficulty of that part. Each agent gets a `name`, and the model sends follow-up work in that area to the same agent with `SendMessage` instead of starting a new one. The section never changes during a conversation, so it does not break the prompt cache.
- If the main model starts a `general-purpose`, `Explore` or `Plan` agent without `model` or `effort`, the mod rates the agent's task and fills in what is missing.
- Other agent types (your own, or a plugin's) keep the model their definition sets.

## The /route command

| Command | What it does |
| --- | --- |
| `/route` | Shows the session's route and why it was picked, plus the subagents started so far with their model and effort |
| `/route opus high` | Locks the session to that model and effort (`haiku`, `sonnet` or `opus`; `medium` or `high`, `medium` when left out) |
| `/route off` | Stops rewriting requests; the session model and effort apply |
| `/route auto` | Clears the route, so the next prompt is rated again |

Changing the model mid-conversation makes the next request re-read the whole context once.

## Install

From a shell:

```bash
claude plugin marketplace add pedrojr/claude-mods
claude plugin install model-router@claude-mods --scope user
```

See the [repository README](../../README.md) for the terminal prompt and desktop app install steps.

## Notes

- The rating call costs one small Haiku request, on the first prompt only. Short commands skip it.
- If the rating fails or times out (8 seconds), the session runs on sonnet / medium.
- `/model` and the built-in status line still show the session's own model. The `route` entry shows the model and effort the requests are sent with.
- Setting `CLAUDE_CODE_EFFORT_LEVEL` caps the effort the mod can ask for.
- To change the tiers or the 100k threshold, edit `pick()` and `LARGE_CONTEXT_TOKENS` in `hooks/route.ts`.
- On a set of 12 labeled prompts (Portuguese, from shell commands to a zero-downtime migration), Haiku with the rubric in `CLASSIFIER_SYSTEM` rated 11 as labeled. The one miss was a list of review items that included a bug with an unknown cause, rated hard instead of standard.
