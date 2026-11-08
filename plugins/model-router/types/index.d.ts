export type RouteModel = 'haiku' | 'sonnet' | 'opus'

export type RouteEffort = 'medium' | 'high'

/** How hard a task is, as the rules or the classifier rate it. */
export type Difficulty = 'simple' | 'standard' | 'hard' | 'critical'

/** Who made the choice. */
export type RouteSource = 'rules' | 'classifier' | 'fallback' | 'manual'

/** A model and effort picked for one task, before it is locked to a session. */
export type Verdict = {
  model: RouteModel
  effort: RouteEffort
  difficulty: Difficulty
  /** Estimated tokens of context the task starts with. */
  contextTokens: number
  source: RouteSource
  reason: string
}

/**
 * The session's route, locked at its first model request.
 *
 * `auto` and `manual` rewrite every main-loop request; `off` rewrites none.
 * `baseModel` and `baseEffort` are what the engine itself was about to send
 * when the route was locked: a later request that names another model or
 * effort means the person ran /model or /effort (or a fallback kicked in),
 * and the router steps aside for it.
 */
export type Route = Verdict & {
  mode: 'auto' | 'manual' | 'off'
  baseModel: string | null
  baseEffort: string | null
  lockedAt: number
}

/** One Agent call the session made, with what it ran on. */
export type Worker = {
  name: string | null
  description: string
  subagentType: string
  model: string | null
  effort: string | null
  /** `model` when the main model chose both values, `router` when the mod filled any. */
  chosenBy: 'model' | 'router'
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'model-router': {
      route: Shaped<Route | null>
      pending: Shaped<Verdict | null>
      workers: Shaped<Worker[]>
    }
  }
}
