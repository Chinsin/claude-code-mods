import type { PulseFrame, PulseLimit } from '../types'

// The desktop band as vector meters: one small SVG per meter, every motion in
// SMIL, so the drawing keeps moving (bars easing in, a sheen, the cache bar
// draining, an odometer countdown) with no redraw from the plugin. A redraw
// comes only when a figure changes, and eases from the figure shown before.

export type SvgMeter = {
  key: string
  source: string
  width: number
  height: number
  alt: string
  /** The hover row's line; times in it are absolute, so it never goes stale. */
  detail: string
  tone: string
}

const H = 20
const BASE = 14
const BAR_Y = 8
const BAR_H = 4
const BAR_W = 52
const GAP = 6
const CHAR = 6.7
// Bold figures run wider than the labels' lowercase.
const FIGURE = 7.8
const DIGIT = 7.4
const LINE = 14

const CONTEXT = ['#7aa2f7', '#9d8cf5', '#d97757']
const LIMIT = ['#73daca', '#9ece6a', '#e0af68', '#f7768e']
const CACHE_COLD = '#ef5b5b'
const CACHE_MID = '#f2c14e'
const CACHE_WARM = '#5fd38d'
export const ACCENT = '#d97757'
const DANGER = '#f7768e'
const WARN = '#e0af68'
const EASE = 'calcMode="spline" keyTimes="0;1" keySplines=".22 1 .36 1"'

const LIMIT_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
const LIMIT_NAME: Record<string, string> = {
  five_hour: '5-hour window',
  seven_day: '7-day window',
  spend_limit: 'spend limit',
}
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const STYLE =
  '<style>' +
  ':root{color-scheme:light dark}' +
  'text{font:12px -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif;font-variant-numeric:tabular-nums}' +
  '.l{fill:#8b8f96}.v{fill:#24292f;font-weight:600}.c{font-weight:600}.d{fill:#8b8f96;font-weight:400}' +
  '@media (prefers-color-scheme:dark){.v{fill:#e6e6e6}}' +
  '</style>'

type Rgb = [number, number, number]
const hex = (c: string): Rgb => [
  parseInt(c.slice(1, 3), 16),
  parseInt(c.slice(3, 5), 16),
  parseInt(c.slice(5, 7), 16),
]
const toHex = ([r, g, b]: Rgb) =>
  '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
const mix = (a: Rgb, b: Rgb, k: number): Rgb => [
  a[0] + (b[0] - a[0]) * k,
  a[1] + (b[1] - a[1]) * k,
  a[2] + (b[2] - a[2]) * k,
]
const ramp = (stops: string[], k: number): string => {
  const rgb = stops.map(hex)
  const x = Math.max(0, Math.min(1, k)) * (rgb.length - 1)
  const i = Math.min(rgb.length - 2, Math.floor(x))
  return toHex(mix(rgb[i]!, rgb[i + 1]!, x - i))
}
const cacheTone = (k: number) =>
  k > 0.5
    ? toHex(mix(hex(CACHE_MID), hex(CACHE_WARM), (k - 0.5) * 2))
    : toHex(mix(hex(CACHE_COLD), hex(CACHE_MID), Math.max(0, k) * 2))

const n = (v: number) => String(Math.round(v * 100) / 100)
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function compact(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 100_000 ? 0 : 1)}k`
  return String(Math.round(v))
}

function spanText(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h${String(m % 60).padStart(2, '0')}`
  return `${Math.floor(h / 24)}d${h % 24}h`
}

export function when(at: number, now: number, withSeconds = false): string {
  const d = new Date(at)
  const pad = (v: number) => String(v).padStart(2, '0')
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}${withSeconds ? `:${pad(d.getSeconds())}` : ''}`
  return Math.abs(at - now) > 20 * 3_600_000 ? `${WEEKDAYS[d.getDay()]} ${time}` : time
}

const svg = (width: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}" height="${H}" viewBox="0 0 ${n(width)} ${H}">${STYLE}${body}</svg>`

const textWidth = (s: string) => s.length * CHAR
const figureWidth = (s: string) => s.length * FIGURE

// The label, the track and its clip; `fill` draws what goes on the track.
function frameOf(label: string) {
  const barX = textWidth(label) + GAP
  return {
    barX,
    valueX: barX + BAR_W + GAP + 1,
    head:
      `<text class="l" x="0" y="${BASE}">${esc(label)}</text>` +
      `<rect x="${n(barX)}" y="${BAR_Y}" width="${BAR_W}" height="${BAR_H}" rx="2" fill="#808080" fill-opacity=".22"/>` +
      `<clipPath id="t"><rect x="${n(barX)}" y="${BAR_Y}" width="${BAR_W}" height="${BAR_H}" rx="2"/></clipPath>`,
  }
}

// A gradient fill easing from `from` to `to` (0..1), a sheen sweeping over it.
function easedFill(barX: number, stops: string[], from: number, to: number, sweepAt: number): string {
  const w0 = Math.max(0, Math.min(1, from)) * BAR_W
  const w1 = Math.max(0, Math.min(1, to)) * BAR_W
  const grow = `<animate attributeName="width" from="${n(w0)}" to="${n(w1)}" dur=".9s" fill="freeze" ${EASE}/>`
  const gradient =
    `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="${n(barX)}" x2="${n(barX + BAR_W)}">` +
    stops.map((c, i) => `<stop offset="${n(i / Math.max(1, stops.length - 1))}" stop-color="${c}"/>`).join('') +
    '</linearGradient>' +
    '<linearGradient id="s"><stop offset="0" stop-color="#fff" stop-opacity="0"/>' +
    '<stop offset=".5" stop-color="#fff" stop-opacity=".5"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>'
  return (
    gradient +
    `<clipPath id="f"><rect x="${n(barX)}" y="${BAR_Y}" width="${n(w1)}" height="${BAR_H}" rx="2">${grow}</rect></clipPath>` +
    `<rect x="${n(barX)}" y="${BAR_Y}" width="${n(w1)}" height="${BAR_H}" rx="2" fill="url(#g)">${grow}</rect>` +
    `<rect y="${BAR_Y}" width="16" height="${BAR_H}" fill="url(#s)" clip-path="url(#f)">` +
    `<animate attributeName="x" values="${n(barX - 16)};${n(barX + BAR_W)};${n(barX + BAR_W)}" keyTimes="0;.45;1" ` +
    `dur="3.6s" begin="${n(sweepAt)}s" repeatCount="indefinite"/></rect>`
  )
}

// mm:ss counting down from `leftMs`, each digit a strip rolled by SMIL.
// Seconds roll on a 10 s and a 60 s loop phased to the wall clock; minutes
// step at their exact times; the whole counter hides when it reaches zero.
// `inner` rides inside the counter's group (its recolor, pulse and hiding).
function odometer(x: number, leftMs: number, color: string, inner: string): { body: string; width: number } {
  const secs = Math.ceil(leftMs / 1000)
  // Time until the counter first ticks over, then a tick every second.
  const firstTick = leftMs - (secs - 1) * 1000
  const begin = n(firstTick / 1000 - 1)
  const minutes = Math.floor(secs / 60)
  const minW = 2 * DIGIT
  const colonX = x + minW + 1
  const tensX = colonX + 4
  const onesX = tensX + DIGIT
  const width = onesX + DIGIT - x
  const clip = (id: string, cx: number, w: number) =>
    `<clipPath id="${id}"><rect x="${n(cx)}" y="2" width="${n(w)}" height="${LINE + 2}"/></clipPath>`

  // Digit strip: digit d sits d lines down; showing d is translating by -d lines.
  const strip = (cx: number) =>
    Array.from({ length: 10 }, (_, d) => `<text x="${n(cx + DIGIT / 2)}" y="${BASE + d * LINE}" text-anchor="middle">${d}</text>`).join('')
  const roll = (digits: number[], period: number) =>
    `<animateTransform attributeName="transform" type="translate" calcMode="discrete" ` +
    `values="${digits.map(d => `0 ${-d * LINE}`).join(';')}" dur="${period}s" begin="${begin}s" repeatCount="indefinite"/>`
  const ones = Array.from({ length: 10 }, (_, k) => (((secs - k) % 10) + 10) % 10)
  const tens = Array.from({ length: 60 }, (_, k) => Math.floor(((((secs - k) % 60) + 60) % 60) / 10))

  // Minutes: a strip of whole numbers, stepped when each minute runs out.
  const minuteLabels = Array.from({ length: minutes + 1 }, (_, j) => minutes - j)
  let minuteRoll = ''
  if (minutes > 0) {
    const times = [0]
    for (let j = 1; j <= minutes; j++) {
      const tick = secs - 60 * (minutes - j + 1) + 1
      times.push((firstTick + (tick - 1) * 1000) / leftMs)
    }
    minuteRoll =
      `<animateTransform attributeName="transform" type="translate" calcMode="discrete" ` +
      `values="${minuteLabels.map((_, j) => `0 ${-j * LINE}`).join(';')}" ` +
      `keyTimes="${times.map(t => Math.min(0.99999, Math.max(0, t)).toFixed(5)).join(';')}" ` +
      `dur="${n(leftMs / 1000)}s" fill="freeze"/>`
  }
  const body =
    clip('m', x, minW) +
    clip('a', tensX, DIGIT) +
    clip('b', onesX, DIGIT) +
    `<g class="c" fill="${color}">${inner}` +
    `<g clip-path="url(#m)"><g>${minuteLabels
      .map((label, j) => `<text x="${n(x + minW)}" y="${BASE + j * LINE}" text-anchor="end">${label}</text>`)
      .join('')}${minuteRoll}</g></g>` +
    `<text x="${n(colonX)}" y="${BASE - 1}">:</text>` +
    `<g clip-path="url(#a)"><g>${strip(tensX)}${roll(tens, 60)}</g></g>` +
    `<g clip-path="url(#b)"><g>${strip(onesX)}${roll(ones, 10)}</g></g>` +
    '</g>'
  return { body, width }
}

function cacheMeter(frame: PulseFrame, now: number): SvgMeter {
  const cache = frame.cache
  const { barX, valueX, head } = frameOf('cache')
  const ttl = `prompt cache · ${frame.ttlLabel} TTL`
  const total = cache.readTokens + cache.writeTokens
  const io =
    total > 0
      ? ` · last response read ${compact(cache.readTokens)}, wrote ${compact(cache.writeTokens)} (${Math.round((cache.readTokens / total) * 100)}% hit)`
      : ''
  const warm = frame.warmMax > 0 ? ` · keep-warm ${cache.warmed ?? 0}/${frame.warmMax}` : ' · keep-warm off'
  const base = { key: 'cache', height: H }
  const word = (text: string, color: string, extra = '') => ({
    body: `<text class="v" x="${n(valueX)}" y="${BASE}" style="fill:${color}">${text}${extra}</text>`,
    width: valueX + figureWidth(text) + 4,
  })

  if (frame.isWorking) {
    const scan =
      '<linearGradient id="k"><stop offset="0" stop-color="' + CACHE_WARM + '" stop-opacity="0"/>' +
      '<stop offset=".5" stop-color="' + CACHE_WARM + '"/><stop offset="1" stop-color="' + CACHE_WARM + '" stop-opacity="0"/></linearGradient>' +
      `<rect y="${BAR_Y}" width="22" height="${BAR_H}" fill="url(#k)" clip-path="url(#t)">` +
      `<animate attributeName="x" values="${n(barX - 11)};${n(barX + BAR_W - 11)};${n(barX - 11)}" keyTimes="0;.5;1" ` +
      `calcMode="spline" keySplines=".45 0 .55 1;.45 0 .55 1" dur="1.8s" repeatCount="indefinite"/></rect>`
    const live = word('live', CACHE_WARM, '<animate attributeName="opacity" values="1;.45;1" dur="1.4s" repeatCount="indefinite"/>')
    return {
      ...base,
      source: svg(live.width, head + scan + live.body),
      width: live.width,
      alt: 'cache live',
      detail: `${ttl} · every response of this turn refreshes it${io}`,
      tone: CACHE_WARM,
    }
  }
  if (cache.lastHitAt === null) {
    const none = word('—', '#8b8f96')
    return {
      ...base,
      source: svg(none.width, head + none.body),
      width: none.width,
      alt: 'cache empty',
      detail: `${ttl} · nothing cached yet; the first response writes it`,
      tone: CACHE_WARM,
    }
  }
  const expiresAt = cache.lastHitAt + frame.ttlMs
  const left = expiresAt - now
  const resend = frame.usage?.contextTokens
  const coldDetail = `${ttl} · expired at ${when(expiresAt, now)}${resend ? ` · next prompt re-writes ~${compact(resend)} tokens` : ''}${warm}`
  if (left <= 0) {
    const cold = word('cold', CACHE_COLD)
    return {
      ...base,
      source: svg(cold.width, head + cold.body),
      width: cold.width,
      alt: 'cache cold',
      detail: coldDetail,
      tone: CACHE_COLD,
    }
  }

  // Warm: the bar drains to nothing over what is left, shifting green to red,
  // and pulses through its last minute; then the counter gives way to "cold".
  const k = left / frame.ttlMs
  const secs = n(left / 1000)
  const tones = Array.from({ length: 6 }, (_, i) => cacheTone(k * (1 - i / 5)))
  const recolor = `<animate attributeName="fill" values="${tones.join(';')}" dur="${secs}s" fill="freeze"/>`
  const urgentAt = n(Math.max(0, left - 60_000) / 1000)
  const pulse = `<animate attributeName="opacity" values="1;.4;1" dur="1s" begin="${urgentAt}s" end="${secs}s" repeatCount="indefinite"/>`
  const bar =
    `<rect x="${n(barX)}" y="${BAR_Y}" width="${n(k * BAR_W)}" height="${BAR_H}" rx="2" fill="${tones[0]}">` +
    `<animate attributeName="width" from="${n(k * BAR_W)}" to="0" dur="${secs}s" fill="freeze"/>${recolor}${pulse}</rect>`
  const counter = odometer(
    valueX,
    left,
    tones[0]!,
    recolor + pulse + `<set attributeName="visibility" to="hidden" begin="${secs}s" fill="freeze"/>`,
  )
  const cold =
    `<text class="v" x="${n(valueX)}" y="${BASE}" style="fill:${CACHE_COLD}" visibility="hidden">cold` +
    `<set attributeName="visibility" to="visible" begin="${secs}s" fill="freeze"/></text>`
  const width = valueX + Math.max(counter.width, figureWidth('cold')) + 4
  return {
    ...base,
    source: svg(width, head + bar + counter.body + cold),
    width,
    alt: `cache ${Math.ceil(left / 60000)} minutes left`,
    detail: `${ttl} · expires at ${when(expiresAt, now, true)}${io}${warm}`,
    tone: tones[0]!,
  }
}

/**
 * The desktop meters for a frame. `shown` holds the fills last drawn, keyed
 * like the meters; the call eases from them and writes the new ones back.
 */
export function svgMeters(frame: PulseFrame, now: number, shown: Record<string, number>): SvgMeter[] {
  const usage = frame.usage
  const meters: SvgMeter[] = []

  const ctxFill = usage?.contextPercent !== undefined ? usage.contextPercent / 100 : 0
  {
    const { barX, valueX, head } = frameOf('ctx')
    const pct = Math.round(ctxFill * 100)
    const value = usage?.contextPercent !== undefined ? `${pct}%` : '—'
    const color = pct >= 80 ? DANGER : ''
    const width = valueX + figureWidth(value) + 4
    meters.push({
      key: 'ctx',
      height: H,
      width,
      source: svg(
        width,
        head +
          easedFill(barX, CONTEXT, shown.ctx ?? 0, ctxFill, 0) +
          `<text class="v" x="${n(valueX)}" y="${BASE}"${color ? ` style="fill:${color}"` : ''}>${value}</text>`,
      ),
      alt: `context ${value}`,
      detail:
        usage?.contextTokens !== undefined
          ? `context window · ${compact(usage.contextTokens)} of ${compact(usage.contextWindow)} tokens used · ${compact(Math.max(0, usage.contextWindow - usage.contextTokens))} free`
          : `context window · ${compact(usage?.contextWindow ?? 0)} tokens · filled once the first response arrives`,
      tone: ramp(CONTEXT, ctxFill),
    })
    shown.ctx = ctxFill
  }

  ;(usage?.limits ?? []).forEach((limit: PulseLimit, i) => {
    const key = `limit:${limit.kind}`
    const label = LIMIT_LABEL[limit.kind] ?? limit.kind
    const fill = Math.min(1, limit.percent / 100)
    const { barX, valueX, head } = frameOf(label)
    const value = `${limit.percent.toFixed(limit.percent < 10 ? 1 : 0)}%`
    const at = limit.resetsAt !== undefined ? Date.parse(limit.resetsAt) : NaN
    const resets = !Number.isNaN(at) && at > now
    const reset = limit.percent >= 80 && resets ? ` ↻${spanText(at - now)}` : ''
    const color = limit.percent >= 90 ? DANGER : limit.percent >= 70 ? WARN : ''
    const width = valueX + figureWidth(value) + textWidth(reset) + 6
    meters.push({
      key,
      height: H,
      width,
      source: svg(
        width,
        head +
          easedFill(barX, LIMIT, shown[key] ?? 0, fill, 0.9 * (i + 1)) +
          `<text class="v" x="${n(valueX)}" y="${BASE}"${color ? ` style="fill:${color}"` : ''}>${value}` +
          (reset ? `<tspan class="d">${esc(reset)}</tspan>` : '') +
          '</text>',
      ),
      alt: `${label} limit ${value}`,
      detail: `${LIMIT_NAME[limit.kind] ?? limit.kind} · ${limit.percent}% used${resets ? ` · resets at ${when(at, now)}` : ''}`,
      tone: ramp(LIMIT, fill),
    })
    shown[key] = fill
  })

  meters.push(cacheMeter(frame, now))
  return meters
}

/** The breathing dot that leads the line; it quickens while a turn runs. */
export function dotSvg(isWorking: boolean): string {
  const dur = isWorking ? '1s' : '2.8s'
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="${H}" viewBox="0 0 10 ${H}">` +
    `<circle cx="5" cy="10" r="3.4" fill="${ACCENT}">` +
    `<animate attributeName="r" values="3;4;3" dur="${dur}" repeatCount="indefinite"/>` +
    `<animate attributeName="opacity" values=".65;1;.65" dur="${dur}" repeatCount="indefinite"/>` +
    '</circle></svg>'
  )
}

/**
 * The keep-warm switch: a pill track and a knob in the meters' own style.
 * The knob slides and the track recolors from `wasOn` to `isOn`; while on,
 * a soft halo breathes around the track and the budget used rides beside it.
 */
export function switchSvg(isOn: boolean, wasOn: boolean, used: number, max: number): { source: string; width: number } {
  const label = '保溫'
  const trackX = 2 * 12 + 6
  const trackW = 26
  const trackH = 14
  const trackY = (H - trackH) / 2
  const knobR = 5.5
  const offX = trackX + trackH / 2
  const onX = trackX + trackW - trackH / 2
  const offFill = '#9aa0a6'
  const count = isOn ? `${used}/${max}` : ''
  const width = trackX + trackW + (count ? GAP + figureWidth(count) : 0) + 4
  const slide = (from: string, to: string, attr: string) =>
    from === to ? '' : `<animate attributeName="${attr}" from="${from}" to="${to}" dur=".28s" fill="freeze" ${EASE}/>`
  const track = isOn ? CACHE_WARM : offFill
  const halo = isOn
    ? `<rect x="${n(trackX - 2.5)}" y="${n(trackY - 2.5)}" width="${trackW + 5}" height="${trackH + 5}" rx="${n(trackH / 2 + 2.5)}" ` +
      `fill="none" stroke="${CACHE_WARM}" stroke-width="1" opacity="0">` +
      '<animate attributeName="opacity" values="0;.3;0" dur="3s" begin=".3s" repeatCount="indefinite"/></rect>'
    : ''
  const source = svg(
    width,
    `<text class="l" x="0" y="${BASE}">${label}</text>` +
      halo +
      `<rect x="${n(trackX)}" y="${n(trackY)}" width="${trackW}" height="${trackH}" rx="${n(trackH / 2)}" ` +
      `fill="${track}" fill-opacity="${isOn ? '1' : '.45'}">` +
      slide(wasOn ? CACHE_WARM : offFill, track, 'fill') +
      slide(wasOn ? '1' : '.45', isOn ? '1' : '.45', 'fill-opacity') +
      '</rect>' +
      `<circle cx="${n(isOn ? onX : offX)}" cy="${H / 2}" r="${knobR}" fill="#fff" ` +
      'style="filter:drop-shadow(0 .5px 1px rgba(0,0,0,.35))">' +
      slide(n(wasOn ? onX : offX), n(isOn ? onX : offX), 'cx') +
      '</circle>' +
      (count ? `<text class="d" x="${n(trackX + trackW + GAP)}" y="${BASE}">${count}</text>` : ''),
  )
  return { source, width }
}
