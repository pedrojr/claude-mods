# claude-mods

A collection of mods (plugins) for Claude Code. Each mod lives in its own folder under `plugins/`, and this repository is a plugin marketplace, so every mod installs with one line.

## Mods

| Mod | What it does |
| --- | --- |
| [usage-bar](plugins/usage-bar) | One-line usage meter above the prompt: current session and this week, with percent, bar and reset time, plus a prompt-cache countdown. |
| [agents-panel](plugins/agents-panel) | Side pane with the sessions, agents and subagents on the machine (desktop, terminal, VS Code) that are active or still have a warm prompt cache, each with a line on what it did last; green dot while active. Clicking a title opens that session or agent. Opens by itself in the desktop app; `/agents-panel` or the chip above the prompt opens it anywhere. |
| [usage-report](plugins/usage-report) | `/report` opens a pane with today's usage across every session on the machine: tokens, models, effort levels, tool calls (ok, error, denied), retries, API errors, interrupted turns, sessions and subagents. |

## Install

Add the marketplace once, then install each mod you want. User scope makes a mod load in every session, desktop app included.

From a shell:

```bash
claude plugin marketplace add pedrojr/claude-mods
claude plugin install usage-bar@claude-mods --scope user
claude plugin install agents-panel@claude-mods --scope user
claude plugin install usage-report@claude-mods --scope user
```

At the prompt of a Claude Code terminal session:

```
/plugin marketplace add pedrojr/claude-mods
/plugin install agents-panel@claude-mods
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `pedrojr/claude-mods`, then **Add plugin**.

A mod loads when a session starts: sessions already open do not pick up a new install. To update later, run `claude plugin marketplace update claude-mods`, then start a new session.

If the repository is private, the install works only for people who can read it on GitHub and whose machine already holds a git credential for github.com (an SSH key, or `gh auth login` then `gh auth setup-git`).

## Adding a mod

1. Create `plugins/<mod-name>/` with `.claude-plugin/plugin.json`, `hooks/hooks.json` and the hooks module.
2. Add an entry to `.claude-plugin/marketplace.json` with `"source": "./plugins/<mod-name>"`.
3. Run `claude plugin validate plugins/<mod-name>` before pushing.

## License

MIT, see [LICENSE](LICENSE).
