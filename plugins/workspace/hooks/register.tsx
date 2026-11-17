import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { AgentsSnapshot, PaneState, SessionView } from '../types'
import { openAgent, openSession, readSessions, show, shownSessions } from './agents'
import { ordered } from './sessions'

const PANE = 'workspace'
const TITLE = 'Agents'
const COMMAND = 'workspace'
// How often sessions and agents are read again.
const POLL_MS = 3000
// Columns the docked pane asks for in a fullscreen terminal.
const DOCK_COLUMNS = 56

// Change a tag when its type's fields change: it drops what an earlier version stored.
const agents = atom({ plugin: 'workspace', key: 'agents' } as const, { sessions: [], now: 0 } as AgentsSnapshot, { shape: 'agents-1' })
const pane = atom({ plugin: 'workspace', key: 'pane' } as const, { isOpen: false, closedByPerson: false, showIdle: false } as PaneState, {
  shape: 'pane-2',
})

// The pane is a view only: none of its own failures may get in the way of a spawn or a turn.
const ignore = (): void => {}

// The poll timer; a reload drops it with the module, and the next refresh starts it again.
let poller: { cancel: () => void } | null = null
// True while a tick's refresh runs.
let isPolling = false

// Each value is written only when it changed, so an idle poll redraws nothing.
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Reads the sessions and agents again, and starts the poll when it is not running. */
async function refresh($: Engine): Promise<void> {
  const now = await $.clock.now()
  const sessions = await readSessions($, now).catch(() => [] as SessionView[])
  const current = await read($, agents)
  // Redraw only on a change: the rows show no age, so an idle poll draws nothing new.
  if (!same(sessions, current.sessions)) await update($, agents, () => ({ sessions, now }))
  if (!poller) {
    poller = $.clock.every(POLL_MS, () => {
      // A slow read (many transcripts) skips the ticks that come during it, so they do not pile up.
      if (isPolling) return
      isPolling = true
      void refresh($)
        .catch(ignore)
        .finally(() => {
          isPolling = false
        })
    })
  }
}

/** Opens the pane; `asked` is true when the person's own command or press asks for it. */
async function openPane($: Engine, asked: boolean): Promise<string> {
  const opened = await $.ui.open({ id: PANE, title: TITLE, columns: DOCK_COLUMNS, ...(asked ? { focus: true } : {}) })
  await update($, pane, state => ({
    ...state,
    isOpen: opened.isPlaced,
    closedByPerson: asked ? false : state.closedByPerson,
  }))
  await refresh($)
  return opened.isPlaced ? 'Agents pane opened.' : `Agents pane waits: ${opened.reason}`
}

async function openIfApp($: Engine): Promise<void> {
  // Once the person closed the pane it stays closed; the chip's button or /workspace brings it back.
  if ((await read($, pane)).closedByPerson) return
  const surfaces = await $.session.surfaces()
  // The terminal opens the pane only on request; app surfaces open it themselves.
  if (surfaces.some(s => s !== 'terminal')) await openPane($, false)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show the agents and sessions running on this machine; a click opens one',
      // Runs mid-turn: agents run while the main turn waits on them.
      immediate: true,
    })
    const result = await next(e)
    // Load the list before the first prompt.
    await refresh($).catch(ignore)
    openIfApp($).catch(ignore)
    return result
  })

  on('session.attach', async ($, e, next) => {
    const result = await next(e)
    if (e.surface !== 'terminal') openIfApp($).catch(ignore)
    return result
  })

  on('command.run', { command: COMMAND }, async $ => {
    try {
      return { text: await openPane($, true) }
    } catch (error) {
      return { text: `Agents pane could not open: ${String(error)}` }
    }
  })

  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE) {
      await update($, pane, state => ({
        ...state,
        isOpen: false,
        closedByPerson: state.closedByPerson || e.origin.kind === 'person',
      })).catch(ignore)
    }
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    refresh($).catch(ignore)
    openIfApp($).catch(ignore)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    refresh($).catch(ignore)
    return result
  })

  // The way back to a closed pane: a one-line chip above the prompt while something else runs.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, pane)).isOpen) return next(e)
    const { sessions } = await read($, agents)
    const otherSessions = sessions.filter(s => !s.isSelf && s.active).length
    const running = sessions.reduce((n, s) => n + s.agents.filter(a => a.active).length, 0)
    if (otherSessions + running === 0) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const parts = [
      otherSessions > 0 ? `${otherSessions} other session${otherSessions === 1 ? '' : 's'} active` : null,
      running > 0 ? `${running} agent${running === 1 ? '' : 's'} running` : null,
    ].filter(Boolean)
    // What the plugins beneath drew (usage-bar's line) stays, above the chip.
    const below = await next(e)
    return (
      <Box flexDirection="column">
        {below}
        <Box flexDirection="row">
          <Text color="success">●</Text>
          <Text dimColor> {parts.join(' · ')} </Text>
          <Button key="open-workspace" label="Agents" onPress={() => openPane($, true).catch(ignore)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const state = await read($, pane)
    const { sessions } = await read($, agents)
    const viewing = e.props.view.agentId

    // This session and whatever runs; idle ones behind "+N idle".
    const { sessions: listed, hidden } = shownSessions(sessions, state.showIdle)
    const runningCount = sessions.reduce((n, s) => n + (s.active ? 1 : 0) + s.agents.filter(a => a.active).length, 0)

    // One row: a dot (green while running, gray when idle), the title, where it runs; what it does now under it.
    const agentRow = (
      key: string,
      depth: number,
      isActive: boolean,
      title: string,
      meta: string,
      lastLine: string | null,
      isBold: boolean,
      onPress: () => void,
    ) => (
      <Box key={key} flexDirection="column" paddingLeft={depth * 2}>
        <Button key={`open:${key}`} plain onPress={onPress}>
          <Text color={isActive ? 'success' : 'subtle'}>●</Text>{' '}
          <Text weight={isBold ? 'bold' : 'regular'} wrap="truncate-end">
            {title}
          </Text>{' '}
          <Text dimColor>{meta}</Text>
        </Button>
        {isActive && lastLine && (
          <Box paddingLeft={2}>
            <Text dimColor wrap="truncate-end">
              ↳ {lastLine}
            </Text>
          </Box>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor>{runningCount > 0 ? `${runningCount} running` : 'idle'}</Text>
          <Box flexDirection="row" gap={1}>
            {viewing ? (
              <Button key="main" plain hotkey="m" onPress={() => void show($).catch(ignore)}>
                ← Main
              </Button>
            ) : null}
            {hidden > 0 || state.showIdle ? (
              <Button key="idle" plain onPress={() => void update($, pane, s => ({ ...s, showIdle: !s.showIdle })).catch(ignore)}>
                <Text dimColor>{state.showIdle ? 'hide idle' : `+${hidden} idle`}</Text>
              </Button>
            ) : null}
          </Box>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {listed.length === 0 && <Text dimColor>Nothing running.</Text>}
          {listed.flatMap(session => [
            agentRow(
              `session:${session.sessionId}`,
              0,
              session.active,
              session.name,
              session.isSelf ? 'this session' : session.entrypoint,
              session.lastLine,
              session.isSelf && !viewing,
              () => void openSession($, session).catch(ignore),
            ),
            ...ordered(session.agents).map(({ agent, depth }) =>
              agentRow(
                `agent:${session.sessionId}:${agent.id}`,
                depth + 1,
                agent.active,
                `${agent.id === viewing ? '▶ ' : ''}${agent.label}`,
                agent.type,
                agent.lastLine,
                agent.id === viewing,
                () => void openAgent($, session, agent).catch(ignore),
              ),
            ),
          ])}
        </Box>
      </Box>
    )
  })
}
