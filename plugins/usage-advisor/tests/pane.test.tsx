import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 10, 12, 0) + minutes * 60_000).toISOString()
const TRANSCRIPT = [
  JSON.stringify({ type: 'user', timestamp: at(0), message: { content: 'faça a revisão do módulo de pagamentos' } }),
  JSON.stringify({
    type: 'assistant',
    timestamp: at(0),
    message: { id: 'a', model: 'claude-opus-5-5', usage: { input_tokens: 5, output_tokens: 10, cache_creation_input_tokens: 40_000 }, content: [] },
  }),
  JSON.stringify({
    type: 'assistant',
    timestamp: at(90),
    message: { id: 'b', model: 'claude-opus-5-5', usage: { input_tokens: 5, output_tokens: 10, cache_creation_input_tokens: 45_000 }, content: [] },
  }),
].join('\n')

const BREAKDOWN = {
  categories: [
    { name: 'System prompt', tokens: 3_000, kind: 'used' },
    { name: 'MCP tools', tokens: 8_000, kind: 'used' },
  ],
  memoryFiles: [],
  mcpTools: [{ name: 'mcp__rea__open', serverName: 'rea', tokens: 8_000, isLoaded: true }],
  agents: [],
}

function engine(on: On) {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'advisor' } }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1_000 }))
  on('env.get', (_, e) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? '/cfg' : undefined }))
  on('session.cwd', () => ({ value: 'd:\\dev\\shop' }))
  on('settings.read', () => ({ value: { enabledPlugins: { 'model-router@claude-mods': true } } }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000, tokens: 20_000, breakdown: BREAKDOWN }, rateLimits: [] },
  }))
  // The projects folder and the project's folder answer alike: each keeps only the kind it looks for.
  on('fs.list', () => ({
    value: [
      { name: 'd--dev-shop', kind: 'dir', size: 0, mtimeMs: 0 },
      { name: 's1.jsonl', kind: 'file', size: TRANSCRIPT.length, mtimeMs: 5 },
    ],
  }))
  on('fs.read', () => ({ value: TRANSCRIPT }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
}

const PANE = { plugin: 'usage-advisor', component: 'Pane', surface: 'terminal', requestId: 'usage-advisor' } as const

test('/advisor opens the audit pane: diagnosis, changes one at a time, habits', async ($, on) => {
  engine(on)
  const filled: string[] = []
  const submitted: string[] = []
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const reply = (await $.command.run({
    command: 'advisor',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })) as { text?: string }
  // A short line only: the report stays in the pane, out of the requests.
  expect(reply.text?.length ?? 0).toBeLessThan(80)

  const view = await $.ui.mount({ ...PANE, props: { bodyColumns: 60 } } as never)
  // The audit runs in the background; wait until the pane shows it.
  for (let i = 0; i < 50 && !(await view.find({ type: 'Text', text: /rea/ })); i++) await new Promise(r => setTimeout(r, 10))
  expect(await view.find({ type: 'Text', text: /MCP "rea"/ })).toBeTruthy()
  expect(await view.find({ type: 'Text', text: /Cache expired|Cache expirado/ })).toBeTruthy()
  expect(await view.find({ type: 'Text', text: /\[(ESTIMATED|ESTIMADO)\]/ })).toBeTruthy()

  // The whole audit goes to the prompt box as a draft; nothing is sent.
  await view.press({ key: 'fill-all-button' })
  expect(filled.at(-1)).toContain('rea')
  expect(filled.at(-1)).toMatch(/wait for my OK|espere meu OK/)
  expect(submitted).toEqual([])

  await view.press({ key: 'tab-changes' })
  expect(await view.find({ type: 'Text', text: /rea/ })).toBeTruthy()
  await view.press({ key: 'fill' })
  expect(filled.at(-1)).toMatch(/rea/)
  expect(submitted).toEqual([])

  await view.press({ key: 'tab-habits' })
  expect(await view.find({ type: 'Text', text: /\/clear/ })).toBeTruthy()
  await view.unmount()
})
