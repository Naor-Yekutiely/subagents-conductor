export type Track = {
  description: string
  color: number
  status: string
  startedAt: number
  phase: 'think' | 'tool'
  phaseAt: number
  lastAt: number
  tokens: number
  steps: number
  model?: string
  tool?: string
  action?: string
  prevAction?: string
  reply?: string
  repliedAt?: number
  doneAt?: number
}

export type Size = 'big' | 'small'

declare module 'claude-code' {
  interface PluginState {
    conductor: { tracks: Record<string, Track>; tick: number; size: Size }
  }
}
