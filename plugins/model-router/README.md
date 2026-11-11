# model-router

Picks the model and effort for a session from its first prompt. The model stays for the session and only moves up when a later prompt needs it. The effort is set again on each prompt. Each subagent gets a model and effort that fit its own part of the work, so large tasks cost less.

## How a prompt is rated

1. A short command or a quick question (`git status`, `rode os testes`, `what is the default port?`) is rated by simple rules. Any other prompt goes to Haiku at low effort, which answers with three values:
   - `difficulty` is how capable the model must be (`simple`, `standard`, `hard`, `critical`). It rates the hardest single part of the prompt, so a list of ordinary changes counts as standard.
   - `rigor` is how much checking the work needs (`light`, `normal`, `careful`, `deep`). A bug fix in existing code asks for more than a new feature with a clear scope.
   - `confidence` is `low` when the prompt is vague or refers to work the classifier cannot see.
2. A rating with low confidence is moved to the safe side: below hard the difficulty goes up one tier, from hard on the rigor does. A task rated too low loses quality, and one rated too high only costs tokens.
3. The mod estimates the starting context: the conversation so far, the prompt, and the files you mention with `@`. More than 100k tokens counts as large.
4. The difficulty picks the model and the rigor picks the effort:

   | Difficulty | Model | | Rigor | Effort |
   | --- | --- | --- | --- | --- |
   | simple | haiku | | light | low |
   | standard | sonnet | | normal | medium |
   | hard | opus | | careful | high |
   | critical | opus | | deep | xhigh |

   Three limits apply. A simple task stays at medium or below. A critical task stays at high or above. A large context raises the effort to at least high (medium for a simple task) and moves a simple task from haiku to sonnet.

A prompt with no task of its own (`ok`, `sim, pode seguir`, `continue`) is never rated.

## How the session is routed

- The rating of the first prompt locks the model at the first model request. If the first prompt has no task, a resumed session rates the last real prompt of the conversation, and a new session keeps its own model and effort (`/route` says why).
- Each later prompt is rated too. The effort follows the new rating, which keeps the prompt cache on current models. A rating with low confidence never lowers the effort in force.
- The model only moves up. The prompt cache belongs to the model, so each switch re-reads the whole conversation once. The session moves to a stronger model when the switch is worth that: the gap is two models (haiku to opus), the task is critical, or the conversation is still under 30k tokens. Otherwise the model stays and the effort goes up one level.
- A failed rating on a later prompt changes nothing.

The status line shows the route, for example `route sonnet/high`.

The mod steps aside when you take over:

- After `/model` or a fallback to another model, requests go out as the engine sends them, and the status line reads `paused`.
- After `/effort`, the routed model stays and the effort is yours.
- After `/clear`, the next prompt is rated as a first prompt, since it starts a new conversation.

A resumed session keeps the route it had.

## How subagents are routed

- A section added to the system prompt gives the main model the same two tables. It asks the model to split large tasks into parts and to set `model` and `effort` on each Agent call from that part alone. Each agent gets a `name`, and the model sends follow-up work in that area to the same agent with `SendMessage` instead of starting a new one. The section never changes during a conversation, so it does not break the prompt cache.
- If the main model starts a `general-purpose`, `Explore` or `Plan` agent without `model` or `effort`, the mod rates the agent's task and fills in what is missing.
- Other agent types (your own, or a plugin's) keep the model their definition sets.

## The /route command

| Command | What it does |
| --- | --- |
| `/route` | Shows the session's route and why it was picked, plus the subagents started so far with their model and effort |
| `/route opus high` | Locks the session to that model and effort (`haiku`, `sonnet`, `opus` or `fable`; `low`, `medium`, `high` or `xhigh`, `medium` when left out). A locked session is not rated again |
| `/route off` | Stops rewriting requests; the session model and effort apply |
| `/route auto` | Clears the route, so the next prompt is rated as a first prompt |
| `/route log` | Lists the times you overrode an automatic route |
| `/route eval` | Runs the evaluation set through the router and reports how often it picked the labeled model and effort |

Changing the model mid-conversation makes the next request re-read the whole context once. `fable` is never picked by a rating: only `/route fable` sets it.

## Measuring the router

`hooks/evalset.ts` holds 62 labeled prompts in Portuguese and English, from shell commands to a zero-downtime migration. `/route eval` rates each one the way a session would and prints a report: how many got the labeled model and effort, and on which side the misses fell. A model picked below its label is the costly miss, so those come first. The run costs about 50 small Haiku requests.

On the run of 2026-11-10, the model matched the label on 60 of 62 prompts and the effort on 54. No prompt got a model or an effort below its label: every miss was on the expensive side. Results vary a little between runs.

Run it after you change the rules or `CLASSIFIER_SYSTEM`. When a prompt of your own is routed wrong, add it to the set with the label you expected.

The corrections log is the second signal. The mod writes an entry when you run `/model`, `/effort` or `/route <model>` on an automatic route: what it had picked, what you chose, the rating, and the first 200 characters of the prompt. It keeps the last 200 entries on your machine, across sessions. A fallback to another model is logged as a model change too. Read the log with `/route log` to see where the ratings miss, then fix the rules or add the prompt to the evaluation set.

## Install

From a shell:

```bash
claude plugin marketplace add pedrojr/claude-mods
claude plugin install model-router@claude-mods --scope user
```

See the [repository README](../../README.md) for the terminal prompt and desktop app install steps.

## Notes

- Each rated prompt costs one small Haiku request. Short commands and bare go-aheads skip it.
- If the rating of a first prompt fails or times out (8 seconds), the session runs on sonnet / medium. A later prompt waits 5 seconds at most.
- `/model`, the built-in status line and the model picker under the prompt (desktop app, VS Code) still show the session's own model and effort. Claude Code gives mods no way to change them: the mod rewrites each request instead. The `route` entry shows the model and effort the requests are sent with.
- Setting `CLAUDE_CODE_EFFORT_LEVEL` caps the effort the mod can ask for.
- To change the tiers or the thresholds, edit `pick()`, `LARGE_CONTEXT_TOKENS` and `SMALL_CONTEXT_TOKENS` in `hooks/route.ts`.
