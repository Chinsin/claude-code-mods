import type { ClientModule, JsonValue, RenderElement } from 'claude-code'

import type { PulseFrame } from '../types'

// One compact animated line: context, rate limits, prompt cache, cost.
// Figures ease toward their targets, mini bars carry a soft travelling glow,
// and the cache countdown runs on the wall clock between the hooks module's
// redraws (re-synced to the engine's clock on each one).
//
// The terminal draws bars as block glyphs (its font is monospaced); the
// desktop draws them as colored boxes, since its font is proportional.

const TICK = 80
const EASE = 0.2
const BAR = 6
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

type Box = {
  frame: PulseFrame
  /** Engine time minus wall time, taken when the frame arrived. */
  skew: number
  frameNow: number
  shown: Record<string, number>
}
type State = { box: Box }
type Rgb = [number, number, number]
type Run = { text: string; color?: string; dim?: boolean; bold?: boolean }
type Bar = {
  fill: number
  colorAt: (k: number) => Rgb
  sheen: number | null
  /** Cell position of the working scanner; replaces the fill when set. */
  scan?: number
}
// `detail` is the line a hover over the meter opens beneath the band.
type Meter = { key: string; label: string; bar: Bar; value: Run; detail: string; tone: string }

const hex = (c: string): Rgb => [
  parseInt(c.slice(1, 3), 16),
  parseInt(c.slice(3, 5), 16),
  parseInt(c.slice(5, 7), 16),
]
const toHex = ([r, g, b]: Rgb) =>
  '#' +
  [r, g, b]
    .map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
    .join('')
const mix = (a: Rgb, b: Rgb, k: number): Rgb => [
  a[0] + (b[0] - a[0]) * k,
  a[1] + (b[1] - a[1]) * k,
  a[2] + (b[2] - a[2]) * k,
]
const lighten = (c: Rgb, k: number): Rgb => mix(c, [255, 255, 255], k)
const ramp = (stops: string[], k: number): Rgb => {
  const rgb = stops.map(hex)
  const x = Math.max(0, Math.min(1, k)) * (rgb.length - 1)
  const i = Math.min(rgb.length - 2, Math.floor(x))
  return mix(rgb[i]!, rgb[i + 1]!, x - i)
}

const CONTEXT = ['#7aa2f7', '#9d8cf5', '#d97757']
const LIMIT = ['#73daca', '#9ece6a', '#e0af68', '#f7768e']
const CACHE_COLD = '#ef5b5b'
const CACHE_MID = '#f2c14e'
const CACHE_WARM = '#5fd38d'
const ACCENT = '#d97757'
const DANGER = '#f7768e'
const WARN = '#e0af68'
// Translucent, so the track sits quietly on a light or a dark background.
const TRACK = '#8080803a'
const SCAN_DARK = '#2f5a4a'
const SHEEN_RADIUS = 2
const SHEEN_PEAK = 0.32

const LIMIT_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
const LIMIT_NAME: Record<string, string> = {
  five_hour: '5-hour window',
  seven_day: '7-day window',
  spend_limit: 'spend limit',
}
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// A hover group per meter: the meter heats it, its detail row reveals in it.
const scopeOf = (key: string) => `cc-pulse:${key}`

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

// Local wall time of `at`, with the weekday when it is not within a day.
function when(at: number, now: number, withSeconds = false): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}${withSeconds ? `:${pad(d.getSeconds())}` : ''}`
  return Math.abs(at - now) > 20 * 3_600_000 ? `${WEEKDAYS[d.getDay()]} ${time}` : time
}

const wall = () => Date.now()

function clockText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`
}

function spanText(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h${String(m % 60).padStart(2, '0')}`
  return `${Math.floor(h / 24)}d${h % 24}h`
}

function cellColor(bar: Bar, i: number): Rgb | null {
  if (bar.scan !== undefined) {
    const k = Math.max(0, 1 - Math.abs(i - bar.scan) / 2.5)
    return k > 0 ? mix(hex(SCAN_DARK), hex(CACHE_WARM), k) : null
  }
  let c = bar.colorAt(i / (BAR - 1))
  if (bar.sheen !== null) {
    const d = Math.abs(i - bar.sheen)
    if (d < SHEEN_RADIUS) c = lighten(c, SHEEN_PEAK * ((Math.cos((d / SHEEN_RADIUS) * Math.PI) + 1) / 2))
  }
  return c
}

function push(runs: Run[], run: Run) {
  const last = runs[runs.length - 1]
  if (last && last.color === run.color && last.dim === run.dim && last.bold === run.bold) last.text += run.text
  else runs.push(run)
}

// Terminal: block glyphs, eighth blocks for the fractional cell.
function glyphBar(bar: Bar): Run[] {
  const runs: Run[] = []
  if (bar.scan !== undefined) {
    for (let i = 0; i < BAR; i++) {
      const c = cellColor(bar, i)
      push(runs, c ? { text: '█', color: toHex(c) } : { text: '░', dim: true })
    }
    return runs
  }
  const cells = Math.max(0, Math.min(1, bar.fill)) * BAR
  const whole = Math.floor(cells)
  const part = Math.floor((cells - whole) * 8)
  for (let i = 0; i < whole; i++) push(runs, { text: '█', color: toHex(cellColor(bar, i)!) })
  if (whole < BAR) {
    if (part > 0) push(runs, { text: EIGHTHS[part]!, color: toHex(cellColor(bar, whole)!) })
    const rest = BAR - whole - (part > 0 ? 1 : 0)
    if (rest > 0) push(runs, { text: '░'.repeat(rest), dim: true })
  }
  return runs
}

const Pulse: ClientModule<JsonValue, State> = (props, surface) => {
  const { Box, Button, Text } = surface.elements
  const frame = props as unknown as PulseFrame
  const isGrid = frame.surface === 'desktop'

  let state = surface.state
  if (state === undefined) {
    const box: Box = { frame, skew: frame.now - wall(), frameNow: frame.now, shown: {} }
    state = { box }
    // Seat the state now, so a second call before the first tick cannot
    // start a second timer.
    surface.setState(state)
    surface.every(TICK, () => {
      const targets = targetsOf(box.frame)
      for (const k of Object.keys(targets)) {
        const target = targets[k]!
        const cur = box.shown[k] ?? 0
        box.shown[k] = Math.abs(target - cur) < 0.0005 ? target : cur + (target - cur) * EASE
      }
      surface.setState({ box })
    })
  }
  const box = state.box
  if (frame.now !== box.frameNow) {
    box.frameNow = frame.now
    box.skew = frame.now - wall()
  }
  box.frame = frame

  const now = wall() + box.skew
  const t = wall() / 1000
  const sweep = (period: number, offset = 0) =>
    (((t + offset) % period) / period) * (BAR + SHEEN_RADIUS * 6) - SHEEN_RADIUS * 3

  const usage = frame.usage
  const meters: Meter[] = []

  const ctx = box.shown.ctx ?? 0
  const ctxPct = Math.round(ctx * 100)
  meters.push({
    key: 'ctx',
    label: 'ctx',
    bar: { fill: ctx, colorAt: k => ramp(CONTEXT, k), sheen: sweep(3) },
    value:
      usage?.contextPercent !== undefined
        ? { text: `${ctxPct}%`, bold: true, color: ctxPct >= 80 ? DANGER : undefined }
        : { text: '—', dim: true },
    detail:
      usage?.contextTokens !== undefined
        ? `context window · ${compact(usage.contextTokens)} of ${compact(usage.contextWindow)} tokens used · ${compact(Math.max(0, usage.contextWindow - usage.contextTokens))} free`
        : `context window · ${compact(usage?.contextWindow ?? 0)} tokens · filled once the first response arrives`,
    tone: toHex(ramp(CONTEXT, ctx)),
  })

  ;(usage?.limits ?? []).forEach((limit, i) => {
    const fill = box.shown[`limit:${limit.kind}`] ?? 0
    const pct = fill * 100
    let text = `${pct.toFixed(pct < 10 ? 1 : 0)}%`
    const at = limit.resetsAt !== undefined ? Date.parse(limit.resetsAt) : NaN
    const resets = !Number.isNaN(at) && at > now
    // On the line the reset time shows once the window runs short.
    if (pct >= 80 && resets) text += ` ↻${spanText(at - now)}`
    let detail = `${LIMIT_NAME[limit.kind] ?? limit.kind} · ${limit.percent}% used`
    if (resets) detail += ` · resets in ${spanText(at - now)}, at ${when(at, now)}`
    meters.push({
      key: `limit:${limit.kind}`,
      label: LIMIT_LABEL[limit.kind] ?? limit.kind,
      bar: { fill, colorAt: k => ramp(LIMIT, k), sheen: sweep(3.6, 0.9 * (i + 1)) },
      value: { text, bold: true, color: pct >= 90 ? DANGER : pct >= 70 ? WARN : undefined },
      detail,
      tone: toHex(ramp(LIMIT, fill)),
    })
  })

  meters.push(cacheMeter(frame, now, t, sweep))

  // A breathing dot leads the line; it quickens while a turn runs.
  const breath = (Math.sin(t * (frame.isWorking ? 6 : 2.2)) + 1) / 2
  const dot = toHex(mix(hex(ACCENT), [255, 214, 170], breath * 0.6))
  const cost = usage?.costUsd !== undefined ? `$${(box.shown.cost ?? usage.costUsd).toFixed(2)}` : null
  const costDetail = usage?.costUsd !== undefined ? `$${usage.costUsd.toFixed(2)} spent this session, as /cost totals it` : ''

  const texts = (runs: Run[], scope?: string) =>
    runs.map((r, i) => (
      <Text
        key={String(i)}
        color={r.color}
        dimColor={r.dim}
        bold={r.bold}
        wrap="truncate"
        hover={scope && r.dim ? { scope, dimColor: false } : undefined}
      >
        {r.text}
      </Text>
    ))

  // Hidden rows beneath the line, one per meter, each opened by its meter.
  const details = [
    ...meters.map(m => ({ key: m.key, tone: m.tone, text: m.detail })),
    ...(cost ? [{ key: 'cost', tone: ACCENT, text: costDetail }] : []),
  ].map(d => (
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
  ))

  if (!isGrid) {
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color={dot}>{'● '}</Text>
          {meters.map((m, i) => (
            <Box key={m.key} flexDirection="row" flexShrink={0} hover={{ scope: scopeOf(m.key) }}>
              {texts(
                [{ text: `${i > 0 ? '  ' : ''}${m.label} `, dim: true }, ...glyphBar(m.bar), { text: ' ' }, m.value],
                scopeOf(m.key),
              )}
            </Box>
          ))}
          <Text>{'  '}</Text>
          <Button
            key="warm"
            label={frame.warmMax > 0 ? `━● 保溫 ${frame.cache.warmed ?? 0}/${frame.warmMax}` : '○━ 保溫'}
            plain
            dimColor={frame.warmMax === 0}
            onPress={() => surface.post({ action: 'toggle-warm' })}
          />
          {cost && (
            <Box key="cost" flexDirection="row" flexShrink={0} hover={{ scope: scopeOf('cost') }}>
              {texts([{ text: `  ${cost}`, dim: true }], scopeOf('cost'))}
            </Box>
          )}
        </Box>
        {details}
      </Box>
    )
  }

  const gridBar = (bar: Bar): RenderElement => {
    const fill = bar.scan !== undefined ? 1 : Math.max(0, Math.min(1, bar.fill))
    const cells: RenderElement[] = []
    for (let i = 0; i < Math.min(BAR, Math.ceil(fill * BAR) + 1); i++) {
      const c = cellColor(bar, i)
      cells.push(
        c ? (
          <Box key={String(i)} width={1} height="100%" flexShrink={0} backgroundColor={toHex(c)} />
        ) : (
          <Box key={String(i)} width={1} height="100%" flexShrink={0} />
        ),
      )
    }
    return (
      <Box width={BAR} height={1} alignItems="center" flexShrink={0} marginLeft={1}>
        <Box width="100%" height="34%" backgroundColor={TRACK} flexDirection="row" overflow="hidden">
          <Box width={Math.round(fill * BAR * 100) / 100} height="100%" flexShrink={0} flexDirection="row" overflow="hidden">
            {cells}
          </Box>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
    <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={2}>
      <Text key="dot" color={dot}>●</Text>
      {meters.map(m => (
        <Box key={m.key} flexDirection="row" alignItems="center" flexShrink={0} hover={{ scope: scopeOf(m.key) }}>
          <Text dimColor hover={{ scope: scopeOf(m.key), dimColor: false }}>
            {m.label}
          </Text>
          {gridBar(m.bar)}
          <Box marginLeft={1}>
            <Text color={m.value.color} dimColor={m.value.dim} bold={m.value.bold}>
              {m.value.text}
            </Text>
          </Box>
        </Box>
      ))}
      {cost && (
        <Box key="cost" hover={{ scope: scopeOf('cost') }}>
          <Text dimColor hover={{ scope: scopeOf('cost'), dimColor: false }}>
            {cost}
          </Text>
        </Box>
      )}
    </Box>
    {details}
    </Box>
  )
}

function cacheMeter(frame: PulseFrame, now: number, t: number, sweep: (period: number, offset?: number) => number): Meter {
  const cache = frame.cache
  const base = { key: 'cache', label: 'cache' }
  const ttl = `prompt cache · ${frame.ttlLabel} TTL`
  const total = cache.readTokens + cache.writeTokens
  const io =
    total > 0
      ? ` · last response read ${compact(cache.readTokens)}, wrote ${compact(cache.writeTokens)} (${Math.round((cache.readTokens / total) * 100)}% hit)`
      : ''
  const warm = frame.warmMax > 0 ? ` · keep-warm ${cache.warmed ?? 0}/${frame.warmMax}` : ' · keep-warm off'
  if (frame.isWorking) {
    return {
      ...base,
      bar: { fill: 1, colorAt: () => hex(CACHE_WARM), sheen: null, scan: ((Math.sin(t * 3) + 1) / 2) * (BAR - 1) },
      value: { text: 'live', bold: true, color: CACHE_WARM },
      detail: `${ttl} · every response of this turn refreshes it${io}`,
      tone: CACHE_WARM,
    }
  }
  if (cache.lastHitAt === null) {
    return {
      ...base,
      bar: { fill: 0, colorAt: () => hex(CACHE_WARM), sheen: null },
      value: { text: '—', dim: true },
      detail: `${ttl} · nothing cached yet; the first response writes it`,
      tone: CACHE_WARM,
    }
  }
  const expiresAt = cache.lastHitAt + frame.ttlMs
  const left = expiresAt - now
  if (left <= 0) {
    const resend = frame.usage?.contextTokens
    return {
      ...base,
      bar: { fill: 0, colorAt: () => hex(CACHE_COLD), sheen: null },
      value: { text: 'cold', bold: true, color: CACHE_COLD },
      detail: `${ttl} · expired ${spanText(-left)} ago, at ${when(expiresAt, now)}${resend ? ` · next prompt re-writes ~${compact(resend)} tokens` : ''}${warm}`,
      tone: CACHE_COLD,
    }
  }
  const k = left / frame.ttlMs
  const tone = k > 0.5 ? mix(hex(CACHE_MID), hex(CACHE_WARM), (k - 0.5) * 2) : mix(hex(CACHE_COLD), hex(CACHE_MID), k * 2)
  const urgent = left < 60_000
  const color = lighten(tone, urgent ? ((Math.sin(t * 7) + 1) / 2) * 0.4 : 0)
  return {
    ...base,
    bar: { fill: k, colorAt: () => color, sheen: urgent ? null : sweep(4.5) },
    value: { text: clockText(left), bold: true, color: toHex(color) },
    detail: `${ttl} · expires at ${when(expiresAt, now, true)}${io}${warm}`,
    tone: toHex(tone),
  }
}

function targetsOf(f: PulseFrame): Record<string, number> {
  const out: Record<string, number> = {}
  const u = f.usage
  if (u) {
    out.ctx = u.contextPercent !== undefined ? u.contextPercent / 100 : 0
    if (u.costUsd !== undefined) out.cost = u.costUsd
    for (const l of u.limits) out[`limit:${l.kind}`] = Math.min(1, l.percent / 100)
  }
  return out
}

export default Pulse
