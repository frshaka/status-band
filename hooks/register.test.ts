import { expect, test } from 'claude-code/testing'

import { barSvg, cacheTtlMs, crossedThreshold, emojiBar, formatCache, formatElapsed, formatModelName, formatTokenCount, parseGitStatus, usableContextPercent } from './register'

const SURFACES = ['terminal', 'desktop'] as const

test('nome do modelo legível', () => {
  expect(formatModelName('claude-sonnet-5-5')).toBe('Sonnet 5.5')
  expect(formatModelName('claude-opus-5-5[1m]')).toBe('Opus 5.5 (1M)')
  expect(formatModelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(formatModelName('Opus 5.5')).toBe('Opus 5.5')
})

test('barra SVG das superfícies gráficas', () => {
  expect(barSvg(null)).not.toContain('#22c55e')
  expect(barSvg(30)).toContain('fill="#22c55e"')
  expect(barSvg(90)).toContain('fill="#ef4444"')
})

test('formata contagem de tokens como o script antigo', () => {
  expect(formatTokenCount(950)).toBe('950')
  expect(formatTokenCount(1500)).toBe('1.5k')
  expect(formatTokenCount(200_000)).toBe('200k')
  expect(formatTokenCount(1_000_000)).toBe('1M')
})

test('desconta o buffer de auto-compact do contexto', () => {
  expect(usableContextPercent({ window: 200_000 })).toBe(null)
  expect(usableContextPercent({ window: 200_000, percent: 0 })).toBe(0)
  expect(usableContextPercent({ window: 200_000, percent: 83.5 })).toBe(100)
})

test('lê branch e alterações do git status', () => {
  expect(parseGitStatus(128, '')).toBe(null)
  expect(parseGitStatus(0, '## main...origin/main\n')).toEqual({ branch: 'main', isDirty: false })
  expect(parseGitStatus(0, '## dev\n M a.ts\n')).toEqual({ branch: 'dev', isDirty: true })
  expect(parseGitStatus(0, '## HEAD (no branch)\n')).toEqual({ branch: '(detached)', isDirty: false })
})

test('barra de segmentos e cronômetro do terminal', () => {
  expect(emojiBar(null)).toBe('▱▱▱▱▱▱▱▱▱▱')
  expect(emojiBar(32)).toBe('▰▰▰▱▱▱▱▱▱▱')
  expect(emojiBar(100)).toBe('▰▰▰▰▰▰▰▰▰▰')
  expect(formatElapsed(42_000)).toBe('42s')
  expect(formatElapsed(527_000)).toBe('8m 47s')
  expect(formatElapsed(3_900_000)).toBe('1h 5m')
})

test('duração do cache pelo plano ou forçada', () => {
  expect(cacheTtlMs('auto', true)).toBe(3_600_000)
  expect(cacheTtlMs('auto', false)).toBe(300_000)
  expect(cacheTtlMs('5m', true)).toBe(300_000)
  expect(cacheTtlMs('1h', false)).toBe(3_600_000)
})

test('contagem regressiva do cache', () => {
  expect(formatCache(0, true, 300_000, 48_000)).toBe('🧊 Cache 4m 12s ✓')
  expect(formatCache(0, false, 300_000, 300_000)).toBe('❄️ Cache frio ✗')
})

test('patamares de alerta do limite de 5h', () => {
  expect(crossedThreshold(79.9)).toBe(null)
  expect(crossedThreshold(80)).toBe(80)
  expect(crossedThreshold(96)).toBe(95)
})

test('avisa uma vez por patamar e quando o contexto enche', async ($, on) => {
  const toasts: string[] = []
  const store = new Map<string, unknown>()
  on('session.cwd', () => ({ value: 'C:/proj/app' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('env.get', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('clock.now', () => ({ value: 0 }))
  on('store.get', (_engine, e) => ({ value: store.get(e.key) }))
  on('store.set', (_engine, e) => (store.set(e.key, e.value), { value: undefined }))
  on('ui.toast', (_engine, e) => (toasts.push(e.text), { value: undefined }))
  on('session.measure', (_engine, e) => ({ changed: e.changed }))

  const measure = (contextPercent: number, used5h: number) =>
    $.session.measure({
      context: { tokens: 1, window: 200_000, percent: contextPercent },
      rateLimits: [{ kind: 'five_hour', percentUsed: used5h, resetsAt: '2026-10-06T18:30:00Z' }],
      changed: ['context', 'rateLimits'],
    })

  await measure(10, 81)
  await measure(10, 85)
  await measure(80, 96)
  await measure(81, 97)

  expect(toasts.filter(text => text.startsWith('Limite de 5h'))).toHaveLength(2)
  expect(toasts.filter(text => text.startsWith('Contexto em'))).toHaveLength(1)
})

for (const surface of SURFACES) {
  test(`desenha a faixa no ${surface}`, async ($, on) => {
    on('session.cwd', () => ({ value: 'C:/proj/meu-app' }))
    on('session.model', () => ({ value: 'claude-opus-5-5[1m]' }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
    on('env.get', () => ({ value: undefined }))
    on('process.run', () => ({
      value: { exitCode: 0, stdout: '## main\n M x\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))
    on('clock.now', () => ({ value: 527_000 }))
    // Base da cadeia do AbovePrompt: a faixa agora sempre chama next(e)
    on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))
    on('store.set', () => ({ value: undefined }))
    on('store.get', () => ({ value: undefined }))
    on('session.measure', (_engine, e) => ({ changed: e.changed }))

    await $.session.measure({
      context: { tokens: 50_000, window: 200_000, percent: 25 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 32 }, { kind: 'seven_day', percentUsed: 18 }],
      changed: ['context', 'rateLimits'],
    })

    const ui = await $.ui.mount({
      plugin: 'status-band',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 } } as never,
    })
    const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text).join('')
    expect(texts).toContain('engine band')

    if (surface === 'terminal') {
      expect(texts).toContain('🤖 Opus 5.5 (1M) | 📂 meu-app | 🌳 main ●')
      expect(texts).toContain('⌛ 8m 47s')
      expect(texts).toContain('🚀 Context 50k/200k (')
      expect(texts).toContain('🔥 Session 5h ▰▰▰▱▱▱▱▱▱▱ (32%)')
      expect(texts).toContain('🌙 Weekly ▰▰▱▱▱▱▱▱▱▱ (18%)')
    } else {
      expect(texts).toContain('Contexto')
      expect(texts).toContain('50k / 200k')
      expect(texts).not.toContain('Opus')
    }
  })
}

const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 } } as never

const HIDDEN_USAGE = { show_context: false, show_rate_limit_5h: false, show_rate_limit_7d: false, show_effort: false, show_folder: false }

test('esconde itens desligados no config e a linha que fica vazia', { options: HIDDEN_USAGE }, async ($, on) => {
  on('session.cwd', () => ({ value: 'C:/proj/meu-app' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('env.get', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('clock.now', () => ({ value: 60_000 }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: [''] }))
  on('store.set', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('session.measure', (_engine, e) => ({ changed: e.changed }))

  await $.session.measure({ context: { tokens: 1, window: 200_000, percent: 1 }, rateLimits: [], changed: ['context'] })
  const ui = await $.ui.mount({ plugin: 'status-band', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text).join('')

  expect(texts).toContain('🤖 Opus 5.5 | ⌛ 1m 0s')
  expect(texts).not.toContain('📂')
  expect(texts).not.toContain('Context')
  expect(texts).not.toContain('Weekly')
  expect(texts).not.toContain('Cache')
})

test('cache conta a partir da resposta da thread principal e ignora subagentes', async ($, on) => {
  let now = 0
  on('session.cwd', () => ({ value: 'C:/proj/meu-app' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('env.get', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('clock.now', () => ({ value: now }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: [''] }))
  on('store.set', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('session.measure', (_engine, e) => ({ changed: e.changed }))
  on('turn.step', async function* (_engine, e) {
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: e.agentId ? 0 : 900, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage } as never
  })

  const step = async (agentId?: string) => {
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId } as never)
    for await (const _chunk of stream);
  }
  const bandText = async () => {
    const ui = await $.ui.mount({ plugin: 'status-band', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    return (await ui.findAll({ type: 'Text' })).map(found => found.text).join('')
  }

  await $.session.measure({ context: { tokens: 1, window: 200_000, percent: 1 }, rateLimits: [], changed: ['context'] })
  await step()
  now = 60_000
  await step('sub-1')
  expect(await bandText()).toContain('🧊 Cache 4m 0s ✓')
  now = 300_000
  expect(await bandText()).toContain('❄️ Cache frio ✓')
})
