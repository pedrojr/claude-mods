# usage-bar

A compact, one-line usage meter for Claude Code. It draws above the prompt, in the terminal and in the desktop app, and shows how much of your current session (5-hour window) and of this week (7-day window) you have used:

```
Session ███░░░░░░░░░  23% [16:00]  │  Week █████░░░░░░░  41% [11/09 15:00]  │  ◷ 46m
```

- The bar and the percent turn green below 50%, yellow from 50% to 79% and red from 80%.
- The brackets hold the reset time, in the machine's local time; the weekly one also shows the date (day/month, month/day in English).
- The line updates after each turn and whenever a window moves by a whole point.
- The clock at the end of the line tracks the prompt cache (1 hour after the last response). It shows one of these, never both:
  - `◷ 46m` while it is warm: minutes left before it expires, counted down every minute and drawn yellow in the last 5 minutes.
  - `◷ ~61k` once it has likely expired: your next message will re-cache about that many tokens.
  - On a resumed session it starts from the engine's own idle time and token count.
- The labels follow the language you write your prompts in: English, Portuguese (`Sessão`, `Semana`) or Spanish (`Sesión`, `Semana`).
- The line stays hidden until Claude Code reports the rate limits, which happens after the first response of a session.
- Collapse it with `ctrl+x ctrl+a` or the `[-]` beside it.

## Install

At the prompt of a Claude Code terminal session (replace `<owner>` with the GitHub account that holds the repository):

```
/plugin install usage-bar --marketplace <owner>/claude-mods
```

See the [repository README](../../README.md) for the shell and desktop app install steps.

## Settings

None. Edit `BAR_WIDTH` and the thresholds in `tone()` in `hooks/register.tsx` to change the look, and `CACHE_TTL_MS` if your prompt cache lives 5 minutes instead of 1 hour.
