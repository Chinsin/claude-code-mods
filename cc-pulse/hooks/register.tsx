import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, SessionMeasureInput, SessionUsage } from 'claude-code'

import type { PulseCache, PulseFrame, PulseUsage } from '../types'
import { ACCENT, compact, dotSvg, svgMeters, switchSvg } from './svg'

const usageAtom = atom({ plugin: 'cc-pulse', key: 'usage' } as const, null)
const cacheAtom = atom({ plugin: 'cc-pulse', key: 'cache' } as const, {
  lastHitAt: null,
  readTokens: 0,
  writeTokens: 0,
  learnedTtl: null,
  warmed: 0,
} as PulseCache)
const hiddenAtom = atom({ plugin: 'cc-pulse', key: 'isHidden' } as const, false)
const warmChoiceAtom = atom({ plugin: 'cc-pulse', key: 'warmChoice' } as const, null as 'on' | 'off' | null)

const TTL_MS = { '5m': 5 * 60_000, '1h': 60 * 60_000 } as const
const WARN_MS = 60_000
// Keep-warm pings this long before expiry, leaving room for a slow request.
const WARM_LEAD_MS = 30_000
const WARM_PROMPT = 'Keep-alive ping from a status plugin; reply with just: ok'
// A hit after this long idle can only have come from a 1h cache.
const LONG_GAP_MS = TTL_MS['5m'] + 30_000

type Ttl = keyof typeof TTL_MS

export function toPulseUsage(u: SessionUsage | SessionMeasureInput): PulseUsage {
  return {
    contextTokens: u.context.tokens,
    contextWindow: u.context.window,
    contextPercent: u.context.percent,
    limits: u.rateLimits.map(l => ({ kind: l.kind, percent: l.percentUsed, resetsAt: l.resetsAt })),
    costUsd: u.cost?.usd,
  }
}

export function resolveTtl(option: string, learned: Ttl | null, envSaysHour: boolean): Ttl {
  if (option === '5m' || option === '1h') return option
  if (learned) return learned
  return envSaysHour ? '1h' : '5m'
}

type Ctx = {
  ttlOption: string
  shouldWarn: boolean
  envSaysHour: boolean
  isWorking: boolean
  /** Keep-warm pings allowed per idle stretch while it is on. */
  warmLimit: number
  /** Whether a session starts with keep-warm on (the keepWarm setting). */
  isWarmByDefault: boolean
  isWarming: boolean
  warnTimer: { cancel: () => void } | null
  /** The fills the desktop meters last drew, so the next draw eases from them. */
  shown: Record<string, number>
  /** The keep-warm switch as last drawn, so the next draw slides from it. */
  wasWarmOn: boolean
}

function ttlOf(ctx: Ctx, cache: PulseCache): Ttl {
  return resolveTtl(ctx.ttlOption, cache.learnedTtl, ctx.envSaysHour)
}

// Keep-warm's budget now: its limit while the switch is on, else 0.
async function warmMaxOf($: EngineInterface, ctx: Ctx): Promise<number> {
  const choice = await read($, warmChoiceAtom)
  const isOn = choice === null ? ctx.isWarmByDefault : choice === 'on'
  return isOn ? ctx.warmLimit : 0
}

// The 保溫 button: keep-warm on or off for this session. Turning it on gives
// a fresh budget and takes effect on the cache as it stands.
async function toggleWarm($: EngineInterface, ctx: Ctx) {
  const isOn = (await warmMaxOf($, ctx)) > 0
  await update($, warmChoiceAtom, () => (isOn ? 'off' : 'on'))
  const cache = await update($, cacheAtom, c => (isOn ? c : { ...c, warmed: 0 }))
  const now = await $.clock.now()
  await scheduleExpiry($, ctx, cache, now)
  if (isOn) {
    $.ui.toast('已關閉自動保溫。')
  } else {
    const isCold = cache.lastHitAt === null || cache.lastHitAt + TTL_MS[ttlOf(ctx, cache)] <= now
    $.ui.toast(
      `已開啟自動保溫：閒置時在緩存過期前延長，最多 ${ctx.warmLimit} 次。` +
        (isCold ? '目前沒有有效的緩存，下一次回應後開始。' : ''),
    )
  }
}

// Before the cache lapses while idle: keep it warm while the budget lasts,
// else toast a minute ahead, once.
async function scheduleExpiry($: EngineInterface, ctx: Ctx, cache: PulseCache, now: number) {
  ctx.warnTimer?.cancel()
  ctx.warnTimer = null
  if (cache.lastHitAt === null) return
  const expiresAt = cache.lastHitAt + TTL_MS[ttlOf(ctx, cache)]
  const warmed = cache.warmed ?? 0
  const warmMax = await warmMaxOf($, ctx)
  if (warmed < warmMax && expiresAt > now) {
    ctx.warnTimer = $.clock.after(Math.max(0, expiresAt - WARM_LEAD_MS - now), () => {
      if (!ctx.isWorking) void keepWarm($, ctx)
    })
    return
  }
  if (!ctx.shouldWarn) return
  const wait = expiresAt - WARN_MS - now
  if (wait <= 0) return
  const tail = warmMax > 0 ? ` Keep-warm used ${warmed}/${warmMax}.` : ''
  ctx.warnTimer = $.clock.after(wait, () => {
    if (!ctx.isWorking) $.ui.toast(`Prompt cache expires in 1 minute; send a prompt to keep it warm.${tail}`)
  })
}

// One tiny request over the session's own transcript: the API serves the
// prefix from the cache, and reading it starts the TTL over.
async function keepWarm($: EngineInterface, ctx: Ctx) {
  if (ctx.isWarming) return
  ctx.isWarming = true
  try {
    // The switch may have gone off since the timer was set.
    const warmMax = await warmMaxOf($, ctx)
    if (warmMax === 0) return
    const before = await read($, cacheAtom)
    const r = await $.model.fork({ prompt: WARM_PROMPT }).catch((err: unknown) => ({
      isAnswered: false as const,
      reason: err instanceof Error ? err.message : 'the request was refused',
    }))
    const u = 'usage' in r ? r.usage : undefined
    const warmed = (before.warmed ?? 0) + 1
    if (u && u.cache_read_input_tokens > 1024) {
      await recordHit($, ctx, u, warmed)
      $.ui.toast(`Kept the prompt cache warm (${compact(u.cache_read_input_tokens)} tokens) · ${warmed}/${warmMax}`)
    } else {
      // A miss means the entry was gone already; stop spending on it.
      await update($, cacheAtom, c => ({ ...c, warmed: warmMax }))
      const why = r.isAnswered ? 'the cache had already lapsed' : r.reason
      $.ui.toast(`Keep-warm stopped: ${why}.`)
    }
    await refreshUsage($)
  } finally {
    ctx.isWarming = false
  }
}

// The response touched the prompt cache: its TTL starts over from now.
async function recordHit($: EngineInterface, ctx: Ctx, u: ModelUsage, warmed?: number) {
  const now = await $.clock.now()
  const prev = await read($, cacheAtom)
  let learnedTtl = prev.learnedTtl
  if (
    prev.lastHitAt !== null &&
    now - prev.lastHitAt > LONG_GAP_MS &&
    now - prev.lastHitAt < TTL_MS['1h'] &&
    u.cache_read_input_tokens > 1024
  ) {
    learnedTtl = '1h'
    await $.store.set('learnedTtl', '1h')
  }
  const cache: PulseCache = {
    lastHitAt: now,
    readTokens: u.cache_read_input_tokens,
    writeTokens: u.cache_creation_input_tokens + u.input_tokens,
    learnedTtl,
    warmed: warmed ?? prev.warmed ?? 0,
  }
  await update($, cacheAtom, () => cache)
  await scheduleExpiry($, ctx, cache, now)
}

// The figures after a response; a failed read leaves the last ones standing.
async function refreshUsage($: EngineInterface) {
  try {
    const usage = await $.session.usage()
    await update($, usageAtom, () => toPulseUsage(usage))
  } catch {
    // keep what the band shows
  }
}

export const register: Register = (on, options) => {
  const ctx: Ctx = {
    ttlOption: String(options.cacheTtl ?? 'auto'),
    shouldWarn: options.warnBeforeExpiry !== false,
    warmLimit: Math.max(1, Math.floor(Number(options.keepWarmMax ?? 3))),
    isWarmByDefault: options.keepWarm === true,
    isWarming: false,
    shown: {},
    wasWarmOn: false,
    envSaysHour: false,
    isWorking: false,
    warnTimer: null,
  }

  on('session.start', async ($, e, next) => {
    // A reload runs this again: redraw the band with the module now loaded.
    $.ui.invalidate('ui.render')
    const flag = (await $.env.get('ENABLE_PROMPT_CACHING_1H')) ?? ''
    ctx.envSaysHour = flag !== '' && flag !== '0' && flag.toLowerCase() !== 'false'

    const stored = await $.store.get('learnedTtl')
    if (stored === '5m' || stored === '1h') {
      const learned: Ttl = stored
      await update($, cacheAtom, c => (c.learnedTtl ? c : { ...c, learnedTtl: learned }))
    }

    await $.command.register({
      name: 'pulse',
      description: 'Show or hide the animated usage and cache band',
    })
    const usage = await $.session.usage()
    await update($, usageAtom, () => toPulseUsage(usage))

    const now = await $.clock.now()
    await scheduleExpiry($, ctx, await read($, cacheAtom), now)

    return next(e)
  })

  on('command.run', { command: 'pulse' }, async $ => {
    const isHidden = await update($, hiddenAtom, h => !h)
    return { text: isHidden ? 'Pulse band hidden.' : 'Pulse band shown.' }
  })

  // The terminal band's 保溫 button, posted from its Client module.
  on('ui.message', async ($, e, next) => {
    const data = e.data as { action?: string } | null
    if (data?.action === 'toggle-warm' && (e.module.endsWith('pulse.tsx') || e.module.endsWith('hit.tsx'))) {
      await toggleWarm($, ctx)
      return {}
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, usageAtom, () => toPulseUsage(e))
    return next(e)
  })

  // Engine's own word on the cache TTL, whenever a model switch reports it.
  on('classic.PreModelSwitch', async ($, e, next) => {
    const ttl = e.cache_ttl
    if (ttl === '5m' || ttl === '1h') {
      await update($, cacheAtom, c => ({ ...c, learnedTtl: ttl }))
      await $.store.set('learnedTtl', ttl)
    }
    return next(e)
  })

  // A turn of the person's own refreshes the cache and the keep-warm budget.
  on('turn.start', async ($, e, next) => {
    ctx.isWorking = true
    await update($, cacheAtom, c => ((c.warmed ?? 0) === 0 ? c : { ...c, warmed: 0 }))
    return next(e)
  })

  // Every main-thread response moves the figures and refreshes the prompt
  // cache's TTL, so the band follows a turn step by step.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId !== undefined || !result.usage) return result
    const u = result.usage
    if (u.cache_read_input_tokens + u.cache_creation_input_tokens > 0) {
      await recordHit($, ctx, u)
    }
    await refreshUsage($)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      ctx.isWorking = false
      await refreshUsage($)
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.view.agentId !== undefined || (await read($, hiddenAtom))) {
      return next(e)
    }
    const cache = await read($, cacheAtom)
    const ttl = ttlOf(ctx, cache)
    const frame: PulseFrame = {
      surface: e.surface,
      now: await $.clock.now(),
      isWorking: e.props.isWorking,
      usage: await read($, usageAtom),
      cache,
      ttlMs: TTL_MS[ttl],
      ttlLabel: ttl,
      warmMax: await warmMaxOf($, ctx),
    }

    if (e.surface === 'desktop') {
      const { Box, Client, Svg, Text } = $.ui.resolve(e)
      const meters = svgMeters(frame, frame.now, ctx.shown)
      const cost = frame.usage?.costUsd
      const scopeOf = (key: string) => `cc-pulse:${key}`
      const isWarmOn = frame.warmMax > 0
      const used = cache.warmed ?? 0
      const toggle = switchSvg(isWarmOn, ctx.wasWarmOn, used, frame.warmMax)
      ctx.wasWarmOn = isWarmOn
      const warmDetail = isWarmOn
        ? `自動保溫 · 開 · 這段閒置已延長 ${used}/${frame.warmMax} 次 · 緩存過期前 30 秒送出一個極短請求 · 點一下關閉`
        : `自動保溫 · 關 · 點一下開啟：閒置時在緩存過期前延長，最多 ${ctx.warmLimit} 次（每次按緩存讀取計費）`
      const details = [
        ...meters.map(m => ({ key: m.key, tone: m.tone, text: m.detail })),
        { key: 'warm', tone: isWarmOn ? '#5fd38d' : '#9aa0a6', text: warmDetail },
        ...(cost !== undefined
          ? [{ key: 'cost', tone: ACCENT, text: `$${cost.toFixed(2)} spent this session, as /cost totals it` }]
          : []),
      ]
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={2}>
            <Svg key="dot" source={dotSvg(frame.isWorking)} alt="pulse" width={10} height={20} isInteractive />
            {meters.map(m => (
              <Box key={m.key} hover={{ scope: scopeOf(m.key) }}>
                <Svg source={m.source} alt={m.alt} width={m.width} height={m.height} isInteractive />
              </Box>
            ))}
            <Box key="warm" hover={{ scope: scopeOf('warm') }}>
              <Svg
                source={toggle.source}
                alt={isWarmOn ? `keep-warm on ${used}/${frame.warmMax}` : 'keep-warm off'}
                width={toggle.width}
                height={20}
                isInteractive
              />
              {/* The SVG takes no press: a transparent region over it does. */}
              <Box position="absolute" top={0} left={0} width="100%" height="100%">
                <Client key="warm-hit" module="./hit.tsx" props={{ action: 'toggle-warm' }} width="100%" height="100%" />
              </Box>
            </Box>
            {cost !== undefined && (
              <Box key="cost" hover={{ scope: scopeOf('cost') }}>
                <Text dimColor hover={{ scope: scopeOf('cost'), dimColor: false }}>
                  ${cost.toFixed(2)}
                </Text>
              </Box>
            )}
          </Box>
          {details.map(d => (
            <Box
              key={`detail:${d.key}`}
              display="none"
              hover={{ scope: scopeOf(d.key), display: 'flex' }}
              flexDirection="row"
            >
              <Text color={d.tone}>{'  ▸ '}</Text>
              <Text dimColor wrap="truncate">
                {d.text}
              </Text>
            </Box>
          ))}
        </Box>
      )
    }

    if (e.surface === 'terminal') {
      const { Client } = $.ui.resolve(e)
      return (
        <Client
          key="pulse"
          module="./pulse.tsx"
          props={frame}
          width={e.props.bodyColumns}
        />
      )
    }

    // Surfaces without a Client: one still line.
    const { Text } = $.ui.resolve(e)
    const u = frame.usage
    const parts = [
      u?.contextPercent !== undefined ? `context ${u.contextPercent}%` : null,
      ...(u?.limits ?? []).map(l => `${l.kind} ${l.percent}%`),
      cache.lastHitAt !== null
        ? `cache ${Math.max(0, Math.ceil((cache.lastHitAt + frame.ttlMs - frame.now) / 60000))}m left`
        : null,
    ].filter(Boolean)
    return <Text dimColor>{parts.join(' · ')}</Text>
  })
}
