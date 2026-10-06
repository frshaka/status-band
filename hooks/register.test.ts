import { expect, test } from 'claude-code/testing'

import { barSvg, emojiBar, formatElapsed, formatModelName, formatTokenCount, parseGitStatus, usableContextPercent } from './register'

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
