# claude-mods

A collection of mods (plugins) for Claude Code. Each mod lives in its own folder under `plugins/`, and this repository is a plugin marketplace, so every mod installs with one line.

## Mods

| Mod | What it does |
| --- | --- |
| [usage-bar](plugins/usage-bar) | One-line usage meter above the prompt: current session and this week, with percent, bar and reset time, plus a prompt-cache countdown. |
| [agents-panel](plugins/agents-panel) | Side pane with the session's running agents and subagents, nested by parent, with status and elapsed time; click one to view its transcript. Opens by itself in the desktop app, on `/agents-panel` in the terminal. |

## Install

Replace `<owner>` with the GitHub account that holds this repository.

At the prompt of a Claude Code terminal session:

```
/plugin install usage-bar --marketplace <owner>/claude-mods
```

Answer `y` to add the marketplace, then pick a scope (user scope makes the mod load everywhere, including the desktop app).

From a shell:

```bash
claude plugin install usage-bar --marketplace <owner>/claude-mods
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `<owner>/claude-mods`, then **Add plugin**.

If the repository is private, the install works only for people who can read it on GitHub and whose machine already holds a git credential for github.com (an SSH key, or `gh auth login` then `gh auth setup-git`).

## Adding a mod

1. Create `plugins/<mod-name>/` with `.claude-plugin/plugin.json`, `hooks/hooks.json` and the hooks module.
2. Add an entry to `.claude-plugin/marketplace.json` with `"source": "./plugins/<mod-name>"`.
3. Run `claude plugin validate plugins/<mod-name>` before pushing.

## License

MIT, see [LICENSE](LICENSE).
