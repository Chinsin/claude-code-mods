import type { StepStatus } from '../types'
import { ACCENT, BLOCKED, DONE, MUTED } from './icons'

// The desktop pane's timeline: one spine down the pane, every step a node on
// it, sub-steps branching off it. Each line of the pane draws its own slice of
// the spine as an SVG taller than any line; the line's box clips it to its own
// height, centred, so the slices join into one rail whatever height a line
// turns out to have. Motion is SMIL, inside each slice.

/** A slice's height in px: taller than a line, clipped to it. */
export const RAIL_H = 40
const MID = RAIL_H / 2
/** Half the height a line is expected to show; motion is timed to it. */
const SEEN = 11
/** The spine's x, and how far each level of sub-steps branches out. */
const SPINE = 11
const BRANCH = 17

/** The cells a line's rail takes before its text, by the step's depth. */
export const railCells = (depth: number) => 3 + depth * 2
const nodeX = (depth: number) => SPINE + depth * BRANCH
const radius = (depth: number) => (depth === 0 ? 6 : 4.2)

/** How one stretch of spine reads: by the step it leaves. */
export type Seg = 'none' | 'todo' | 'done' | 'flow' | 'skip'
/** Which half of a line a stretch of motion covers. */
export type Half = 'up' | 'down' | 'both'

export type RailLine = {
  /** The spine above the line's middle, and below it. */
  up: Seg
  down: Seg
  /** The step's node, on its title's first line. */
  node?: { status: StepStatus; depth: number; freshMs?: number }
  /** A place in the running step's stretch: light flows down it, line by line. */
  wave?: { index: number; count: number; range: Half }
  /** A place in a just-finished step's stretch: green pours down it once. */
  sweep?: { index: number; count: number; range: Half; elapsedMs: number }
}

/** How long a finished node pops and draws its check, and green pours down. */
export const FRESH_MS = 900
export const SWEEP_MS = 800

export const segOf = (status: StepStatus): Seg =>
  status === 'done' ? 'done' : status === 'skipped' ? 'skip' : status === 'active' ? 'flow' : 'todo'

const n = (v: number) => String(Math.round(v * 100) / 100)
const s = (ms: number) => `${n(ms / 1000)}s`

function piece(y1: number, y2: number, seg: Seg): string {
  if (seg === 'none' || y2 - y1 < 0.5) return ''
  const at = `x1="${SPINE}" x2="${SPINE}" y1="${n(y1)}" y2="${n(y2)}" stroke-width="2"`
  switch (seg) {
    case 'done':
      return `<line ${at} stroke="${DONE}"/>`
    case 'flow':
      return `<line ${at} stroke="${ACCENT}" stroke-opacity=".35"/>`
    case 'skip':
      return `<line ${at} stroke="${MUTED}" stroke-opacity=".5" stroke-dasharray="2 3"/>`
    default:
      return `<line ${at} stroke="${MUTED}" stroke-opacity=".35"/>`
  }
}

// keyTimes for a window [a, b] of a cycle, without repeated stops at its ends.
function windowed(a: number, b: number, before: number, from: number, to: number, after: number) {
  const times: number[] = [0]
  const values: number[] = [before]
  if (a > 0) {
    times.push(a)
    values.push(from)
  } else values[0] = from
  times.push(b)
  values.push(to)
  if (b < 1) {
    times.push(1)
    values.push(after)
  }
  return { keyTimes: times.map(t => n(t)).join(';'), values: values.map(v => n(v)).join(';') }
}

function nodeSvg(status: StepStatus, depth: number, freshMs?: number): string {
  const cx = nodeX(depth)
  const r = radius(depth)
  const at = `cx="${n(cx)}" cy="${MID}"`
  switch (status) {
    case 'pending':
      return `<circle ${at} r="${n(r)}" fill="none" stroke="${MUTED}" stroke-width="1.6"/>`
    case 'active':
      // A ripple leaving the node, a breathing core.
      return (
        `<circle ${at} r="${n(r)}" fill="none" stroke="${ACCENT}" stroke-width="1.4" opacity="0">` +
        `<animate attributeName="r" from="${n(r)}" to="${n(r + 4)}" dur="1.8s" repeatCount="indefinite"/>` +
        '<animate attributeName="opacity" values=".7;0" dur="1.8s" repeatCount="indefinite"/></circle>' +
        `<circle ${at} r="${n(r)}" fill="none" stroke="${ACCENT}" stroke-width="2"/>` +
        `<circle ${at} r="${n(r * 0.42)}" fill="${ACCENT}">` +
        '<animate attributeName="opacity" values="1;.35;1" dur="1.4s" repeatCount="indefinite"/></circle>'
      )
    case 'done': {
      const check =
        `M${n(cx - 0.45 * r)} ${n(MID + 0.05 * r)} L${n(cx - 0.1 * r)} ${n(MID + 0.4 * r)} L${n(cx + 0.47 * r)} ${n(MID - 0.33 * r)}`
      if (freshMs === undefined) {
        return (
          `<circle ${at} r="${n(r)}" fill="${DONE}"/>` +
          `<path d="${check}" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
        )
      }
      // Just finished: the node pops, a ring flashes out, the check draws in.
      // Begun in the past by what has elapsed, so a redraw carries on.
      const ago = -freshMs
      return (
        `<circle ${at} r="${n(r)}" fill="none" stroke="${DONE}" stroke-width="1.5" opacity="0">` +
        `<animate attributeName="r" from="${n(r)}" to="${n(r + 4.5)}" dur=".6s" begin="${s(ago)}" fill="freeze"/>` +
        `<animate attributeName="opacity" values=".8;0" dur=".6s" begin="${s(ago)}" fill="freeze"/></circle>` +
        `<circle ${at} r="${n(r)}" fill="${DONE}">` +
        `<animate attributeName="r" values="0;${n(r * 1.3)};${n(r)}" keyTimes="0;.6;1" dur=".45s" begin="${s(ago)}" fill="freeze"/></circle>` +
        `<path d="${check}" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ` +
        'pathLength="1" stroke-dasharray="1" stroke-dashoffset="1">' +
        `<animate attributeName="stroke-dashoffset" from="1" to="0" dur=".35s" begin="${s(ago + 250)}" fill="freeze"/></path>`
      )
    }
    case 'skipped':
      return (
        `<circle ${at} r="${n(r)}" fill="none" stroke="${MUTED}" stroke-width="1.4" stroke-dasharray="2 1.6"/>` +
        `<path d="M${n(cx - 0.55 * r)} ${n(MID + 0.55 * r)} L${n(cx + 0.55 * r)} ${n(MID - 0.55 * r)}" stroke="${MUTED}" stroke-width="1.4" stroke-linecap="round"/>`
      )
    case 'blocked':
      // A slow red halo: the step waits on something.
      return (
        `<circle ${at} r="${n(r + 3)}" fill="${BLOCKED}" opacity="0">` +
        '<animate attributeName="opacity" values="0;.28;0" dur="2.2s" repeatCount="indefinite"/></circle>' +
        `<circle ${at} r="${n(r)}" fill="${BLOCKED}"/>` +
        `<path d="M${n(cx)} ${n(MID - 0.5 * r)} V${n(MID + 0.12 * r)}" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>` +
        `<circle cx="${n(cx)}" cy="${n(MID + 0.45 * r)}" r=".95" fill="#fff"/>`
      )
  }
}

/** What a slice says to a reader that cannot see it; never empty. */
export const SPINE_ALT = '時間軸'

/** One line's slice of the timeline, and whether it moves (and so needs a live frame). */
export function railSvg(line: RailLine): { source: string; width: number; alt: string; isInteractive: boolean } {
  const node = line.node
  const depth = node?.depth ?? 0
  const r = node ? radius(node.depth) : 0
  const width = node ? Math.max(SPINE * 2, nodeX(depth) + r + 6) : SPINE * 2
  // A node on the spine itself parts it; a sub-step's node sits off to the side.
  const gap = node && node.depth === 0 ? r + 1.5 : 0
  const range = (half: Half): [number, number] =>
    half === 'up' ? [0, MID - gap] : half === 'down' ? [MID + gap, RAIL_H] : [0, RAIL_H]

  // Where green is about to pour, the spine starts grey beneath it.
  const sweep = line.sweep && line.sweep.elapsedMs < SWEEP_MS ? line.sweep : undefined
  const under = (half: 'up' | 'down', seg: Seg): Seg =>
    sweep && seg === 'done' && (sweep.range === half || sweep.range === 'both') ? 'todo' : seg
  let body = piece(0, MID - gap, under('up', line.up)) + piece(MID + gap, RAIL_H, under('down', line.down))

  if (node && node.depth > 0) {
    const stroke = node.status === 'done' ? DONE : node.status === 'active' ? ACCENT : MUTED
    const opacity = node.status === 'done' || node.status === 'active' ? '1' : '.45'
    body +=
      `<path d="M${SPINE} ${MID - 5} Q${SPINE} ${MID} ${SPINE + 5} ${MID} H${n(nodeX(depth) - r - 1)}" fill="none" ` +
      `stroke="${stroke}" stroke-opacity="${opacity}" stroke-width="1.5"/>`
  }

  if (line.wave) {
    // A band of light, passing through this line in its share of the cycle.
    const { index, count, range: half } = line.wave
    const [y1, y2] = range(half)
    const band = 14
    const cycle = Math.max(1.4, count * 0.34)
    const from = Math.max(y1, MID - SEEN) - band
    const to = Math.min(y2, MID + SEEN)
    const k = windowed(index / count, (index + 1) / count, from, from, to, to)
    body +=
      '<linearGradient id="w" x1="0" y1="0" x2="0" y2="1">' +
      `<stop offset="0" stop-color="${ACCENT}" stop-opacity="0"/><stop offset=".55" stop-color="${ACCENT}"/>` +
      `<stop offset="1" stop-color="${ACCENT}" stop-opacity="0"/></linearGradient>` +
      `<clipPath id="wc"><rect x="0" y="${n(y1)}" width="${width}" height="${n(y2 - y1)}"/></clipPath>` +
      `<rect x="${SPINE - 1.5}" y="${n(from)}" width="3" height="${band}" rx="1.5" fill="url(#w)" clip-path="url(#wc)">` +
      `<animate attributeName="y" values="${k.values}" keyTimes="${k.keyTimes}" dur="${n(cycle)}s" repeatCount="indefinite"/></rect>`
  }

  if (sweep) {
    // Green pouring down, in this line's share of the pour.
    const [y1, y2] = range(sweep.range)
    const k = windowed(sweep.index / sweep.count, (sweep.index + 1) / sweep.count, y1, y1, y2, y2)
    body +=
      `<line x1="${SPINE}" x2="${SPINE}" y1="${n(y1)}" y2="${n(y1)}" stroke="${DONE}" stroke-width="2">` +
      `<animate attributeName="y2" values="${k.values}" keyTimes="${k.keyTimes}" dur="${s(SWEEP_MS)}" ` +
      `begin="${s(-sweep.elapsedMs)}" fill="freeze"/></line>`
  }

  if (node) body += nodeSvg(node.status, node.depth, node.freshMs)

  const isInteractive = Boolean(
    line.wave ||
      sweep ||
      (node && (node.status === 'active' || node.status === 'blocked' || node.freshMs !== undefined)),
  )
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}" height="${RAIL_H}" viewBox="0 0 ${n(width)} ${RAIL_H}">` +
    '<style>:root{color-scheme:light dark}</style>' +
    body +
    '</svg>'
  // Never an empty alt: the desktop draws nothing for a slice that has one.
  return { source, width, alt: node?.status ?? SPINE_ALT, isInteractive }
}
