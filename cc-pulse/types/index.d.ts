export type PulseLimit = { kind: string; percent: number; resetsAt?: string }

export type PulseUsage = {
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  limits: PulseLimit[]
  costUsd?: number
}

export type PulseCache = {
  /** Epoch ms of the last main-thread response that touched the cache. */
  lastHitAt: number | null
  /** Tokens that response read from / wrote to the prompt cache. */
  readTokens: number
  writeTokens: number
  /** A TTL learned from the engine or from a hit after a long gap. */
  learnedTtl: '5m' | '1h' | null
  /** Keep-warm pings sent since the person's last turn. */
  warmed?: number
}

/** What the hooks module hands the animated Client module as props. */
export type PulseFrame = {
  /** Where the band draws: the desktop lays bars on the cell grid. */
  surface: string
  now: number
  isWorking: boolean
  usage: PulseUsage | null
  cache: PulseCache
  ttlMs: number
  ttlLabel: string
  /** Keep-warm pings allowed per idle stretch; 0 while keep-warm is off. */
  warmMax: number
}

declare module 'claude-code' {
  interface PluginState {
    'cc-pulse': {
      usage: PulseUsage | null
      cache: PulseCache
      isHidden: boolean
      /** The person's keep-warm switch this session; null follows the setting. */
      warmChoice: 'on' | 'off' | null
    }
  }
}
