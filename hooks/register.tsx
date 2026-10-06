import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { StatusData } from '../types'

const statusData = atom({ plugin: 'status-band', key: 'data' } as const, null)

// Mesma régua do statusline.ps1: o buffer de auto-compact não conta como espaço utilizável
const AUTO_COMPACT_BUFFER_PCT = 16.5
const RATE_LIMIT_CACHE_TTL_MS = 30 * 60 * 1000
const ELAPSED_TICK_MS = 1000
const BAR_WIDTH = 10
const FILLED_SEGMENT = '▰'
const EMPTY_SEGMENT = '▱'
const BAR_PX_WIDTH = 64
const BAR_PX_HEIGHT = 6
// Paleta das superfícies gráficas: o SVG não resolve chaves de tema, então texto e barra usam o mesmo hex
const MODERN_GREEN = '#22c55e'
const MODERN_AMBER = '#eab308'
const MODERN_ORANGE = '#f97316'
const MODERN_RED = '#ef4444'
// Paleta do terminal, tirada do modelo "Need more emojis" (statusline.sh)
const TERMINAL_COLORS = {
  model: '#1ed56b',
  label: '#cdd6f4',
  folder: '#89b4fa',
  branch: '#a6e3a1',
  clean: '#5eff00',
  dirty: '#f9e2af',
  elapsed: '#dc5b5b',
  context: '#ffaf00',
  session: '#2fdf42',
  bar: '#34e2e2',
} as const

type RateLimitCache = { rateLimit5h: number | null; rateLimit7d: number | null; updatedAt: number }
type GitStatus = { branch: string; isDirty: boolean }

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return scaled(tokens / 1_000_000, 'M')
  if (tokens >= 1_000) return scaled(tokens / 1_000, 'k')
  return String(Math.round(tokens))
}

function scaled(value: number, unit: string): string {
  const text = value >= 10 ? Math.round(value).toString() : String(Math.round(value * 10) / 10)
  return text + unit
}

export function usableContextPercent(context: SessionContextUsage): number | null {
  if (context.percent === undefined) return null
  const remaining = 100 - context.percent
  const usableRemaining = Math.max(0, ((remaining - AUTO_COMPACT_BUFFER_PCT) / (100 - AUTO_COMPACT_BUFFER_PCT)) * 100)
  return clampPercent(100 - usableRemaining)
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)))
}

function contextTokens(context: SessionContextUsage): string {
  if (context.tokens === undefined) return ''
  return `${formatTokenCount(context.tokens)} / ${formatTokenCount(context.window)}`
}

function rateLimitPercent(rateLimits: readonly SessionRateLimit[], kind: string): number | null {
  const window = rateLimits.find(limit => limit.kind === kind)
  return window ? clampPercent(window.percentUsed) : null
}

export function parseGitStatus(exitCode: number, stdout: string): GitStatus | null {
  if (exitCode !== 0) return null
  const [header = '', ...changes] = stdout.split('\n').filter(line => line.trim() !== '')
  const branch = header
    .replace(/^## /, '')
    .replace(/^No commits yet on /, '')
    .replace(/^HEAD \(no branch\)$/, '(detached)')
    .split('...')[0]
  return { branch, isDirty: changes.length > 0 }
}

async function readGit($: EngineInterface, cwd: string): Promise<GitStatus | null> {
  try {
    const result = await $.process.run(['git', 'status', '--porcelain=v1', '--branch'], { cwd, timeoutMs: 5000 })
    return parseGitStatus(result.exitCode, result.stdout)
  } catch {
    return null
  }
}

async function readProfile($: EngineInterface): Promise<string> {
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (!configDir) return 'claude'
  const leaf = configDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  return leaf.replace(/^\./, '') || 'claude'
}

// "claude-sonnet-5-5[1m]" vira "Sonnet 5.5 (1M)"; o sufixo de data de ids como "-20251001" não é versão
export function formatModelName(model: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(model)
  if (!match) return model
  const [, family, major, minor] = match
  const name = `${family[0].toUpperCase()}${family.slice(1)} ${minor ? `${major}.${minor}` : major}`
  return model.includes('[1m]') ? `${name} (1M)` : name
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function lastFolder(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

// O primeiro retorno da API da sessão ainda não traz limites; reaproveita a última leitura recente
async function resolveRateLimits($: EngineInterface, rateLimits: readonly SessionRateLimit[], profile: string) {
  const cacheKey = `rateLimits:${profile}`
  const now = await $.clock.now()
  const fresh = { rateLimit5h: rateLimitPercent(rateLimits, 'five_hour'), rateLimit7d: rateLimitPercent(rateLimits, 'seven_day') }
  if (fresh.rateLimit5h !== null || fresh.rateLimit7d !== null) {
    await $.store.set(cacheKey, { ...fresh, updatedAt: now })
    return fresh
  }
  const cached = (await $.store.get(cacheKey)) as RateLimitCache | undefined
  if (!cached || now - cached.updatedAt > RATE_LIMIT_CACHE_TTL_MS) return fresh
  return { rateLimit5h: cached.rateLimit5h, rateLimit7d: cached.rateLimit7d }
}

async function refresh($: EngineInterface, context: SessionContextUsage, rateLimits: readonly SessionRateLimit[]) {
  const cwd = await $.session.cwd()
  const profile = await readProfile($)
  const [model, git, limits, usage] = await Promise.all([
    $.session.model(),
    readGit($, cwd),
    resolveRateLimits($, rateLimits, profile),
    $.session.usage(),
  ])
  await update($, statusData, previous => ({
    model: model ? formatModelName(model) : 'model?',
    effort: previous?.effort ?? null,
    folder: lastFolder(cwd),
    gitBranch: git?.branch ?? null,
    isGitDirty: git?.isDirty ?? false,
    startedAt: usage.startedAt,
    contextPercent: usableContextPercent(context),
    contextTokens: contextTokens(context),
    ...limits,
  }))
}

export function emojiBar(percent: number | null): string {
  const filled = percent === null ? 0 : Math.round((percent / 100) * BAR_WIDTH)
  return FILLED_SEGMENT.repeat(filled) + EMPTY_SEGMENT.repeat(BAR_WIDTH - filled)
}

function percentLabel(percent: number | null): string {
  return `(${percent === null ? '--' : percent}%)`
}

function modernColor(percent: number): string {
  if (percent < 50) return MODERN_GREEN
  if (percent < 65) return MODERN_AMBER
  if (percent < 80) return MODERN_ORANGE
  return MODERN_RED
}

export function barSvg(percent: number | null): string {
  const radius = BAR_PX_HEIGHT / 2
  const track = `<rect width="${BAR_PX_WIDTH}" height="${BAR_PX_HEIGHT}" rx="${radius}" fill="#888" fill-opacity="0.25"/>`
  const fillWidth = percent === null || percent === 0 ? 0 : Math.max(BAR_PX_HEIGHT, (percent / 100) * BAR_PX_WIDTH)
  const fill = fillWidth > 0 ? `<rect width="${fillWidth}" height="${BAR_PX_HEIGHT}" rx="${radius}" fill="${modernColor(percent ?? 0)}"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BAR_PX_WIDTH}" height="${BAR_PX_HEIGHT}" viewBox="0 0 ${BAR_PX_WIDTH} ${BAR_PX_HEIGHT}">${track}${fill}</svg>`
}

function renderTerminal(table: ElementTable<'terminal'>, data: StatusData, elapsed: string) {
  const { Box, Text } = table
  const c = TERMINAL_COLORS
  const separator = (key: string) => <Text key={key}> | </Text>

  return (
    <Box flexDirection="column">
      <Box flexWrap="wrap">
        <Text bold color={c.model}>🤖 {data.model}</Text>
        {data.effort ? separator('s-effort') : null}
        {data.effort ? <Text bold color={c.label}>Effort {data.effort}</Text> : null}
        {separator('s-folder')}
        <Text bold color={c.folder}>📂 {data.folder}</Text>
        {data.gitBranch ? separator('s-git') : null}
        {data.gitBranch ? <Text italic color={c.branch}>🌳 {data.gitBranch} </Text> : null}
        {data.gitBranch ? <Text color={data.isGitDirty ? c.dirty : c.clean}>{data.isGitDirty ? '●' : '✓'}</Text> : null}
        {separator('s-elapsed')}
        <Text color={c.elapsed}>⌛ {elapsed}</Text>
      </Box>
      <Box flexWrap="wrap">
        <Text bold color={c.label}>🚀 Context </Text>
        <Text bold color={c.context}>
          {data.contextTokens ? `${data.contextTokens.replace(/ /g, '')} ` : ''}{percentLabel(data.contextPercent)}
        </Text>
        {separator('s-5h')}
        <Text color={c.session}>🔥 Session 5h </Text>
        <Text color={c.bar}>{emojiBar(data.rateLimit5h)} {percentLabel(data.rateLimit5h)}</Text>
        {separator('s-7d')}
        <Text>🌙 Weekly </Text>
        <Text color={c.bar}>{emojiBar(data.rateLimit7d)} {percentLabel(data.rateLimit7d)}</Text>
      </Box>
    </Box>
  )
}

function renderModern(table: ElementTable<'desktop' | 'vscode' | 'mobile'>, data: StatusData) {
  const { Box, Text, Svg } = table
  const metric = (key: string, label: string, percent: number | null, detail = '') => (
    <Box key={key} alignItems="center" columnGap={1}>
      <Text dimColor>{label}</Text>
      <Svg source={barSvg(percent)} alt={`${label}: ${percent ?? '--'}%`} width={BAR_PX_WIDTH} height={BAR_PX_HEIGHT} />
      <Text bold color={percent === null ? undefined : modernColor(percent)} dimColor={percent === null}>
        {percent === null ? '--' : `${percent}%`}
      </Text>
      {detail ? <Text dimColor>{detail}</Text> : null}
    </Box>
  )

  return (
    <Box flexWrap="wrap" alignItems="center" columnGap={4}>
      {metric('ctx', 'Contexto', data.contextPercent, data.contextTokens)}
      {metric('rl5', '5h', data.rateLimit5h)}
      {metric('rl7', '7 dias', data.rateLimit7d)}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const usage = await $.session.usage()
    await refresh($, usage.context, usage.rateLimits)
    // Só o terminal mostra o cronômetro; redesenhar no desktop seria trabalho à toa
    $.clock.every(ELAPSED_TICK_MS, async () => {
      if ((await $.session.surfaces()).includes('terminal')) $.ui.invalidate('ui.render')
    })
    return result
  })

  // Disparado ao fim de cada turno e quando um limite muda: cobre modelo, git e consumo sem polling
  on('session.measure', async ($, e, next) => {
    await refresh($, e.context, e.rateLimits)
    return next(e)
  })

  // O effort só chega por requisição ao modelo; guarda o último visto
  on('turn.step', async function* ($, e, next) {
    const effort = e.effort === undefined ? null : String(e.effort)
    const current = await read($, statusData)
    if (current && current.effort !== effort) await update($, statusData, () => ({ ...current, effort }))
    return yield* next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const data = await read($, statusData)
    if (e.props.hasSurvey || data === null) return next(e)

    if (e.surface === 'terminal') {
      const elapsed = formatElapsed((await $.clock.now()) - data.startedAt)
      return renderTerminal($.ui.resolve(e), data, elapsed)
    }
    return renderModern($.ui.resolve(e), data)
  })
}
