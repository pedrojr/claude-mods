import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Audit, Basis, Icon, Lang, Live, Pane, PreloadItem, SessionRow } from '../types'
import {
  SESSIONS_READ,
  auditPrompt,
  cacheHit,
  createSessionParser,
  diagnose,
  duplicateLines,
  habits,
  modelSwitchers,
  modelsLabel,
  parseSession,
  preloadOf,
  projectSlug,
  propose,
} from './audit'
import type { Breakdown } from './audit'
import {
  BIG_OUTPUT_TOKENS,
  CACHE_TTL_MS,
  MAX_KEPT,
  WARM_CONTEXT_TOKENS,
  calmText,
  describeCall,
  detectLang,
  emptyLive,
  estimateTokens,
  isFullRead,
  liveTips,
  shortModel,
  tokenLabel,
} from './live'

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const live = atom({ plugin: 'usage-advisor', key: 'live' } as const, emptyLive(), { shape: 'live-1' })
const audit = atom({ plugin: 'usage-advisor', key: 'audit' } as const, null as Audit | null, { shape: 'audit-1' })
const pane = atom({ plugin: 'usage-advisor', key: 'pane' } as const, { isOpen: false, loading: false, proposal: 0, tab: 'audit' } as Pane, {
  shape: 'pane-1',
})
const lang = atom({ plugin: 'usage-advisor', key: 'lang' } as const, 'en' as Lang)
const isHidden = atom({ plugin: 'usage-advisor', key: 'isHidden' } as const, false)
/**
 * What usage-bar draws at the end of its line: the number of tips the session
 * calls for, and whether the person hid the icon. usage-bar reads it; a press
 * on the icon runs /advisor.
 */
// Plain, with no shape tag: another plugin reads it as is. Keep its fields as they are.
const icon = atom({ plugin: 'usage-advisor', key: 'icon' } as const, { count: 0, isHidden: false } as Icon)
/** Whether `lang` was read from the chat; until then it is the app's language. */
const isChatLang = atom({ plugin: 'usage-advisor', key: 'isChatLang' } as const, false)

const COMMAND = 'advisor'
const PANE = 'usage-advisor'
const STORE_HIDDEN = 'isHidden'
// `$.fs.read` takes files up to 4 MiB; larger transcripts are streamed through the OS.
const MAX_READ_BYTES = 4 * 1024 * 1024 - 1
const DOCK_COLUMNS = 60

// A view and a counter: none of their failures may get in the way of a turn.
const ignore = (): void => {}

let host: { configDir: string; isWindows: boolean } | null = null
let running: { detail: 'summary' | 'full'; run: Promise<void> } | null = null

const T = {
  pt: {
    measured: 'MEDIDO',
    estimated: 'ESTIMADO',
    unavailable: 'INDISPONÍVEL',
    tips: 'Dicas desta sessão',
    title: 'Advisor',
    tabs: { audit: '1 Auditoria', changes: '2 Mudanças', habits: '3 Hábitos' },
    refresh: '↻ Atualizar',
    reading: 'Lendo sessões e contexto…',
    none: 'Nenhuma auditoria ainda. Rode /advisor.',
    model: 'Modelo',
    effort: 'Effort',
    window: 'Janela de contexto',
    preload: 'Preload antes do 1º prompt',
    switchers: 'Pode trocar o modelo sozinho',
    noSwitchers: 'nada encontrado nas configurações',
    overloadNote: 'Fallback por sobrecarga da API: o engine não expõe.',
    a: 'A. Custo inicial da sessão',
    flags: 'Destaques',
    noFlags: 'Nada acima dos limites.',
    mcpConfigured: 'MCPs configurados que não subiram: o mod só vê os que expõem ferramentas.',
    b: (n: number) => `B. Últimas ${n} sessões deste projeto`,
    noSessions: 'Nenhum transcript deste projeto.',
    sessionLine: (s: SessionRow) =>
      `${s.turns} turnos · ${s.requests} req · in ${tokenLabel(s.input)} · out ${tokenLabel(s.output)} · cw ${tokenLabel(s.cacheWrite)} · cr ${tokenLabel(s.cacheRead)}`,
    sessionLine2: (s: SessionRow, mins: number) =>
      `cache ${Math.round(cacheHit(s) * 100)}% · máx ${tokenLabel(s.maxContext)} · ${mins} min · ${modelsLabel(s.models)}${s.efforts.length ? ` · ${s.efforts.join('/')}` : ''}`,
    c: 'C. Diagnóstico',
    noProblems: 'Nenhum problema encontrado.',
    impact: { high: 'alto', medium: 'médio', low: 'baixo' },
    proposal: (i: number, n: number) => `Proposta ${i} de ${n}`,
    why: 'Por quê',
    gain: 'Ganho estimado',
    risk: 'Risco',
    prev: '← Anterior',
    next: 'Próxima →',
    fill: 'Colocar no prompt',
    fillAll: 'Colocar tudo no prompt',
    send: 'Enviar ao Claude',
    askNote: 'Nada é aplicado pelo mod. "Colocar no prompt" deixa o texto no prompt para você revisar e enviar; "Enviar ao Claude" já envia. O Claude mostra a mudança e espera seu OK.',
    filled: 'Texto no prompt: revise e aperte Enter.',
    notFilled: 'Não deu para escrever no prompt agora (há um diálogo aberto?).',
    noProposals: 'Nenhuma mudança de configuração a propor.',
    habitsNote: 'Tirados das sessões lidas; maior impacto primeiro.',
    opened: 'Auditoria aberta no painel Advisor.',
    hidden: 'Ícone do advisor escondido. /advisor show traz de volta.',
    shown: 'Ícone do advisor de volta na linha do usage-bar.',
    usage: 'Uso: /advisor [full | tips | hide | show]',
    noTips: 'Nenhuma dica nesta sessão.',
    fullNote: 'full: contagem pela API de tokens (uma requisição por ferramenta e arquivo).',
  },
  en: {
    measured: 'MEASURED',
    estimated: 'ESTIMATED',
    unavailable: 'UNAVAILABLE',
    tips: 'Tips for this session',
    title: 'Advisor',
    tabs: { audit: '1 Audit', changes: '2 Changes', habits: '3 Habits' },
    refresh: '↻ Refresh',
    reading: 'Reading sessions and context…',
    none: 'No audit yet. Run /advisor.',
    model: 'Model',
    effort: 'Effort',
    window: 'Context window',
    preload: 'Preload before the 1st prompt',
    switchers: 'Can switch the model by itself',
    noSwitchers: 'nothing found in the settings',
    overloadNote: 'API overload fallback: the engine does not expose it.',
    a: 'A. Session start cost',
    flags: 'Highlights',
    noFlags: 'Nothing over the limits.',
    mcpConfigured: 'MCP servers configured that did not start: the mod sees only those that expose tools.',
    b: (n: number) => `B. Last ${n} sessions of this project`,
    noSessions: 'No transcript of this project.',
    sessionLine: (s: SessionRow) =>
      `${s.turns} turns · ${s.requests} req · in ${tokenLabel(s.input)} · out ${tokenLabel(s.output)} · cw ${tokenLabel(s.cacheWrite)} · cr ${tokenLabel(s.cacheRead)}`,
    sessionLine2: (s: SessionRow, mins: number) =>
      `cache ${Math.round(cacheHit(s) * 100)}% · max ${tokenLabel(s.maxContext)} · ${mins} min · ${modelsLabel(s.models)}${s.efforts.length ? ` · ${s.efforts.join('/')}` : ''}`,
    c: 'C. Diagnosis',
    noProblems: 'No problem found.',
    impact: { high: 'high', medium: 'medium', low: 'low' },
    proposal: (i: number, n: number) => `Proposal ${i} of ${n}`,
    why: 'Why',
    gain: 'Estimated gain',
    risk: 'Risk',
    prev: '← Previous',
    next: 'Next →',
    fill: 'Put in the prompt',
    fillAll: 'Put all in the prompt',
    send: 'Send to Claude',
    askNote: 'The mod applies nothing. "Put in the prompt" leaves the text in the prompt box for you to review and send; "Send to Claude" sends it now. Claude shows the change and waits for your OK.',
    filled: 'Text in the prompt: review it and press Enter.',
    notFilled: 'Could not write to the prompt now (is a dialog open?).',
    noProposals: 'No configuration change to propose.',
    habitsNote: 'Taken from the sessions read; largest impact first.',
    opened: 'Audit opened in the Advisor pane.',
    hidden: 'Advisor icon hidden. /advisor show brings it back.',
    shown: "Advisor icon back on usage-bar's line.",
    usage: 'Usage: /advisor [full | tips | hide | show]',
    noTips: 'No tip in this session.',
    fullNote: 'full: counted with the token-count API (one request per tool and file).',
  },
} as const

const basisLabel = (b: Basis, l: Lang): string => T[l][b]

/** Publishes the icon's state when it changed. */
async function syncIcon($: Engine): Promise<void> {
  const [s, hidden, shown] = await Promise.all([read($, live), read($, isHidden), read($, icon)])
  const next: Icon = { count: liveTips(s, 'en').length, isHidden: hidden }
  if (next.count !== shown.count || next.isHidden !== shown.isHidden) await update($, icon, () => next)
}

/** Updates what the session did, then the icon that counts its tips. */
async function updateLive($: Engine, fn: (s: Live) => Live): Promise<void> {
  await update($, live, fn)
  await syncIcon($)
}

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
async function streamSession($: Engine, id: string, path: string, isWindows: boolean): Promise<SessionRow> {
  const argv = isWindows ? ['cmd', '/d', '/c', 'type', path.replace(/\//g, '\\')] : ['cat', path]
  const parser = createSessionParser(id)
  let carry = ''
  for await (const { stream, text } of $.process.spawn({ argv })) {
    if (stream !== 'stdout') continue
    const lines = (carry + text).split('\n')
    carry = lines.pop() ?? ''
    for (const raw of lines) parser.line(raw)
  }
  if (carry) parser.line(carry)
  return parser.result()
}

/** The project's most recent sessions, newest first. */
async function readSessions($: Engine): Promise<{ sessions: SessionRow[]; note: string | null }> {
  const found = await findHost($)
  if (!found) return { sessions: [], note: 'config dir not found' }
  const projects = `${found.configDir}/projects`
  const slug = projectSlug(await $.session.cwd()).toLowerCase()
  const folders = await $.fs.list(projects).catch(() => [])
  const folder = folders.find(f => f.kind === 'dir' && f.name.toLowerCase() === slug)
  if (!folder) return { sessions: [], note: `${projects}/${slug}` }
  const dir = `${projects}/${folder.name}`
  const files = (await $.fs.list(dir).catch(() => []))
    .filter(f => f.kind === 'file' && f.name.endsWith('.jsonl'))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, SESSIONS_READ)
  const sessions = await Promise.all(
    files.map(async f => {
      const id = f.name.slice(0, -'.jsonl'.length)
      const path = `${dir}/${f.name}`
      try {
        return f.size > MAX_READ_BYTES ? await streamSession($, id, path, found.isWindows) : parseSession(id, await $.fs.read(path))
      } catch {
        return null
      }
    }),
  )
  return { sessions: sessions.filter((s): s is SessionRow => s !== null && s.requests > 0), note: null }
}

/**
 * Runs the audit and stores it; concurrent callers share one run. A full audit
 * asked while a summary runs waits for it, then runs: sharing the summary would
 * drop the measured counts it asked for.
 */
function runAudit($: Engine, detail: 'summary' | 'full'): Promise<void> {
  if (running && (detail === 'summary' || running.detail === 'full')) return running.run
  const before = running?.run ?? Promise.resolve()
  const run: Promise<void> = (async () => {
    await before.catch(ignore)
    await update($, pane, p => ({ ...p, loading: true }))
    try {
      const l = await read($, lang)
      const [usage, settings, { sessions, note }, now, state] = await Promise.all([
        $.session.usage({ breakdown: detail }).catch(() => null),
        $.settings.read().catch(() => ({}) as Record<string, unknown>),
        readSessions($),
        $.clock.now(),
        read($, live),
      ])
      const breakdown = (usage?.context.breakdown ?? null) as Breakdown | null
      const { items, total } = breakdown ? preloadOf(breakdown) : { items: [] as PreloadItem[], total: 0 }
      const preloadBasis: Basis = breakdown === null ? 'unavailable' : detail === 'full' ? 'measured' : 'estimated'
      const memoryTexts = await Promise.all(
        (breakdown?.memoryFiles ?? []).map(async f => ({ path: f.path, text: await $.fs.read(f.path).catch(() => '') })),
      )
      const contextWindow = usage?.context.window ?? null
      const problems = diagnose({
        lang: l,
        preload: items,
        preloadTokens: total,
        preloadBasis,
        contextWindow,
        sessions,
        duplicates: duplicateLines(memoryTexts),
      })
      const configKinds = /^(mcp:|memory|duplicates|describe:)/
      const current = sessions[0]
      const next: Audit = {
        at: now,
        lang: l,
        model: state.lastModel ?? current?.models[current.models.length - 1] ?? (typeof settings.model === 'string' ? settings.model : null),
        effort: state.lastEffort ?? (typeof settings.effortLevel === 'string' ? settings.effortLevel : null),
        switchers: modelSwitchers(settings, l),
        contextWindow,
        windowBasis: contextWindow === null ? 'unavailable' : 'measured',
        preload: items,
        preloadTokens: total,
        preloadBasis,
        flags: problems.filter(p => configKinds.test(p.id)).map(p => `${p.title}: ${p.evidence}`),
        sessions,
        sessionsBasis: sessions.length > 0 ? 'measured' : 'unavailable',
        sessionsNote: note,
        problems: problems.map(({ weight: _weight, ...p }) => p),
        proposals: propose(problems, items, sessions, l),
        habits: habits(problems, sessions, l),
      }
      await update($, audit, () => next)
    } finally {
      await update($, pane, p => ({ ...p, loading: false })).catch(ignore)
      // A later run chained on this one stays the one callers share.
      if (running?.run === run) running = null
    }
  })()
  running = { detail, run }
  return run
}

/** Leaves `text` in the prompt box for the person to review and send; it sends nothing. */
async function fill($: Engine, text: string, l: Lang): Promise<void> {
  const done = await $.prompt.fill({ text, mode: 'replace' })
  $.ui.toast(done.isFilled ? T[l].filled : T[l].notFilled)
}

/** Follows the language of the chat: each prompt that reads as one language sets it. */
async function setLang($: Engine, text: string): Promise<void> {
  const detected = detectLang(text)
  if (detected === null) return
  if (detected !== (await read($, lang))) await update($, lang, () => detected)
  if (!(await read($, isChatLang))) await update($, isChatLang, () => true)
}

const langOf = (value: unknown): Lang | null =>
  typeof value !== 'string' ? null : /^(pt|portugu)/i.test(value.trim()) ? 'pt' : /^(en|engl)/i.test(value.trim()) ? 'en' : null

/**
 * The app's language, for a session with no chat yet: the response language
 * set in Claude Code's settings, VS Code's display language, the locale
 * variables, then Windows' display language.
 */
async function appLang($: Engine): Promise<Lang> {
  const fromSettings = langOf(await $.settings.read({ key: 'language' }).catch(() => undefined))
  if (fromSettings) return fromSettings
  const nls = await $.env.get('VSCODE_NLS_CONFIG')
  if (nls) {
    try {
      const parsed = JSON.parse(nls) as { resolvedLanguage?: string; userLocale?: string }
      const fromVsCode = langOf(parsed.resolvedLanguage) ?? langOf(parsed.userLocale)
      if (fromVsCode) return fromVsCode
    } catch {
      // Unreadable: the next source decides.
    }
  }
  const fromEnv = langOf(await $.env.get('LC_ALL')) ?? langOf(await $.env.get('LC_MESSAGES')) ?? langOf(await $.env.get('LANG'))
  if (fromEnv) return fromEnv
  if ((await $.env.get('OS')) === 'Windows_NT') {
    let out = ''
    try {
      for await (const { stream, text } of $.process.spawn({ argv: ['powershell', '-NoProfile', '-Command', '(Get-UICulture).Name'] })) {
        if (stream === 'stdout') out += text
      }
    } catch {
      // No PowerShell: English.
    }
    return langOf(out) ?? 'en'
  }
  return 'en'
}

/** Opens the pane and runs the audit in the background. */
async function openAdvisor($: Engine, detail: 'summary' | 'full'): Promise<boolean> {
  const t = T[await read($, lang)]
  await update($, pane, p => ({ ...p, isOpen: true, tab: 'audit', proposal: 0 }))
  const opened = await $.ui.open({ id: PANE, title: t.title, columns: DOCK_COLUMNS, focus: true }).catch(() => null)
  void runAudit($, detail).catch(ignore)
  return opened?.isPlaced ?? false
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Token use audit: what the session starts with, the last sessions, a diagnosis, changes and habits',
      argumentHint: '[full | tips | hide | show]',
      immediate: true,
    })
    if ((await $.store.get(STORE_HIDDEN)) === true) await update($, isHidden, () => true)
    await syncIcon($)
    if (!(await read($, isChatLang))) {
      // A resumed session has a chat already: its last prompts decide. Otherwise the app's language.
      const earlier = await $.session.messages().catch(() => [])
      const typed = earlier.filter(m => m.role === 'user').slice(-5).map(m => m.text).join('\n')
      const fromChat = detectLang(typed)
      if (fromChat) {
        await update($, lang, () => fromChat)
        await update($, isChatLang, () => true)
      } else {
        const fromApp = await appLang($).catch(() => 'en' as Lang)
        if (!(await read($, isChatLang))) await update($, lang, () => fromApp)
      }
    }
    return next(e)
  })

  // A /clear starts a new conversation: what the old one did no longer costs anything.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await updateLive($, () => emptyLive()).catch(ignore)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.isMeta || e.command !== undefined || e.text.trim() === '') return next(e)
    try {
      await setLang($, e.text)
      const now = await $.clock.now()
      await updateLive($, s => {
        const idle = s.lastResponseAt === null ? 0 : now - s.lastResponseAt
        // Back after the cache expired: the next request writes the whole context again.
        const isCold = idle > CACHE_TTL_MS && (s.contextTokens ?? 0) >= WARM_CONTEXT_TOKENS
        const coldStarts = isCold
          ? [...s.coldStarts, { idleMinutes: Math.round(idle / 60_000), contextTokens: s.contextTokens ?? 0 }].slice(-MAX_KEPT)
          : s.coldStarts
        return { ...s, prompts: s.prompts + 1, coldStarts }
      })
    } catch {
      // Counting never stops a prompt.
    }
    return next(e)
  })

  // Every main-loop request: the model and effort it goes out with, and each switch over a warm context.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const model = e.model
      const effort = e.effort === undefined ? null : String(e.effort)
      await updateLive($, s => {
        const isSwitch = s.lastModel !== null && s.lastModel !== model && (s.contextTokens ?? 0) >= WARM_CONTEXT_TOKENS
        const modelSwitches = isSwitch
          ? [...s.modelSwitches, { from: s.lastModel!, to: model, contextTokens: s.contextTokens ?? 0 }].slice(-MAX_KEPT)
          : s.modelSwitches
        return s.lastModel === model && s.lastEffort === effort && !isSwitch ? s : { ...s, lastModel: model, lastEffort: effort, modelSwitches }
      }).catch(ignore)
    }
    return yield* next(e)
  })

  // Each tool result the main conversation reads: whole-file re-reads and large outputs.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || result.deny !== undefined) return result
    const tokens = estimateTokens(result.text?.length ?? 0)
    const input = e as unknown as Record<string, unknown>
    const path = e.tool === 'Read' && typeof input.file_path === 'string' && isFullRead(input) ? input.file_path : null
    if (path === null && tokens < BIG_OUTPUT_TOKENS) return result
    await updateLive($, s => ({
      ...s,
      reads: path === null ? s.reads : { ...s.reads, [path]: { count: (s.reads[path]?.count ?? 0) + 1, tokens } },
      bigOutputs:
        tokens >= BIG_OUTPUT_TOKENS ? [...s.bigOutputs, { tool: e.tool, what: describeCall(e.tool, input), tokens }].slice(-MAX_KEPT) : s.bigOutputs,
    })).catch(ignore)
    return result
  })

  // After each answer: the context fill, and once a session what it started with.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    try {
      const now = await $.clock.now()
      const first = (await read($, live)).preloadTokens === null
      // `summary` is counted locally and sends no request.
      const usage = await $.session.usage(first ? { breakdown: 'summary' } : undefined)
      const breakdown = (usage.context.breakdown ?? null) as Breakdown | null
      const preload = breakdown ? preloadOf(breakdown).total : null
      await updateLive($, s => ({
        ...s,
        lastResponseAt: now,
        contextTokens: usage.context.tokens ?? s.contextTokens,
        contextWindow: usage.context.window ?? s.contextWindow,
        preloadTokens: s.preloadTokens ?? preload,
      }))
    } catch {
      // A missed reading is taken again after the next answer.
    }
    return result
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const l = await read($, lang)
    const t = T[l]
    if (arg === 'hide' || arg === 'show') {
      const hide = arg === 'hide'
      await update($, isHidden, () => hide)
      await $.store.set(STORE_HIDDEN, hide)
      await syncIcon($)
      return { text: hide ? t.hidden : t.shown }
    }
    if (arg === 'tips') {
      const tips = liveTips(await read($, live), l)
      return { text: tips.length === 0 ? t.noTips : tips.map((x, i) => `${i + 1}. ${x.text}`).join('\n') }
    }
    if (arg !== '' && arg !== 'full') return { text: t.usage }
    const isPlaced = await openAdvisor($, arg === 'full' ? 'full' : 'summary')
    // A short line only: a plugin command's text goes into the next requests.
    return { text: isPlaced ? t.opened : `${t.opened} (${t.none})` }
  })

  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE) await update($, pane, p => ({ ...p, isOpen: false })).catch(ignore)
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [a, p, l, current] = await Promise.all([read($, audit), read($, pane), read($, lang), read($, live)])
    const t = T[a?.lang ?? l]
    const lg = a?.lang ?? l

    const tabs = (
      <Box key="tabs" flexDirection="row" gap={2} flexWrap="wrap">
        {(['audit', 'changes', 'habits'] as const).map((id, i) => (
          <Button
            key={`tab-${id}`}
            plain
            hotkey={String(i + 1)}
            dimColor={p.tab !== id}
            onPress={() => void update($, pane, s => ({ ...s, tab: id })).catch(ignore)}
          >
            {t.tabs[id]}
          </Button>
        ))}
        <Button key="refresh" plain hotkey="r" onPress={() => void runAudit($, 'summary').catch(ignore)}>
          {t.refresh}
        </Button>
      </Box>
    )
    const fillAll = a ? (
      <Box key="fill-all" marginTop={1}>
        <Button key="fill-all-button" hotkey="f" onPress={() => void fill($, auditPrompt(a), lg).catch(ignore)}>
          {t.fillAll}
        </Button>
      </Box>
    ) : null
    if (!a) {
      return (
        <Box flexDirection="column">
          {tabs}
          <Text dimColor>{p.loading ? t.reading : t.none}</Text>
        </Box>
      )
    }

    const heading = (key: string, text: string, basis?: Basis) => (
      <Box key={key} marginTop={1} flexDirection="row" justifyContent="space-between">
        <Text weight="bold">{text}</Text>
        {basis ? <Text dimColor>[{basisLabel(basis, lg)}]</Text> : null}
      </Box>
    )
    const row = (key: string, label: string, value: string, color?: string, basis?: Basis) => (
      <Box key={key} flexDirection="row" justifyContent="space-between">
        <Text dimColor>{label}</Text>
        <Text color={color}>
          {value}
          {basis ? <Text dimColor> [{basisLabel(basis, lg)}]</Text> : null}
        </Text>
      </Box>
    )
    const pct = a.contextWindow ? Math.round((a.preloadTokens / a.contextWindow) * 100) : null
    const impactColor = { high: 'error', medium: 'warning', low: undefined } as const

    const tips = liveTips(current, lg)
    const auditTab = (
      <Box key="audit" flexDirection="column">
        <Text key="tips-h" weight="bold">
          {t.tips}
        </Text>
        {tips.length === 0 ? <Text dimColor>{calmText(current, lg)}</Text> : null}
        {tips.map((tip, k) => (
          <Text key={`tip-${k}`} color="warning">
            • {tip.text}
          </Text>
        ))}
        <Box key="tips-gap" marginTop={1} />
        {row('model', t.model, a.model ? shortModel(a.model) : '-', undefined, a.model ? 'measured' : 'unavailable')}
        {row('effort', t.effort, a.effort ?? '-', undefined, a.effort ? 'measured' : 'unavailable')}
        {row('window', t.window, a.contextWindow ? tokenLabel(a.contextWindow) : '-', undefined, a.windowBasis)}
        {row(
          'preload',
          t.preload,
          `~${tokenLabel(a.preloadTokens)}${pct === null ? '' : ` = ${pct}%`}`,
          pct !== null && pct >= 20 ? 'error' : pct !== null && pct >= 10 ? 'warning' : 'success',
          a.preloadBasis,
        )}
        <Text key="switchers" dimColor>
          {t.switchers}: {a.switchers.length ? a.switchers.join('; ') : t.noSwitchers}
        </Text>
        <Text key="overload" dimColor>
          {t.overloadNote} [{basisLabel('unavailable', lg)}]
        </Text>

        {heading('h-a', t.a, a.preloadBasis)}
        {a.preload.slice(0, 20).map((i, k) => row(`pre-${k}`, `${i.name} · ${i.kind}`, `~${tokenLabel(i.tokens)}`))}
        {a.preload.length > 20 ? <Text dimColor>+{a.preload.length - 20}</Text> : null}
        {a.preloadBasis === 'estimated' ? <Text dimColor>/advisor {t.fullNote}</Text> : null}
        <Box key="flags" flexDirection="column" marginTop={1}>
          <Text weight="bold">{t.flags}</Text>
          {a.flags.length === 0 ? <Text dimColor>{t.noFlags}</Text> : a.flags.map((f, k) => <Text key={`flag-${k}`} color="warning">• {f}</Text>)}
          <Text dimColor>
            {t.mcpConfigured} [{basisLabel('unavailable', lg)}]
          </Text>
        </Box>

        {heading('h-b', t.b(a.sessions.length), a.sessionsBasis)}
        {a.sessions.length === 0 ? <Text dimColor>{t.noSessions}</Text> : null}
        {a.sessions.map(s => (
          <Box key={`s-${s.id}`} flexDirection="column">
            <Text wrap="truncate-end">{s.name}</Text>
            <Text dimColor>{t.sessionLine(s)}</Text>
            <Text dimColor>{t.sessionLine2(s, Math.round((s.endedAt - s.startedAt) / 60_000))}</Text>
          </Box>
        ))}

        {heading('h-c', t.c)}
        {a.problems.length === 0 ? <Text dimColor>{t.noProblems}</Text> : null}
        {a.problems.map((pr, k) => (
          <Box key={`p-${k}`} flexDirection="column" marginBottom={1}>
            <Box flexDirection="row" justifyContent="space-between">
              <Text weight="bold">
                {k + 1}. {pr.title}
              </Text>
              <Text color={impactColor[pr.impact]}>{t.impact[pr.impact]}</Text>
            </Box>
            <Text dimColor>
              {pr.tokensLabel} · {pr.frequency} · [{basisLabel(pr.basis, lg)}]
            </Text>
            <Text dimColor>{pr.evidence}</Text>
          </Box>
        ))}
      </Box>
    )

    const index = Math.min(p.proposal, Math.max(a.proposals.length - 1, 0))
    const pr = a.proposals[index]
    const changesTab = !pr ? (
      <Text key="changes" dimColor>
        {t.noProposals}
      </Text>
    ) : (
      <Box key="changes" flexDirection="column">
        <Text dimColor>{t.proposal(index + 1, a.proposals.length)}</Text>
        <Text weight="bold">{pr.change}</Text>
        {row('why', t.why, '')}
        <Text>{pr.why}</Text>
        {row('gain', t.gain, pr.gain, 'success', 'estimated')}
        {row('risk', t.risk, '')}
        <Text>{pr.risk}</Text>
        <Box key="nav" flexDirection="row" gap={2} marginTop={1} flexWrap="wrap">
          <Button key="prev" plain hotkey="p" onPress={() => void update($, pane, s => ({ ...s, proposal: Math.max(0, index - 1) })).catch(ignore)}>
            {t.prev}
          </Button>
          <Button
            key="next"
            plain
            hotkey="n"
            onPress={() => void update($, pane, s => ({ ...s, proposal: Math.min(a.proposals.length - 1, index + 1) })).catch(ignore)}
          >
            {t.next}
          </Button>
          <Button key="fill" hotkey="a" onPress={() => void fill($, pr.prompt, lg).catch(ignore)}>
            {t.fill}
          </Button>
          <Button key="send" plain hotkey="s" onPress={() => void $.prompt.submit({ text: pr.prompt }).catch(ignore)}>
            {t.send}
          </Button>
        </Box>
        <Text dimColor>{t.askNote}</Text>
      </Box>
    )

    const habitsTab = (
      <Box key="habits" flexDirection="column">
        <Text dimColor>{t.habitsNote}</Text>
        {a.habits.map((habit, k) => (
          <Text key={`h-${k}`}>
            {k + 1}. {habit}
          </Text>
        ))}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {tabs}
        {p.loading ? <Text dimColor>{t.reading}</Text> : null}
        <Box marginTop={1} flexDirection="column">
          {p.tab === 'audit' ? auditTab : p.tab === 'changes' ? changesTab : habitsTab}
        </Box>
        {p.tab === 'changes' ? null : fillAll}
      </Box>
    )
  })
}
