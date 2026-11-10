# usage-bar

A compact, one-line usage meter for Claude Code. It draws above the prompt, in the terminal and in the desktop app, and shows how much of your current session (5-hour window) and of this week (7-day window) you have used, how full this session's context window is, what the session has cost, and the prompt cache:

```
Session ███░░░░░░░░░  13% ↻ 8min  │  Week ███░░░░░░░░░  22% ↻ 13h48  │  Context ███░░░░░░░░░  23% 225k/1M  │  $2.96  │  ◷ 46m
```

- The bars and the percents turn green below 50%, yellow from 50% to 79% and red from 80%.
- `↻` is the time left until that window resets: `8min`, `13h48`, `2d05h`.
- `Context` is the share of the context window this session fills, with its tokens and the window size.
- The cost is the session's total so far, the same figure as `/cost` (`US$ 2.96` in Portuguese and Spanish). It is hidden while it is zero.
- In a terminal narrower than 140 columns the bars are shorter, and the items wrap onto a second line when they do not fit.
- The line checks again every minute, even while the session sits idle. Every session on the machine shares its newest rate-limit reading in `~/.claude/plugins/data/usage-bar/limits.json`, so an idle session follows what the others spend. A window whose reset time has passed drops to 0% until the next reading.
- The clock at the end of the line tracks the prompt cache (1 hour after the last response). It shows one of these, never both:
  - `◷ 46m` while it is warm: minutes left before it expires, counted down every minute and drawn yellow in the last 5 minutes.
  - `◷ ~61k` once it has likely expired: your next message will re-cache about that many tokens.
  - On a resumed session it starts from the engine's own idle time and token count.
- The labels follow the language you write your prompts in: English, Portuguese (`Sessão`, `Semana`, `Contexto`) or Spanish (`Sesión`, `Semana`, `Contexto`).
- The line stays hidden until Claude Code reports the rate limits, which happens after the first response of a session.
- Collapse it with `ctrl+x ctrl+a` or the `[-]` beside it.

## Install

From a shell:

```bash
claude plugin marketplace add pedrojr/claude-mods
claude plugin install usage-bar@claude-mods --scope user
```

See the [repository README](../../README.md) for the terminal prompt and desktop app install steps.

## Settings

None. Edit `BAR_WIDTH` and the thresholds in `tone()` in `hooks/register.tsx` to change the look, and `CACHE_TTL_MS` if your prompt cache lives 5 minutes instead of 1 hour.
