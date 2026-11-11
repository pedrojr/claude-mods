/** `fable` is never picked by a rating: only `/route fable` sets it. */
export type RouteModel = 'haiku' | 'sonnet' | 'opus' | 'fable'

export type RouteEffort = 'low' | 'medium' | 'high' | 'xhigh'

/** How capable the model must be for a task. It picks the model. */
export type Difficulty = 'simple' | 'standard' | 'hard' | 'critical'

/** How much checking a task needs, whatever its difficulty. It picks the effort. */
export type Rigor = 'light' | 'normal' | 'careful' | 'deep'

/** How sure the classifier is of its rating. */
export type Confidence = 'low' | 'high'

/** Who made the choice. */
export type RouteSource = 'rules' | 'classifier' | 'fallback' | 'manual'

/** What the rules or the classifier say about one task. */
export type Rating = {
  difficulty: Difficulty
  rigor: Rigor
  confidence: Confidence
  reason: string
}

/** A model and effort picked for one task, before it is locked to a session. */
export type Verdict = Rating & {
  model: RouteModel
  effort: RouteEffort
  /** Estimated tokens of context the task starts with. */
  contextTokens: number
  source: RouteSource
  /** The start of the rated prompt, kept so a correction can be read later. */
  task: string
}

/**
 * The session's route, locked at its first model request.
 *
 * `auto` and `manual` rewrite every main-loop request; `off` rewrites none.
 * `baseModel` and `baseEffort` are what the engine itself was about to send
 * when the route was locked: a later request that names another model or
 * effort means the person ran /model or /effort (or a fallback kicked in),
 * and the router steps aside for it.
 *
 * On an `auto` route each later prompt is rated too: the effort follows it,
 * and the model only ever moves up (`escalatedFrom` is the model it left).
 */
export type Route = Verdict & {
  mode: 'auto' | 'manual' | 'off'
  baseModel: string | null
  baseEffort: string | null
  lockedAt: number
  escalatedFrom: RouteModel | null
  /** The last correction written to the log (`model:<id>`, `effort:<level>`), so it is written once. */
  noted: string | null
}

/** One time the person overrode an automatic route. */
export type Correction = {
  at: number
  kind: 'model' | 'effort' | 'route'
  /** What the router had picked, as "model/effort". */
  from: string
  /** What the person chose instead. */
  to: string
  difficulty: Difficulty
  rigor: Rigor
  source: RouteSource
  task: string
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

/** A labeled prompt of the evaluation set. */
export type EvalCase = {
  text: string
  difficulty: Difficulty
  rigor: Rigor
}

/** What the router picked for one evaluation prompt, next to what its label asks for. */
export type EvalOutcome = {
  text: string
  want: { model: RouteModel; effort: RouteEffort }
  got: { model: RouteModel; effort: RouteEffort }
  source: RouteSource
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
