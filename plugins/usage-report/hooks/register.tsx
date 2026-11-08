import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Count, Report, Snapshot } from '../types'
import { agentIdOf, agentTypeOf, compact, createParser, parseTranscript, percent, report, reportText, startOfDay, totalOf } from './stats'
import type { FileInput, FileStats } from './stats'

const PANE = 'usage-report'
const TITLE = 'Usage today'
const COMMAND = 'report'
// How often the open pane re-reads the transcripts that changed.
const POLL_MS = 60 * 1000
// `$.fs.read` takes files up to 4 MiB; larger transcripts are streamed through the OS.
const MAX_READ_BYTES = 4 * 1024 * 1024 - 1
// Columns the docked pane asks for in a fullscreen terminal.
const DOCK_COLUMNS = 48

// Change the tag when Report's fields change: it drops what an earlier version stored.
const snapshot = atom({ plugin: 'usage-report', key: 'snapshot' } as const, { report: null, loading: false } as Snapshot, {
  shape: 'report-1',
})

// A report is a view only: none of its failures may get in the way of a turn.
const ignore = (): void => {}

let host: { configDir: string; isWindows: boolean } | null = null
let poller: { cancel: () => void } | null = null
let running: Promise<Report | null> | null = null
// Each transcript's day, re-read only when the file changes.
const cache = new Map<string, { mtimeMs: number; size: number; dayStart: number; stats: FileStats }>()
const agentTypes = new Map<string, string>()

async function findHost($: Engine): Promise<typeof host> {
  if (host) return host
  const [explicit, home, profile, os] = await Promise.all([
    $.env.get('CLAUDE_CONFIG_DIR'),
    $.env.get('HOME'),
    $.env.get('USERPROFILE'),
    $.env.get('OS'),
  ])
  const base = home ?? profile
  const configDir = explicit ?? (base ? `${base.replace(/[\\/]+$/, '')}/.claude` : null)
  if (!configDir) return null
  host = { configDir, isWindows: os === 'Windows_NT' }
  return host
}

/** Streams a file too large for `$.fs.read` through the OS's own printer, line by line. */
async function streamFile($: Engine, path: string, isWindows: boolean, dayStart: number, sidechain: boolean): Promise<FileStats> {
  const argv = isWindows ? ['cmd', '/d', '/c', 'type', path.replace(/\//g, '\\')] : ['cat', path]
  const parser = createParser(dayStart, sidechain)
  let carry = ''
  for await (const { stream, text } of $.process.spawn({ argv })) {
    if (stream !== 'stdout') continue
    const lines = (carry + text).split('\n')
    carry = lines.pop() ?? ''
    for (const raw of lines) parser.line(raw)
  }
  if (carry) parser.line(carry)
  return parser.stats
}

async function statsOf(
  $: Engine,
  path: string,
  file: { mtimeMs: number; size: number },
  dayStart: number,
  sidechain: boolean,
): Promise<FileStats> {
  const cached = cache.get(path)
  if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size && cached.dayStart === dayStart) return cached.stats
  const stats =
    file.size > MAX_READ_BYTES
      ? await streamFile($, path, host?.isWindows ?? false, dayStart, sidechain)
      : parseTranscript(await $.fs.read(path), dayStart, sidechain)
  cache.set(path, { ...file, dayStart, stats })
  return stats
}

async function agentTypeFor($: Engine, metaPath: string): Promise<string> {
  const known = agentTypes.get(metaPath)
  if (known) return known
  const type = await $.fs
    .read(metaPath)
    .then(agentTypeOf)
    .catch(() => 'agent')
  agentTypes.set(metaPath, type)
  return type
}

type Entry = { name: string; kind: string; size: number; mtimeMs: number }

/** Every transcript written today: sessions, and the subagents of those sessions. */
async function readToday($: Engine, dayStart: number): Promise<{ files: FileInput[]; skipped: number }> {
  const found = await findHost($)
  if (!found) return { files: [], skipped: 0 }
  const projects = `${found.configDir}/projects`
  const folders = (await $.fs.list(projects).catch(() => [] as Entry[])).filter(e => e.kind === 'dir')
  let skipped = 0
  const files: FileInput[] = []
  const tryRead = async (make: () => Promise<FileInput>) => {
    try {
      files.push(await make())
    } catch {
      skipped += 1
    }
  }
  await Promise.all(
    folders.map(async folder => {
      const dir = `${projects}/${folder.name}`
      const entries = await $.fs.list(dir).catch(() => [] as Entry[])
      const sessions = entries.filter(e => e.kind === 'file' && e.name.endsWith('.jsonl') && e.mtimeMs >= dayStart)
      await Promise.all(
        sessions.map(async session => {
          await tryRead(async () => ({ kind: 'session', stats: await statsOf($, `${dir}/${session.name}`, session, dayStart, false) }))
          // A subagent writes to its session's transcript too, so only today's sessions are looked into.
          const agentsDir = `${dir}/${session.name.slice(0, -'.jsonl'.length)}/subagents`
          const agents = await $.fs.list(agentsDir).catch(() => [] as Entry[])
          await Promise.all(
            agents
              .filter(a => a.kind === 'file' && agentIdOf(a.name) && a.mtimeMs >= dayStart)
              .map(a =>
                tryRead(async () => ({
                  kind: 'agent',
                  agentType: await agentTypeFor($, `${agentsDir}/agent-${agentIdOf(a.name)}.meta.json`),
                  stats: await statsOf($, `${agentsDir}/${a.name}`, a, dayStart, true),
                })),
              ),
          )
        }),
      )
    }),
  )
  return { files, skipped }
}

/** Re-reads what changed and stores the report; concurrent callers share one run. */
function refresh($: Engine): Promise<Report | null> {
  if (running) return running
  running = (async () => {
    await update($, snapshot, s => ({ ...s, loading: true }))
    try {
      const now = await $.clock.now()
      const dayStart = startOfDay(now)
      // A new day: yesterday's entries are of no more use.
      for (const [path, entry] of cache) if (entry.dayStart !== dayStart) cache.delete(path)
      const { files, skipped } = await readToday($, dayStart)
      const next = report(files, dayStart, now, skipped)
      await update($, snapshot, () => ({ report: next, loading: false }))
      return next
    } catch {
      await update($, snapshot, s => ({ ...s, loading: false })).catch(ignore)
      return null
    } finally {
      running = null
    }
  })()
  return running
}

function startPolling($: Engine): void {
  if (!poller) poller = $.clock.every(POLL_MS, () => void refresh($).catch(ignore))
}

function stopPolling(): void {
  poller?.cancel()
  poller = null
}

const clock = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: "Show today's usage: tokens, models, effort, tool calls, errors, sessions and subagents",
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    const result = await refresh($)
    const opened = await $.ui.open({ id: PANE, title: TITLE, columns: DOCK_COLUMNS, focus: true }).catch(() => null)
    if (opened?.isPlaced) startPolling($)
    if (!result) return { text: 'Usage report: the transcripts could not be read.' }
    // Where the pane shows, a short line is enough; elsewhere the reply carries the report.
    return { text: opened?.isPlaced ? `Usage report opened (${compact(totalOf(result.tokens))} tokens today).` : reportText(result) }
  })

  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE) stopPolling()
    return result
  })

  // While the pane polls, a finished turn also refreshes it, so its own tokens show at once.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (poller) refresh($).catch(ignore)
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { report: r, loading } = await read($, snapshot)
    if (!r) return <Text dimColor>{loading ? 'Reading today’s transcripts…' : 'No report yet.'}</Text>

    const heading = (key: string, text: string) => (
      <Box key={key} marginTop={1}>
        <Text weight="bold">{text}</Text>
      </Box>
    )
    const row = (key: string, label: string, value: string, color?: 'error' | 'warning' | 'success') => (
      <Box key={key} flexDirection="row" justifyContent="space-between">
        <Text dimColor>{label}</Text>
        <Text color={color}>{value}</Text>
      </Box>
    )
    const counts = (prefix: string, items: readonly Count[], whole: number) =>
      items.map(item => row(`${prefix}:${item.name}`, item.name, `${item.count} · ${percent(item.count, whole)}`))

    const t = r.tokens
    const total = totalOf(t)
    const responses = r.models.reduce((n, m) => n + m.count, 0)
    const failed = r.tools.errors + r.tools.denied

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor>
            {clock(r.dayStart)}–{clock(r.now)}
            {loading ? ' · updating…' : ''}
          </Text>
          <Button key="refresh" plain hotkey="r" onPress={() => void refresh($).catch(ignore)}>
            ↻ Refresh
          </Button>
        </Box>

        {heading('h-tokens', `Tokens · ${compact(total)}`)}
        {row('t-in', 'input', compact(t.input))}
        {row('t-out', 'output', compact(t.output))}
        {row('t-cr', 'cache read', compact(t.cacheRead))}
        {row('t-cw', 'cache write', compact(t.cacheWrite))}

        {heading('h-models', `Models · ${responses} responses`)}
        {r.models.length === 0 && <Text dimColor>none</Text>}
        {r.models.map(m => row(`m:${m.name}`, m.name, `${m.count} · ${compact(m.tokens)} tok`))}

        {heading('h-effort', 'Effort')}
        {r.efforts.length === 0 && <Text dimColor>none</Text>}
        {counts('e', r.efforts, responses)}

        {heading('h-tools', `Tool calls · ${r.tools.total}`)}
        {row('c-ok', 'ok', `${r.tools.ok} · ${percent(r.tools.ok, r.tools.total)}`, 'success')}
        {row('c-err', 'error', String(r.tools.errors), r.tools.errors ? 'error' : undefined)}
        {row('c-den', 'denied', String(r.tools.denied), r.tools.denied ? 'warning' : undefined)}
        {r.tools.top.length > 0 && <Text dimColor>most used: {r.tools.top.map(c => `${c.name} ${c.count}`).join(', ')}</Text>}
        {failed > 0 && <Text dimColor>most failed: {r.tools.failing.map(c => `${c.name} ${c.count}`).join(', ')}</Text>}

        {heading('h-fail', 'Failures')}
        {row('f-retry', 'retries after a failed call', String(r.retries), r.retries ? 'warning' : undefined)}
        {row('f-api', 'API errors', String(r.apiErrors), r.apiErrors ? 'error' : undefined)}
        {row('f-int', 'interrupted turns', String(r.interrupts))}

        {heading('h-sessions', 'Sessions')}
        {row('s-main', 'sessions', String(r.sessions))}
        {row('s-agents', 'subagents', String(r.agents.total))}
        {counts('a', r.agents.byType, r.agents.total)}

        {r.skipped > 0 && (
          <Box marginTop={1}>
            <Text color="warning">{r.skipped} transcript(s) could not be read.</Text>
          </Box>
        )}
      </Box>
    )
  })
}
