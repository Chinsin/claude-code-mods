import type { StepStatus } from '../types'

// The desktop pane's vector pieces: a status icon per step and the progress
// ring of the header. Motion is SMIL, so it runs with no redraw.

export const ACCENT = '#d97757'
export const DONE = '#5fd38d'
export const BLOCKED = '#f7768e'
export const MUTED = '#9aa0a6'
export const NOTE = '#e0af68'

const n = (v: number) => String(Math.round(v * 100) / 100)
const svg = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
  '<style>:root{color-scheme:light dark}text{font:600 10px -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;fill:#24292f}' +
  '@media (prefers-color-scheme:dark){text{fill:#e6e6e6}}</style>' +
  body +
  '</svg>'

export const ICON = 16

/** A step's status as a 16px icon; only `active` moves (a turning arc). */
export function statusIcon(status: StepStatus): string {
  const c = ICON / 2
  switch (status) {
    case 'pending':
      return svg(ICON, ICON, `<circle cx="${c}" cy="${c}" r="5.5" fill="none" stroke="${MUTED}" stroke-width="1.5"/>`)
    case 'active':
      return svg(
        ICON,
        ICON,
        `<circle cx="${c}" cy="${c}" r="6" fill="none" stroke="${ACCENT}" stroke-opacity=".22" stroke-width="2"/>` +
          `<path d="M${c} ${c - 6} A6 6 0 0 1 ${c + 6} ${c}" fill="none" stroke="${ACCENT}" stroke-width="2" stroke-linecap="round">` +
          `<animateTransform attributeName="transform" type="rotate" from="0 ${c} ${c}" to="360 ${c} ${c}" dur="1s" repeatCount="indefinite"/></path>` +
          `<circle cx="${c}" cy="${c}" r="2" fill="${ACCENT}">` +
          '<animate attributeName="opacity" values="1;.35;1" dur="1.4s" repeatCount="indefinite"/></circle>',
      )
    case 'done':
      return svg(
        ICON,
        ICON,
        `<circle cx="${c}" cy="${c}" r="6.5" fill="${DONE}"/>` +
          `<path d="M5 8.3 L7.1 10.4 L11 6.1" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`,
      )
    case 'skipped':
      return svg(
        ICON,
        ICON,
        `<circle cx="${c}" cy="${c}" r="5.5" fill="none" stroke="${MUTED}" stroke-width="1.5"/>` +
          `<path d="M4.4 11.6 L11.6 4.4" stroke="${MUTED}" stroke-width="1.5" stroke-linecap="round"/>`,
      )
    case 'blocked':
      return svg(
        ICON,
        ICON,
        `<circle cx="${c}" cy="${c}" r="6.5" fill="${BLOCKED}"/>` +
          `<path d="M${c} 4.6 V9" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>` +
          `<circle cx="${c}" cy="11.4" r="1.05" fill="#fff"/>`,
      )
  }
}

export const RING = 40

/**
 * The header's progress ring: the share of steps settled, sweeping from
 * `from` to `to` (0..1) with the figure in its middle; green once complete.
 */
export function progressRing(from: number, to: number, active: boolean): string {
  const c = RING / 2
  const r = 15.5
  const length = 2 * Math.PI * r
  const offset = (k: number) => n(length * (1 - Math.max(0, Math.min(1, k))))
  const isComplete = to >= 1
  const stroke = isComplete ? DONE : 'url(#g)'
  const sweep =
    from === to
      ? ''
      : `<animate attributeName="stroke-dashoffset" from="${offset(from)}" to="${offset(to)}" dur=".9s" fill="freeze" ` +
        'calcMode="spline" keyTimes="0;1" keySplines=".22 1 .36 1"/>'
  // While a step runs, a faint halo turns around the ring.
  const halo = active && !isComplete
    ? `<circle cx="${c}" cy="${c}" r="${r + 3.5}" fill="none" stroke="${ACCENT}" stroke-opacity=".18" stroke-width="1" stroke-dasharray="3 5">` +
      `<animateTransform attributeName="transform" type="rotate" from="0 ${c} ${c}" to="360 ${c} ${c}" dur="12s" repeatCount="indefinite"/></circle>`
    : ''
  return svg(
    RING,
    RING,
    `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${ACCENT}"/><stop offset="1" stop-color="#e8a33d"/></linearGradient>` +
      halo +
      `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#808080" stroke-opacity=".2" stroke-width="3.5"/>` +
      `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${stroke}" stroke-width="3.5" stroke-linecap="round" ` +
      `stroke-dasharray="${n(length)}" stroke-dashoffset="${offset(to)}" transform="rotate(-90 ${c} ${c})">${sweep}</circle>` +
      // Complete, a check takes the middle: "100%" would crowd the ring.
      (isComplete
        ? `<path d="M${c - 5.5} ${c + 0.5} L${c - 1.5} ${c + 4.5} L${c + 6} ${c - 4}" fill="none" stroke="${DONE}" ` +
          'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'
        : `<text x="${c}" y="${c + 3.5}" text-anchor="middle">${Math.round(to * 100)}%</text>`),
  )
}
