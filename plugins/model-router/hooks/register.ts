import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Route, Verdict, Worker } from '../types'
import {
  CLASSIFIER_MODEL,
  CLASSIFIER_SYSTEM,
  DELEGATION_SECTION,
  ROUTED_AGENT_TYPES,
  classifierPrompt,
  estimateTokens,
  isAbsolutePath,
  label,
  mentionedPaths,
  parseRouteArgs,
  parseVerdict,
  quickRules,
  statusText,
  tokenLabel,
  verdict,
} from './route'

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const route = atom({ plugin: 'model-router', key: 'route' } as const, null as Route | null, { shape: 'route-1' })
const pending = atom({ plugin: 'model-router', key: 'pending' } as const, null as Verdict | null, {
  shape: 'verdict-1',
})
const workers = atom({ plugin: 'model-router', key: 'workers' } as const, [] as Worker[], { shape: 'workers-1' })

const COMMAND = 'route'
const SECTION_ID = 'model-router:delegation'
const STORE_PREFIX = 'route:'
const STORE_KEEP_MS = 30 * 24 * 60 * 60 * 1000
const CLASSIFIER_TIMEOUT_MS = 8000
const MAX_WORKERS = 50

/** Tokens of the files a prompt mentions with `@`, from their sizes on disk. */
async function mentionedTokens($: EngineInterface, text: string): Promise<number> {
  const paths = mentionedPaths(text)
  if (paths.length === 0) return 0
  const cwd = await $.session.cwd()
  let total = 0
  for (const path of paths) {
    if (path.startsWith('~')) continue
    const full = isAbsolutePath(path) ? path : `${cwd}/${path}`
    try {
      const stat = await $.fs.stat(full)
      if (stat.kind === 'file') total += Math.ceil(stat.size / 4)
    } catch {
      // A mention that is no file on disk adds nothing.
    }
  }
  return total
}

/** Rates a task: the quick rules first, then the classifier model, then a safe default. */
async function classify($: EngineInterface, kind: 'session' | 'subagent', text: string, contextTokens: number) {
  const quick = quickRules(text)
  if (quick !== null) return verdict(quick, contextTokens, 'rules', 'short command or question')

  const reply = await $.model.complete({
    model: CLASSIFIER_MODEL,
    system: CLASSIFIER_SYSTEM,
    prompt: classifierPrompt(kind, text, contextTokens),
    maxTokens: 100,
    effort: 'low',
    timeoutMs: CLASSIFIER_TIMEOUT_MS,
  })
  const parsed = reply.isAnswered ? parseVerdict(reply.text) : null
  if (parsed === null) {
    const why = reply.isAnswered ? 'classifier reply unreadable' : `classifier ${reply.reason}`
    return verdict('standard', contextTokens, 'fallback', why)
  }
  return verdict(parsed.difficulty, contextTokens, 'classifier', parsed.reason)
}

async function save($: EngineInterface, value: Route | null): Promise<void> {
  const key = STORE_PREFIX + (await $.session.id())
  if (value === null) await $.store.delete(key)
  else await $.store.set(key, value)
}

async function setRoute($: EngineInterface, value: Route | null): Promise<void> {
  await update($, route, () => value)
  await save($, value)
  $.ui.status(statusText(value, false))
}

function describeRoute(r: Route | null, p: Verdict | null): string {
  if (r === null) {
    if (p === null) return 'Session: not routed yet. The next prompt picks the model and effort.'
    return `Session: ${label(p)} picked (${p.difficulty}, ${p.reason}); locks at the first model request.`
  }
  if (r.mode === 'off') return 'Session: routing off. Requests go out with the session model and effort.'
  const how = r.mode === 'manual' ? 'set by /route' : `${r.difficulty}, ${r.source}: ${r.reason}`
  return `Session: ${label(r)} (${how}; context at start ~${tokenLabel(r.contextTokens)} tokens).`
}

function describeWorkers(list: readonly Worker[]): string {
  if (list.length === 0) return 'Subagents: none started yet.'
  const lines = list.slice(-15).map(w => {
    const name = w.name ?? w.description
    const runsOn = w.model && w.effort ? label({ model: w.model, effort: w.effort }) : (w.model ?? 'own model')
    return `- ${name} [${w.subagentType}] ${runsOn}${w.chosenBy === 'router' ? ' (router)' : ''}`
  })
  return [`Subagents (${list.length}):`, ...lines].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show or set the model and effort the model-router picked for this session',
      argumentHint: '[off | auto | haiku|sonnet|opus [medium|high]]',
    })

    const [id, now] = await Promise.all([$.session.id(), $.clock.now()])
    // A resumed session keeps the route it was locked to.
    if ((await read($, route)) === null) {
      const saved = (await $.store.get(STORE_PREFIX + id)) as Route | undefined
      if (saved && typeof saved === 'object' && 'mode' in saved) await update($, route, () => saved)
    }
    $.ui.status(statusText(await read($, route), false))

    // Drop the routes of sessions locked more than 30 days ago.
    for (const key of await $.store.keys()) {
      if (!key.startsWith(STORE_PREFIX)) continue
      const entry = (await $.store.get(key)) as Partial<Route> | undefined
      if (!entry?.lockedAt || now - entry.lockedAt > STORE_KEEP_MS) await $.store.delete(key)
    }
    return next(e)
  })

  // A /clear starts a new conversation: the next prompt routes it afresh.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, route, () => null)
      await update($, pending, () => null)
      await update($, workers, () => [])
      $.ui.status(undefined)
    }
    return next(e)
  })

  // Rates each prompt until the route is locked. Only the prompt that starts
  // the first model request counts: a local command (/config, /model) starts
  // none, so the next prompt replaces its rating.
  on('prompt.submit', async ($, e, next) => {
    if (e.isMeta || e.command?.name === COMMAND || e.text.trim() === '') return next(e)
    if ((await read($, route)) !== null) return next(e)

    const usage = await $.session.usage()
    const contextTokens = (usage.context.tokens ?? 0) + estimateTokens(e.text) + (await mentionedTokens($, e.text))
    const picked = await classify($, 'session', e.text, contextTokens)
    await update($, pending, () => picked)
    $.ui.status(`route ${label(picked)}`)
    return next(e)
  })

  // Every main-loop model request: lock the route on the first, then send
  // each with the routed model and effort.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)

    let current = await read($, route)
    if (current === null) {
      const picked = await read($, pending)
      if (picked === null) return yield* next(e)
      current = {
        ...picked,
        mode: 'auto',
        baseModel: e.model,
        baseEffort: e.effort === undefined ? null : String(e.effort),
        lockedAt: await $.clock.now(),
      }
      await update($, pending, () => null)
      await setRoute($, current)
    } else if (current.mode !== 'off' && current.baseModel === null) {
      // Set by /route: take what the engine sends now as the base.
      const based: Route = { ...current, baseModel: e.model, baseEffort: e.effort === undefined ? null : String(e.effort) }
      current = based
      await setRoute($, based)
    }

    if (current.mode === 'off') return yield* next(e)

    // The person ran /model (or a fallback model took over): step aside.
    if (e.model !== current.baseModel) {
      $.ui.status(statusText(current, true))
      return yield* next(e)
    }
    // The person ran /effort: keep the routed model, leave the effort to them.
    const effortChanged = (e.effort === undefined ? null : String(e.effort)) !== current.baseEffort
    $.ui.status(statusText(current, false))
    return yield* next({ ...e, model: current.model, ...(effortChanged ? {} : { effort: current.effort }) })
  })

  // The tiers and the reuse rule, added last to the system prompt. The text
  // never changes, so the prompt cache holds.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { sections: [...composed.sections, { id: SECTION_ID, text: DELEGATION_SECTION, scope: 'session' }] }
  })

  // Safety net for subagents: when the main model left out the model or the
  // effort of a generic agent, rate its task and fill them in.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const type = e.subagent_type ?? 'general-purpose'
    const isRouted = ROUTED_AGENT_TYPES.has(type) && (e.model === undefined || e.effort === undefined)
    let model: string | null = e.model ?? null
    let effort: string | null = e.effort ?? null
    let input = e

    if (isRouted) {
      const picked = await classify($, 'subagent', e.prompt, estimateTokens(e.prompt))
      model = e.model ?? picked.model
      effort = e.effort ?? picked.effort
      input = { ...e, model: e.model ?? picked.model, effort: e.effort ?? picked.effort }
    }

    const worker: Worker = {
      name: e.name ?? null,
      description: e.description,
      subagentType: type,
      model,
      effort,
      chosenBy: isRouted ? 'router' : 'model',
      at: await $.clock.now(),
    }
    await update($, workers, list => [...list, worker].slice(-MAX_WORKERS))
    return next(input)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const cmd = parseRouteArgs(e.args)
    const now = await $.clock.now()
    const current = await read($, route)

    switch (cmd.kind) {
      case 'error':
        return { text: cmd.message }
      case 'show': {
        const [p, list] = await Promise.all([read($, pending), read($, workers)])
        return { text: `${describeRoute(current, p)}\n${describeWorkers(list)}` }
      }
      case 'off': {
        const base = current ?? (await read($, pending)) ?? verdict('standard', 0, 'manual', 'routing off')
        await setRoute($, { ...base, mode: 'off', baseModel: null, baseEffort: null, lockedAt: now })
        return { text: 'Routing off for this session. Requests go out with the session model and effort.' }
      }
      case 'auto':
        await update($, pending, () => null)
        await setRoute($, null)
        return {
          text: 'Route cleared. The next prompt picks the model and effort again. Switching models mid-conversation re-reads the whole context once.',
        }
      case 'set': {
        const tokens = current?.contextTokens ?? 0
        await setRoute($, {
          ...verdict('standard', tokens, 'manual', 'set by /route'),
          model: cmd.model,
          effort: cmd.effort,
          mode: 'manual',
          baseModel: null,
          baseEffort: null,
          lockedAt: now,
        })
        return {
          text: `Session locked to ${label(cmd)}. Switching models mid-conversation re-reads the whole context once.`,
        }
      }
    }
  })
}
