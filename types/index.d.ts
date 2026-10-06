export type StatusData = {
  model: string
  effort: string | null
  folder: string
  gitBranch: string | null
  isGitDirty: boolean
  startedAt: number
  contextPercent: number | null
  contextTokens: string
  rateLimit5h: number | null
  rateLimit7d: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'status-band': { data: StatusData | null }
  }
}
