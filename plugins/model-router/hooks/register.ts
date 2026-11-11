import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Correction, EvalOutcome, Route, Verdict, Worker } from '../types'
import { EVAL_SET } from './evalset'
import {
  CLASSIFIER_MODEL,
  CLASSIFIER_SYSTEM,
  DELEGATION_SECTION,
  NO_TASK_REASON,
  ROUTED_AGENT_TYPES,
  ROUTE_USAGE,
  classifierPrompt,
  correctionsText,
  defaultRigor,
  estimateTokens,
  evalReport,
  hedge,
  isAbsolutePath,
  isAck,
  label,
  mentionedPaths,
  parseRouteArgs,
  parseVerdict,
  pick,
  quickRules,
  rerouted,
  statusText,
  tokenLabel,
  verdict,
} from './route'
import type { TaskKind } from './route'

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const route = atom({ plugin: 'model-router', key: 'route' } as const, null as Route | null, { shape: 'route-2' })
const pending = atom({ plugin: 'model-router', key: 'pending' } as const, null as Verdict | null, {
  shape: 'verdict-2',
})
const workers = atom({ plugin: 'model-router', key: 'workers' } as const, [] as Worker[], { shape: 'workers-1' })

const COMMAND = 'route'
const SECTION_ID = 'model-router:delegation'
const STORE_PREFIX = 'route:'
const CORRECTIONS_KEY = 'corrections'
const STORE_KEEP_MS = 30 * 24 * 60 * 60 * 1000
const CLASSIFIER_TIMEOUT_MS = 8000
/** A later prompt waits less for its rating: when it fails, the route simply stays. */
const RERATE_TIMEOUT_MS = 5000
const MAX_WORKERS = 50
const MAX_CORRECTIONS = 200
/** How many evaluation prompts are rated at a time. */
const EVAL_BATCH = 6

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

/** The context a prompt starts with: the conversation so far, the prompt and the files it mentions. */
async function startingTokens($: EngineInterface, text: string): Promise<number> {
  const usage = await $.session.usage()
  return (usage.context.tokens ?? 0) + estimateTokens(text) + (await mentionedTokens($, text))
}

/** Rates a task: the quick rules first, then the classifier model, then a safe default. */
async function classify(
  $: EngineInterface,
  kind: TaskKind,
  text: string,
  contextTokens: number,
  timeoutMs = CLASSIFIER_TIMEOUT_MS,
): Promise<Verdict> {
  const quick = quickRules(text)
  if (quick !== null) return verdict(quick, contextTokens, 'rules', 'short command or question', text)

  let reply: Awaited<ReturnType<EngineInterface['model']['complete']>>
  try {
    reply = await $.model.complete({
      model: CLASSIFIER_MODEL,
      system: CLASSIFIER_SYSTEM,
      prompt: classifierPrompt(kind, text, contextTokens),
      maxTokens: 150,
      effort: 'low',
      timeoutMs,
    })
  } catch {
    // The engine refused to send it (the classifier model blocked by `availableModels`, say).
    return verdict('standard', contextTokens, 'fallback', 'classifier unavailable', text)
  }
  const parsed = reply.isAnswered ? parseVerdict(reply.text) : null
  if (parsed === null) {
    const why = reply.isAnswered ? 'classifier reply unreadable' : `classifier ${reply.reason}`
    return verdict('standard', contextTokens, 'fallback', why, text)
  }
  // An unsure rating is moved to the safe side before it picks anything.
  const reason = parsed.confidence === 'low' ? `${parsed.reason} (unsure, rated up)`.trim() : parsed.reason
  return verdict(hedge(parsed), contextTokens, 'classifier', reason, text)
}

function locked(picked: Verdict, mode: Route['mode'], now: number): Route {
  return { ...picked, mode, baseModel: null, baseEffort: null, lockedAt: now, escalatedFrom: null, noted: null }
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

async function corrections($: EngineInterface): Promise<Correction[]> {
  const stored = await $.store.get(CORRECTIONS_KEY)
  return Array.isArray(stored) ? (stored as Correction[]) : []
}

/**
 * Writes down that the person overrode an automatic route. Kept across
 * sessions: read with `/route log`, it shows where the ratings miss.
 */
async function logCorrection($: EngineInterface, from: Route, kind: Correction['kind'], to: string): Promise<void> {
  const entry: Correction = {
    at: await $.clock.now(),
    kind,
    from: label(from),
    to,
    difficulty: from.difficulty,
    rigor: from.rigor,
    source: from.source,
    task: from.task,
  }
  await $.store.set(CORRECTIONS_KEY, [...(await corrections($)), entry].slice(-MAX_CORRECTIONS))
}

/** Logs a /model or /effort the person ran on an automatic route, once per value. */
async function noteOverride($: EngineInterface, current: Route, kind: 'model' | 'effort', to: string): Promise<Route> {
  const mark = `${kind}:${to}`
  if (current.mode !== 'auto' || current.noted === mark) return current
  await logCorrection($, current, kind, to)
  const noted: Route = { ...current, noted: mark }
  await update($, route, () => noted)
  await save($, noted)
  return noted
}

function describeRoute(r: Route | null, p: Verdict | null): string {
  if (r === null) {
    if (p === null) return 'Session: not routed yet. The next prompt picks the model and effort.'
    return `Session: ${label(p)} picked (${p.difficulty}/${p.rigor}, ${p.reason}); locks at the first model request.`
  }
  if (r.mode === 'off' && r.reason === NO_TASK_REASON) {
    return 'Session: the first prompt held no task, so it keeps the session model and effort. /route <model> [effort] sets one.'
  }
  if (r.mode === 'off') return 'Session: routing off. Requests go out with the session model and effort.'
  const how = r.mode === 'manual' ? 'set by /route' : `${r.difficulty}/${r.rigor}, ${r.source}: ${r.reason}`
  const moved = r.escalatedFrom === null ? '' : ` Moved up from ${r.escalatedFrom}.`
  return `Session: ${label(r)} (${how}; context ~${tokenLabel(r.contextTokens)} tokens).${moved}`
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

/** Runs the evaluation set through the router, a few prompts at a time. */
async function evaluate($: EngineInterface): Promise<string> {
  const outcomes: EvalOutcome[] = []
  for (let i = 0; i < EVAL_SET.length; i += EVAL_BATCH) {
    const batch = EVAL_SET.slice(i, i + EVAL_BATCH)
    const rated = await Promise.all(batch.map(c => classify($, 'session', c.text, estimateTokens(c.text))))
    batch.forEach((c, j) => {
      const got = rated[j]
      if (got) outcomes.push({ text: c.text, want: pick(c.difficulty, c.rigor), got, source: got.source })
    })
  }
  return evalReport(outcomes)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show or set the model and effort the model-router picked for this session',
      argumentHint: ROUTE_USAGE,
    })

    const [id, now] = await Promise.all([$.session.id(), $.clock.now()])
    // A resumed session keeps the route it was locked to. The base is taken
    // again at its next request: this launch may start on another model.
    if ((await read($, route)) === null) {
      // A route an earlier version saved has none of the newer fields.
      type Saved = Omit<Route, 'rigor' | 'confidence' | 'task' | 'escalatedFrom' | 'noted'> & Partial<Route>
      const saved = (await $.store.get(STORE_PREFIX + id)) as Saved | undefined
      if (saved && typeof saved === 'object' && 'mode' in saved) {
        const filled: Route = {
          ...saved,
          rigor: saved.rigor ?? defaultRigor(saved.difficulty),
          confidence: saved.confidence ?? 'high',
          task: saved.task ?? '',
          escalatedFrom: saved.escalatedFrom ?? null,
          noted: saved.noted ?? null,
          baseModel: null,
          baseEffort: null,
        }
        await update($, route, () => filled)
      }
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

  // Rates each prompt. Until the route is locked, only the prompt that starts
  // the first model request counts: a local command (/config, /model) starts
  // none, so the next prompt replaces its rating. Once an automatic route is
  // locked, each prompt with a task of its own sets the effort again and may
  // move the model up.
  on('prompt.submit', async ($, e, next) => {
    if (e.isMeta || e.command?.name === COMMAND || e.text.trim() === '') return next(e)

    const current = await read($, route)
    if (current !== null) {
      // The person took the model over with /model: nothing to rate until they hand it back.
      const isTakenOver = current.noted?.startsWith('model:') ?? false
      if (current.mode !== 'auto' || isTakenOver || isAck(e.text)) return next(e)
      const rated = await classify($, 'followup', e.text, await startingTokens($, e.text), RERATE_TIMEOUT_MS)
      // A rating that failed says nothing: the route stays as it is.
      if (rated.source !== 'fallback') await setRoute($, rerouted(current, rated))
      return next(e)
    }

    const contextTokens = await startingTokens($, e.text)
    let task = e.text
    if (isAck(e.text)) {
      // "ok", "continue": the task is in what came before (a resumed session), or nowhere.
      const earlier = await $.session.messages().catch(() => [])
      const last = [...earlier].reverse().find(m => m.role === 'user' && m.text.trim() !== '' && !isAck(m.text))
      if (!last) {
        const keep = verdict('standard', contextTokens, 'rules', NO_TASK_REASON)
        await update($, pending, () => keep)
        $.ui.status(undefined)
        return next(e)
      }
      task = last.text
    }
    const picked = await classify($, 'session', task, contextTokens)
    await update($, pending, () => picked)
    $.ui.status(`route ${label(picked)}`)
    return next(e)
  })

  // Every main-loop model request: lock the route on the first, then send
  // each with the routed model and effort.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)

    const sentEffort = e.effort === undefined ? null : String(e.effort)
    let current = await read($, route)
    if (current === null) {
      const picked = await read($, pending)
      if (picked === null) return yield* next(e)
      current = {
        // A first prompt with no task keeps the session's own model and effort.
        ...locked(picked, picked.reason === NO_TASK_REASON ? 'off' : 'auto', await $.clock.now()),
        baseModel: e.model,
        baseEffort: sentEffort,
      }
      await update($, pending, () => null)
      await setRoute($, current)
    } else if (current.mode !== 'off' && current.baseModel === null) {
      // Set by /route: take what the engine sends now as the base.
      const based: Route = { ...current, baseModel: e.model, baseEffort: sentEffort }
      current = based
      await setRoute($, based)
    }

    if (current.mode === 'off') return yield* next(e)

    // The person ran /model (or a fallback model took over): step aside.
    if (e.model !== current.baseModel) {
      current = await noteOverride($, current, 'model', e.model)
      $.ui.status(statusText(current, true))
      return yield* next(e)
    }
    if (current.noted?.startsWith('model:')) {
      // Back on the session's own model: the route applies again.
      const back: Route = { ...current, noted: null }
      current = back
      await update($, route, () => back)
      await save($, back)
    }
    // The person ran /effort: keep the routed model, leave the effort to them.
    const effortChanged = sentEffort !== current.baseEffort
    if (effortChanged && sentEffort !== null) current = await noteOverride($, current, 'effort', sentEffort)
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
      case 'log':
        return { text: correctionsText(await corrections($)) }
      case 'eval':
        return { text: await evaluate($) }
      case 'off': {
        const base = current ?? (await read($, pending)) ?? verdict('standard', 0, 'manual', 'routing off')
        await setRoute($, locked(base, 'off', now))
        return { text: 'Routing off for this session. Requests go out with the session model and effort.' }
      }
      case 'auto':
        await update($, pending, () => null)
        await setRoute($, null)
        return {
          text: 'Route cleared. The next prompt picks the model and effort again. Switching models mid-conversation re-reads the whole context once.',
        }
      case 'set': {
        if (current?.mode === 'auto' && label(current) !== label(cmd)) {
          await logCorrection($, current, 'route', label(cmd))
        }
        const tokens = current?.contextTokens ?? 0
        const manual: Route = {
          ...locked(verdict('standard', tokens, 'manual', 'set by /route'), 'manual', now),
          model: cmd.model,
          effort: cmd.effort,
        }
        await setRoute($, manual)
        return {
          text: `Session locked to ${label(cmd)}. Switching models mid-conversation re-reads the whole context once.`,
        }
      }
    }
  })
}
