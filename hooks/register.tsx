import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, ModelUsage, PluginOptions, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { StatusData } from '../types'

const statusData = atom({ plugin: 'status-band', key: 'data' } as const, null)

// Mesma régua do statusline.ps1: o buffer de auto-compact não conta como espaço utilizável
const AUTO_COMPACT_BUFFER_PCT = 16.5
const RATE_LIMIT_CACHE_TTL_MS = 30 * 60 * 1000
const ELAPSED_TICK_MS = 1000
// Do maior para o menor: o alerta cita o patamar mais alto já cruzado
const RATE_LIMIT_ALERT_THRESHOLDS = [95, 80]
const CONTEXT_ALERT_PCT = 85
const RATE_LIMIT_ALERT_KEY = 'alert:five_hour'
const CACHE_TTL_MS = { '5m': 5 * 60 * 1000, '1h': 60 * 60 * 1000 } as const
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
  cacheWarm: '#89dceb',
  cacheCold: '#6c7086',
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
    // `?? null` também normaliza o estado gravado por versões sem esses campos
    lastResponseAt: previous?.lastResponseAt ?? null,
    lastCacheHit: previous?.lastCacheHit ?? null,
  }))
}

// shortcut: o plano é inferido pelos limites de 5h/7d, que só vêm em assinatura; se errar, forçar `cache_ttl` no /config
export function cacheTtlMs(setting: string, hasSubscription: boolean): number {
  if (setting === '5m' || setting === '1h') return CACHE_TTL_MS[setting]
  return hasSubscription ? CACHE_TTL_MS['1h'] : CACHE_TTL_MS['5m']
}

// O ✓/✗ é o que a última requisição de fato leu do cache, não a estimativa
export function formatCache(lastResponseAt: number, lastCacheHit: boolean, ttlMs: number, now: number): string {
  const remaining = lastResponseAt + ttlMs - now
  const mark = lastCacheHit ? '✓' : '✗'
  return remaining > 0 ? `🧊 Cache ${formatElapsed(remaining)} ${mark}` : `❄️ Cache frio ${mark}`
}

async function recordCacheUse($: EngineInterface, usage: ModelUsage): Promise<void> {
  const now = await $.clock.now()
  await update($, statusData, previous =>
    previous ? { ...previous, lastResponseAt: now, lastCacheHit: usage.cache_read_input_tokens > 0 } : previous,
  )
}

function isEnabled(options: PluginOptions, key: string): boolean {
  return options[key] !== false
}

type RateLimitAlert = { resetsAt: string; threshold: number }

export function crossedThreshold(percent: number): number | null {
  return RATE_LIMIT_ALERT_THRESHOLDS.find(threshold => percent >= threshold) ?? null
}

function formatResetTime(resetsAt: string | undefined): string {
  if (!resetsAt) return ''
  const reset = new Date(resetsAt)
  if (Number.isNaN(reset.getTime())) return ''
  const hours = String(reset.getHours()).padStart(2, '0')
  const minutes = String(reset.getMinutes()).padStart(2, '0')
  return `, zera às ${hours}:${minutes}`
}

// Um aviso por patamar dentro de cada janela de 5h; a janela é identificada pelo horário em que zera
async function alertRateLimit($: EngineInterface, rateLimits: readonly SessionRateLimit[]): Promise<void> {
  const window = rateLimits.find(limit => limit.kind === 'five_hour')
  const threshold = window ? crossedThreshold(window.percentUsed) : null
  if (!window || threshold === null) return
  const resetsAt = window.resetsAt ?? ''
  const last = (await $.store.get(RATE_LIMIT_ALERT_KEY)) as RateLimitAlert | undefined
  if (last && last.resetsAt === resetsAt && last.threshold >= threshold) return
  await $.store.set(RATE_LIMIT_ALERT_KEY, { resetsAt, threshold })
  $.ui.toast(`Limite de 5h em ${Math.round(window.percentUsed)}%${formatResetTime(window.resetsAt)}`)
}

// Avisa uma vez ao cruzar o patamar e rearma quando o contexto volta a cair (depois de um /compact)
let isContextAlertArmed = true
function alertContext($: EngineInterface, context: SessionContextUsage): void {
  const percent = usableContextPercent(context)
  if (percent === null) return
  if (percent < CONTEXT_ALERT_PCT) {
    isContextAlertArmed = true
    return
  }
  if (!isContextAlertArmed) return
  isContextAlertArmed = false
  $.ui.toast(`Contexto em ${percent}%: rode /compact antes que o auto-compact corte a tarefa no meio`)
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

function renderTerminal(table: ElementTable<'terminal'>, data: StatusData, options: PluginOptions, now: number) {
  const { Box, Text } = table
  const c = TERMINAL_COLORS
  const show = (key: string) => isEnabled(options, key)
  // Cada trecho é um Box para quebrar de linha inteiro; os desligados ou sem dado ficam null
  const line = (key: string, segments: readonly (JSX.Element | null)[]) => {
    const present = segments.filter(segment => segment !== null)
    if (present.length === 0) return null
    const joined = present.flatMap((segment, index) => (index === 0 ? [segment] : [<Text key={`s-${index}`}> | </Text>, segment]))
    return <Box key={key} flexWrap="wrap">{joined}</Box>
  }
  const cache = show('show_cache') && data.lastResponseAt !== null && data.lastCacheHit !== null
    ? formatCache(data.lastResponseAt, data.lastCacheHit, cacheTtlMs(String(options.cache_ttl), data.rateLimit5h !== null || data.rateLimit7d !== null), now)
    : null

  return (
    <Box flexDirection="column">
      {line('l-session', [
        show('show_model') ? <Box key="model"><Text bold color={c.model}>🤖 {data.model}</Text></Box> : null,
        show('show_effort') && data.effort ? <Box key="effort"><Text bold color={c.label}>Effort {data.effort}</Text></Box> : null,
        show('show_folder') ? <Box key="folder"><Text bold color={c.folder}>📂 {data.folder}</Text></Box> : null,
        show('show_git') && data.gitBranch ? (
          <Box key="git">
            <Text italic color={c.branch}>🌳 {data.gitBranch} </Text>
            <Text color={data.isGitDirty ? c.dirty : c.clean}>{data.isGitDirty ? '●' : '✓'}</Text>
          </Box>
        ) : null,
        show('show_elapsed') ? <Box key="elapsed"><Text color={c.elapsed}>⌛ {formatElapsed(now - data.startedAt)}</Text></Box> : null,
        cache ? <Box key="cache"><Text color={cache.startsWith('🧊') ? c.cacheWarm : c.cacheCold}>{cache}</Text></Box> : null,
      ])}
      {line('l-usage', [
        show('show_context') ? (
          <Box key="context">
            <Text bold color={c.label}>🚀 Context </Text>
            <Text bold color={c.context}>
              {data.contextTokens ? `${data.contextTokens.replace(/ /g, '')} ` : ''}{percentLabel(data.contextPercent)}
            </Text>
          </Box>
        ) : null,
        show('show_rate_limit_5h') ? (
          <Box key="5h">
            <Text color={c.session}>🔥 Session 5h </Text>
            <Text color={c.bar}>{emojiBar(data.rateLimit5h)} {percentLabel(data.rateLimit5h)}</Text>
          </Box>
        ) : null,
        show('show_rate_limit_7d') ? (
          <Box key="7d">
            <Text>🌙 Weekly </Text>
            <Text color={c.bar}>{emojiBar(data.rateLimit7d)} {percentLabel(data.rateLimit7d)}</Text>
          </Box>
        ) : null,
      ])}
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

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const usage = await $.session.usage()
    await refresh($, usage.context, usage.rateLimits)
    // Só o terminal mostra cronômetro e cache; redesenhar no desktop seria trabalho à toa
    $.clock.every(ELAPSED_TICK_MS, async () => {
      if ((await $.session.surfaces()).includes('terminal')) $.ui.invalidate('ui.render')
    })
    return result
  })

  // Disparado ao fim de cada turno e quando um limite muda: cobre modelo, git e consumo sem polling
  on('session.measure', async ($, e, next) => {
    await refresh($, e.context, e.rateLimits)
    if (isEnabled(options, 'alert_context')) alertContext($, e.context)
    if (isEnabled(options, 'alert_rate_limit')) await alertRateLimit($, e.rateLimits)
    return next(e)
  })

  // Effort e cache só chegam por requisição ao modelo; subagentes têm cache e effort próprios
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const effort = e.effort === undefined ? null : String(e.effort)
    const current = await read($, statusData)
    if (current && current.effort !== effort) await update($, statusData, () => ({ ...current, effort }))
    const result = yield* next(e)
    if (result.usage) await recordCacheUse($, result.usage)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const data = await read($, statusData)
    if (e.props.hasSurvey || data === null) return next(e)

    // Compõe com a cadeia para não esconder outros mods do AbovePrompt (ex.: image-view)
    const below = await next(e)
    if (e.surface === 'terminal') {
      const table = $.ui.resolve(e)
      return <table.Box flexDirection="column">{renderTerminal(table, data, options, await $.clock.now())}{below}</table.Box>
    }
    const table = $.ui.resolve(e)
    return <table.Box flexDirection="column">{renderModern(table, data)}{below}</table.Box>
  })
}
