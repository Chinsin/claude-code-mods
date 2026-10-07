import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Plan, Step, StepStatus } from '../types'
import { ACCENT, DONE, RING, progressRing } from './icons'
import { FRESH_MS, RAIL_H, SWEEP_MS, railCells, railSvg, segOf } from './rail'
import type { Half, RailLine, Seg } from './rail'

// The plan as a task tree in a side pane. The model draws it through two
// tools of this plugin; the person quotes any step from the pane into the
// message they write next.

const PANE = 'task-flow'
const TITLE = '任務流程'
const PLAN_TOOL = 'mcp__task-flow__plan'
const STEP_TOOL = 'mcp__task-flow__step'
const STATUSES: readonly StepStatus[] = ['pending', 'active', 'done', 'skipped', 'blocked']

const planAtom = atom({ plugin: 'task-flow', key: 'plan' } as const, null)
const guidedAtom = atom({ plugin: 'task-flow', key: 'guided' } as const, false)
const quotedAtom = atom({ plugin: 'task-flow', key: 'quoted' } as const, [] as string[])

const GUIDE = `# Task flow pane
The person follows your plan in a side pane, drawn from the ${PLAN_TOOL} tool.
- For a request that takes more than a few steps, call ${PLAN_TOOL} before you start: a goal and a tree of steps (ids "1", "1.1", "2"; sub-steps as children). Titles short and in the person's language; specifics go in detail. Skip it for one-step requests.
- As you work, call ${STEP_TOOL} to mark a step active when you start it and done when it is finished (blocked or skipped with a note when that is what happened). Keep ids stable.
- A quote like [步驟 2.1「title」] in the person's message, or a note starting "[task-flow]" that lists quoted steps, names those steps of the current plan. When what the person says changes the plan, call ${PLAN_TOOL} again with the revised steps, keeping the ids of steps that did not change.
- If these tools are not in your tool list yet (deferred), load them first with ToolSearch: select:${PLAN_TOOL},${STEP_TOOL}.`

const stepSchema = (depth: number): Record<string, unknown> => ({
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Stable id: "1", "1.2", "2"' },
    title: { type: 'string', description: 'Short title, in the person\'s language' },
    detail: { type: 'string', description: 'What the step does, specifically' },
    status: { type: 'string', enum: STATUSES },
    children: depth > 0 ? { type: 'array', items: stepSchema(depth - 1) } : { type: 'array', items: { type: 'object' } },
  },
  required: ['id', 'title'],
})

// ---- the tree ----

function walk(steps: readonly Step[], fn: (s: Step) => Step): Step[] {
  return steps.map(s => fn({ ...s, children: walk(s.children, fn) }))
}

function find(steps: readonly Step[], id: string): Step | undefined {
  for (const s of steps) {
    if (s.id === id) return s
    const hit = find(s.children, id)
    if (hit) return hit
  }
  return undefined
}

function flatten(steps: readonly Step[]): Step[] {
  return steps.flatMap(s => [s, ...flatten(s.children)])
}

/** The plan with `finishedAt` set the moment every step has settled. */
export function stamped(plan: Plan, now: number): Plan {
  const all = flatten(plan.steps)
  const isFinished = all.length > 0 && all.every(s => s.status === 'done' || s.status === 'skipped')
  if (!isFinished) return plan.finishedAt === undefined ? plan : { ...plan, finishedAt: undefined }
  return plan.finishedAt === undefined ? { ...plan, finishedAt: now } : plan
}

/** A span of time, the way the summary reads it: 45 秒, 3 分鐘, 1 小時 12 分. */
export function spanOf(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} 分鐘`
  return `${Math.floor(m / 60)} 小時${m % 60 ? ` ${m % 60} 分` : ''}`
}

/** The model's steps as the pane keeps them. */
export function toSteps(raw: unknown): Step[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item, i): Step[] => {
    if (typeof item !== 'object' || item === null) return []
    const r = item as Record<string, unknown>
    const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : String(i + 1)
    const status = STATUSES.includes(r.status as StepStatus) ? (r.status as StepStatus) : 'pending'
    return [
      {
        id,
        title: typeof r.title === 'string' ? r.title : id,
        ...(typeof r.detail === 'string' && r.detail ? { detail: r.detail } : {}),
        ...(typeof r.note === 'string' && r.note ? { note: r.note } : {}),
        status,
        children: toSteps(r.children),
      },
    ]
  })
}

/** The new steps, each keeping when its status last changed, or stamped now. */
export function carryChanges(steps: readonly Step[], before: readonly Step[], now: number): Step[] {
  return walk(steps, s => {
    const old = find(before, s.id)
    const changedAt = old ? (old.status === s.status ? old.changedAt : now) : undefined
    return changedAt === undefined ? s : { ...s, changedAt }
  })
}

// ---- what the person does in the pane ----

const STATUS_NAME: Record<StepStatus, string> = {
  pending: '待辦',
  active: '進行中',
  done: '已完成',
  skipped: '已跳過',
  blocked: '受阻',
}

// 引用: the reference goes into the prompt box. Where the box refuses it (a
// dialog holds it, a host draws none), the step joins the quoted list and the
// next prompt carries it; a second press on a quoted step takes it off.
async function quoteStep($: EngineInterface, step: Step) {
  if ((await read($, quotedAtom)).includes(step.id)) return unquote($, step.id)
  const filled = await $.prompt
    .fill({ text: `[步驟 ${step.id}「${step.title}」] `, mode: 'insert' })
    .catch(() => ({ isFilled: false }))
  if (filled.isFilled) return
  // No toast: the row's ❝ and the bar at the pane's foot say it, and a toast
  // per press would pile up while several steps are quoted in a row.
  await update($, quotedAtom, q => [...q, step.id])
}

async function unquote($: EngineInterface, id: string | null) {
  await update($, quotedAtom, q => (id === null ? [] : q.filter(x => x !== id)))
}

/** The note the next prompt carries for the quoted steps, or null. */
export function quoteNote(plan: Plan | null, ids: readonly string[]): string | null {
  const steps = plan ? ids.flatMap(id => find(plan.steps, id) ?? []) : []
  if (steps.length === 0) return null
  return (
    '[task-flow] 使用者在這則訊息中引用了目前計畫的步驟：\n' +
    steps
      .map(s => `- ${s.id}「${s.title}」（${STATUS_NAME[s.status]}）${s.detail ? `：${s.detail}` : ''}`)
      .join('\n')
  )
}

// ---- drawing ----

// The desktop breaks lines by its own estimate of the width, which counts a
// wide (CJK) glyph as two cells while the font draws it a little wider, so
// long lines spill past the pane. The pane folds them itself instead: wide
// glyphs at a conservative width, Latin words kept whole, and no line opened
// by closing punctuation.
const WIDE = 2.3
const CLOSERS = new Set([...'，。、；：！？）」』】》〉,.;:!?)'])
const isWide = (cp: number) =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe4f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) ||
  (cp >= 0x1f300 && cp <= 0x1faff) ||
  (cp >= 0x20000 && cp <= 0x3fffd)
const widthOf = (text: string) => [...text].reduce((n, ch) => n + (isWide(ch.codePointAt(0) ?? 0) ? WIDE : 1), 0)

/** `text` broken into lines no wider than `cols` cells, by the estimate above. */
export function fold(text: string, cols: number): string {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    let width = 0
    const flush = () => {
      lines.push(line.trimEnd())
      line = ''
      width = 0
    }
    const put = (piece: string, w: number) => {
      line += piece
      width += w
    }
    for (const token of paragraph.match(/[A-Za-z0-9_./@%+#&=-]+|\s+|./gsu) ?? []) {
      const w = widthOf(token)
      if (/^\s+$/.test(token)) {
        // A space ends a line rather than opening the next.
        if (line && width + w <= cols) put(token, w)
        else if (line) flush()
        continue
      }
      if (width + w <= cols) put(token, w)
      else if (CLOSERS.has(token) && line) put(token, w)
      else if (w <= cols) {
        if (line) flush()
        put(token, w)
      } else {
        // A word wider than a line: cut it, glyph by glyph.
        for (const ch of token) {
          const cw = widthOf(ch)
          if (width + cw > cols && line) flush()
          put(ch, cw)
        }
      }
    }
    lines.push(line.trimEnd())
    // No lone wide glyph on a last line: it takes one more from the line above.
    const last = lines[lines.length - 1] ?? ''
    const above = lines[lines.length - 2]
    const [lone] = [...last]
    const moved = above === undefined ? undefined : [...above].at(-1)
    if (
      above !== undefined &&
      [...last].length === 1 &&
      isWide(lone!.codePointAt(0) ?? 0) &&
      moved !== undefined &&
      isWide(moved.codePointAt(0) ?? 0) &&
      !CLOSERS.has(moved) &&
      [...above].length > 2
    ) {
      lines[lines.length - 2] = [...above].slice(0, -1).join('')
      lines[lines.length - 1] = moved + last
    }
  }
  return lines.join('\n')
}

const GLYPH: Record<StepStatus, string> = { pending: '○', active: '◉', done: '✓', skipped: '⊘', blocked: '!' }
const COLOR: Record<StepStatus, string | undefined> = {
  pending: undefined,
  active: ACCENT,
  done: DONE,
  skipped: undefined,
  blocked: '#f7768e',
}
// Row tints on the desktop: the running step, and any row under the pointer.
const ACTIVE_BG = '#d977571c'
const HOVER_BG = '#8080801a'
const BAR = 24

type Row = { step: Step; depth: number; lead: string; rest: string }

// A step's hover group: its row heats it, its collapsed detail reveals in it.
const groupOf = (id: string) => `task-flow:${id}`.slice(0, 64)

// Each step with its depth and tree lines: `lead` before its own row, `rest`
// before its detail beneath.
function rowsOf(steps: readonly Step[], prefix = '', depth = 0): Row[] {
  return steps.flatMap((step, i) => {
    const isLast = i === steps.length - 1
    const lead = prefix + (isLast ? '└─ ' : '├─ ')
    const rest = prefix + (isLast ? '   ' : '│  ')
    return [{ step, depth, lead, rest }, ...rowsOf(step.children, rest, depth + 1)]
  })
}

/** One line of the desktop timeline: its slice of the spine, then its text. */
export type TimelineLine = {
  key: string
  step: Step
  depth: number
  kind: 'title' | 'more' | 'detail' | 'gap'
  text: string
  rail: RailLine
  /** A settled step's detail: folded away until the pointer is over the step. */
  isFolded: boolean
}

/**
 * The plan as the desktop's timeline: titles and details folded to the pane's
 * `cols`, a gap before each top-level step, each line's slice of the spine,
 * and the motion over stretches of it at `now`: light flowing down from a
 * running step, green pouring down from one just finished.
 */
export function timelineLines(plan: Plan, cols: number, now: number): TimelineLine[] {
  const rows = rowsOf(plan.steps)
  const lines: TimelineLine[] = []
  rows.forEach(({ step, depth }, i) => {
    const up: Seg = i === 0 ? 'none' : segOf(rows[i - 1]!.step.status)
    const down: Seg = i === rows.length - 1 ? 'none' : segOf(step.status)
    if (depth === 0 && i > 0) {
      lines.push({ key: `gap:${step.id}`, step, depth, kind: 'gap', text: '', rail: { up, down: up }, isFolded: false })
    }
    const since = step.changedAt === undefined ? Infinity : now - step.changedAt
    const freshMs = step.status === 'done' && since >= 0 && since < FRESH_MS ? since : undefined
    // Room for the 引用 button and a ❝ on the first line.
    fold(`${step.id} ${step.title}`, Math.max(8, cols - railCells(depth) - 1 - 6))
      .split('\n')
      .forEach((text, k) =>
        lines.push({
          key: `t:${step.id}:${k}`,
          step,
          depth,
          kind: k === 0 ? 'title' : 'more',
          text,
          rail:
            k === 0
              ? { up, down, node: { status: step.status, depth, ...(freshMs === undefined ? {} : { freshMs }) } }
              : { up: down, down },
          isFolded: false,
        }),
      )
    const detail = [step.detail, step.note && `— ${step.note}`].filter(Boolean).join(' ')
    const isSettled = step.status === 'done' || step.status === 'skipped'
    if (detail) {
      fold(detail, Math.max(8, cols - railCells(depth) - 1 - 3))
        .split('\n')
        .forEach((text, k) =>
          lines.push({ key: `d:${step.id}:${k}`, step, depth, kind: 'detail', text, rail: { up: down, down }, isFolded: isSettled }),
        )
    }
  })

  // A stretch of spine: from a node's line down to the next node's, over the
  // lines that show.
  const shown = lines.filter(l => !l.isFolded)
  const stretch = (at: number) => {
    const out: { line: TimelineLine; range: Half }[] = [{ line: shown[at]!, range: 'down' }]
    for (let j = at + 1; j < shown.length; j++) {
      const l = shown[j]!
      if (l.kind === 'title') {
        out.push({ line: l, range: 'up' })
        break
      }
      out.push({ line: l, range: 'both' })
    }
    return out
  }
  shown.forEach((l, at) => {
    const node = l.rail.node
    if (!node || l.rail.down === 'none') return
    const since = l.step.changedAt === undefined ? Infinity : now - l.step.changedAt
    if (node.status === 'active') {
      const parts = stretch(at)
      parts.forEach(({ line, range }, index) => {
        line.rail = { ...line.rail, wave: { index, count: parts.length, range } }
      })
    } else if (node.status === 'done' && since >= 0 && since < SWEEP_MS) {
      const parts = stretch(at)
      parts.forEach(({ line, range }, index) => {
        line.rail = { ...line.rail, sweep: { index, count: parts.length, range, elapsedMs: since } }
      })
    }
  })
  return lines
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // A reload runs this again: a pane drawn by the module before it keeps its
    // old tree, whose buttons point at that module's handlers and whose reads
    // no longer redraw it. Draw it again with this one.
    $.ui.invalidate('ui.render')
    await $.command.register({ name: 'flow', description: '打開任務流程面板' })
    await $.tool.register({
      name: 'plan',
      description:
        'Shows the person your plan for the current request as a task tree in their side pane, replacing the one shown. ' +
        'Call it before starting multi-step work, and again whenever the plan changes (keep ids of unchanged steps).',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'The request, in one line, in the person\'s language' },
          steps: { type: 'array', items: stepSchema(3) },
        },
        required: ['goal', 'steps'],
      },
    })
    await $.tool.register({
      name: 'step',
      description: 'Updates one step of the plan shown in the task flow pane: its status, and optionally a short note.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: STATUSES },
          note: { type: 'string', description: 'What happened, when worth saying (why blocked, what was found)' },
        },
        required: ['id', 'status'],
      },
    })
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { sections: [...composed.sections, { id: 'task-flow:guide', text: GUIDE, scope: 'session' as const }] }
  })

  on('command.run', { command: 'flow' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    return { text: '任務流程面板已打開。' }
  })

  on('tool.call', { tool: PLAN_TOOL }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const before = await read($, planAtom)
    const now = await $.clock.now()
    const steps = carryChanges(toSteps(input.steps), before?.steps ?? [], now)
    if (steps.length === 0) return { deny: 'steps must be a non-empty array of { id, title }' }
    // A revision of unfinished work keeps its start; anything else starts now.
    const startedAt = before && before.finishedAt === undefined ? (before.startedAt ?? before.updatedAt) : now
    const plan = stamped({ goal: typeof input.goal === 'string' ? input.goal : '', steps, updatedAt: now, startedAt }, now)
    await update($, planAtom, () => plan)
    void $.ui.open({ id: PANE, title: TITLE })
    $.ui.invalidate('ui.render')
    return { result: `The plan (${flatten(steps).length} steps) is shown in the person's task flow pane.` }
  })

  on('tool.call', { tool: STEP_TOOL }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const id = String(input.id ?? '')
    const status = input.status as StepStatus
    if (!STATUSES.includes(status)) return { deny: `status must be one of ${STATUSES.join(', ')}` }
    const plan = await read($, planAtom)
    if (!plan || !find(plan.steps, id)) return { deny: `no step ${id} in the plan; call ${PLAN_TOOL} first` }
    const note = typeof input.note === 'string' && input.note ? input.note : undefined
    const now = await $.clock.now()
    await update($, planAtom, p =>
      p
        ? stamped(
            {
              ...p,
              steps: walk(p.steps, s =>
                s.id === id
                  ? { ...s, status, ...(note ? { note } : {}), ...(s.status !== status ? { changedAt: now } : {}) }
                  : s,
              ),
            },
            now,
          )
        : p,
    )
    $.ui.invalidate('ui.render')
    return { result: `Step ${id} is now ${status}.` }
  })

  // Quoted steps ride the person's next prompt, as context only the model
  // reads. The guide rides the conversation's first prompt too: where the system
  // prompt's own sections ride the first message (the desktop app, the SDK),
  // a resumed conversation would otherwise never read it.
  on('prompt.submit', async ($, e, next) => {
    const isOwn = e.origin?.kind === 'plugin' && e.origin.name === 'task-flow'
    const quotedIds = isOwn ? [] : await read($, quotedAtom)
    const quote = quotedIds.length > 0 ? quoteNote(await read($, planAtom), quotedIds) : null
    const isGuided = await read($, guidedAtom)
    if (quotedIds.length === 0 && isGuided) return next(e)
    if (quotedIds.length > 0) await update($, quotedAtom, () => [])
    if (!isGuided) await update($, guidedAtom, () => true)
    return next({
      ...e,
      context: [...(e.context ?? []), ...(isGuided ? [] : [GUIDE]), ...(quote ? [quote] : [])],
    })
  })

  // /clear starts the conversation over: the next prompt carries the guide again.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, guidedAtom, () => false)
    return next(e)
  })

  // The ring's last figure, so the next draw sweeps from it.
  let shownProgress = 0

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // The terminal draws no SVG: its tree stays in box-drawing lines.
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
    const plan = await read($, planAtom)
    const quoted = await read($, quotedAtom)

    if (!plan) {
      return (
        <Box flexDirection="column" paddingY={1}>
          <Text bold>還沒有流程</Text>
          <Text dimColor>送出一個多步驟的需求，Claude 會先在這裡列出計畫；</Text>
          <Text dimColor>之後可以把任何一步引用到你的訊息裡。</Text>
        </Box>
      )
    }

    const all = flatten(plan.steps)
    const settled = all.filter(s => s.status === 'done' || s.status === 'skipped').length
    const active = all.find(s => s.status === 'active')
    const progress = all.length ? settled / all.length : 0
    const from = shownProgress
    shownProgress = progress
    const skipped = all.filter(s => s.status === 'skipped').length
    const isFinished = plan.finishedAt !== undefined
    const took = isFinished ? plan.finishedAt! - (plan.startedAt ?? plan.updatedAt) : 0
    const summary = isFinished
      ? `完成 · 共 ${all.length} 步${skipped ? ` · 跳過 ${skipped}` : ''}${took > 0 ? ` · 用時 ${spanOf(took)}` : ''}`
      : `${settled}/${all.length} 完成${active ? ' · 進行中：' : ''}`

    const actions = (step: Step) => (
      <Box flexDirection="row" flexShrink={0}>
        <Button
          key={`quote:${step.id}`}
          label={quoted.includes(step.id) ? '已引用' : '引用'}
          plain
          dimColor={!quoted.includes(step.id)}
          onPress={() => void quoteStep($, step)}
        />
      </Box>
    )

    // The detail beneath a step, after `indent`; the desktop wraps it whole,
    // the terminal keeps its tree lines and cuts.
    const beneath = (step: Step, indent: (key: string) => RenderElement, wrap: 'wrap' | 'truncate', cols?: number) => {
      const shape = (text: string) => (cols === undefined ? text : fold(text, cols))
      return [
      // A settled step keeps only its title; its detail opens while the
      // pointer is over the step's row (the row's hover group).
      (step.detail || step.note) && (
        <Box key={`detail:${step.id}`} flexDirection="column">
          <Box
            flexDirection="row"
            {...(step.status === 'done' || step.status === 'skipped'
              ? { display: 'none' as const, hover: { scope: groupOf(step.id), display: 'flex' as const } }
              : {})}
          >
            {indent('d')}
            <Box flexShrink={1} minWidth={0} paddingRight={wrap === 'wrap' ? 2 : 0}>
              <Text dimColor wrap={wrap}>
                {shape([step.detail, step.note && `— ${step.note}`].filter(Boolean).join(' '))}
              </Text>
            </Box>
          </Box>
        </Box>
      ),
    ]
    }

    // Steps waiting to ride the next prompt, in one line at the pane's foot:
    // growing there moves none of the rows above, which the next press aims at.
    // A step leaves it by its own 已引用 button.
    const quotedSteps = quoted.flatMap(id => find(plan.steps, id) ?? [])
    const quoteBar = quotedSteps.length > 0 && (
      <Box flexDirection="row" marginTop={1}>
        <Text color={ACCENT}>❝ </Text>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text wrap="truncate">
            下一則訊息會引用：{quotedSteps.map(s => s.id).join('、')}
          </Text>
        </Box>
        <Text> </Text>
        <Button key="unquote-all" label="全部取消" plain dimColor onPress={() => void unquote($, null)} />
      </Box>
    )

    // Desktop and the other drawn surfaces: a timeline down the pane's
    // height. Every line is a row of its own: its slice of the spine (stretched
    // to the row and clipped, so the slices join), then its text, folded here
    // to the pane's width (the desktop's own wrapping runs wide on CJK).
    if (Svg) {
      const lines = timelineLines(plan, e.props.bodyColumns, await $.clock.now())

      const rail = (line: TimelineLine) => {
        const slice = railSvg(line.rail)
        return (
          <Box width={railCells(line.depth)} flexShrink={0} position="relative">
            <Box position="absolute" top={0} left={0} right={0} bottom={0} alignItems="center" overflow="hidden">
              <Svg
                source={slice.source}
                alt={slice.alt}
                width={slice.width}
                height={RAIL_H}
                isInteractive={slice.isInteractive || undefined}
              />
            </Box>
          </Box>
        )
      }

      const row = (line: TimelineLine) => {
        const step = line.step
        const isActive = step.status === 'active'
        const isQuiet = step.status === 'done' || step.status === 'skipped'
        const titleStyle = {
          bold: isActive,
          color: isActive ? ACCENT : undefined,
          dimColor: isQuiet,
          strikethrough: step.status === 'skipped',
        }
        let content: RenderElement
        if (line.kind === 'title') {
          const hasId = line.text.startsWith(`${step.id} `)
          content = (
            <Box flexDirection="row" alignItems="center" flexGrow={1} flexShrink={1} minWidth={0}>
              {hasId && <Text dimColor>{step.id} </Text>}
              <Box flexShrink={1} minWidth={0}>
                <Text {...titleStyle} wrap="wrap">
                  {hasId ? line.text.slice(step.id.length + 1) : line.text}
                </Text>
              </Box>
              {quoted.includes(step.id) && <Text color={ACCENT}> ❝</Text>}
              <Box flexGrow={1} />
              {actions(step)}
            </Box>
          )
        } else if (line.kind === 'more') {
          content = (
            <Text {...titleStyle} wrap="wrap">
              {line.text}
            </Text>
          )
        } else if (line.kind === 'detail') {
          content = (
            <Text dimColor wrap="wrap">
              {line.text}
            </Text>
          )
        } else {
          content = <Text> </Text>
        }
        return (
          <Box key={line.key} flexDirection="row">
            {rail(line)}
            <Box flexDirection="row" alignItems="center" marginLeft={1} flexGrow={1} flexShrink={1} minWidth={0}>
              {content}
            </Box>
          </Box>
        )
      }

      // A block per step: its own lines, tinted while it runs, lit under the
      // pointer; a settled step's detail folded inside, opened in its group.
      const blocks: RenderElement[] = []
      for (let i = 0; i < lines.length; ) {
        const line = lines[i]!
        if (line.kind === 'gap') {
          blocks.push(row(line))
          i++
          continue
        }
        const step = line.step
        const own: TimelineLine[] = []
        while (i < lines.length && lines[i]!.step === step && lines[i]!.kind !== 'gap') own.push(lines[i++]!)
        const isActive = step.status === 'active'
        const folded = own.filter(l => l.isFolded)
        blocks.push(
          <Box
            key={`step:${step.id}`}
            flexDirection="column"
            backgroundColor={isActive ? ACTIVE_BG : undefined}
            hover={{ scope: groupOf(step.id), backgroundColor: isActive ? ACTIVE_BG : HOVER_BG }}
          >
            {own.filter(l => !l.isFolded).map(row)}
            {folded.length > 0 && (
              <Box flexDirection="column" display="none" hover={{ scope: groupOf(step.id), display: 'flex' }}>
                {folded.map(row)}
              </Box>
            )}
          </Box>,
        )
      }

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" alignItems="center">
            <Svg
              key="ring"
              source={progressRing(from, progress, Boolean(active))}
              alt={`${Math.round(progress * 100)}%`}
              width={RING}
              height={RING}
              isInteractive
            />
            <Box flexDirection="column" marginLeft={1} flexGrow={1} flexShrink={1} minWidth={0}>
              <Text bold wrap="truncate">
                {plan.goal || '目前的計畫'}
              </Text>
              {/* The running step is named by its id: its block below is lit. */}
              <Text color={isFinished ? DONE : undefined} dimColor={!isFinished} wrap="truncate">
                {isFinished ? summary : `${settled}/${all.length} 完成${active ? ` · 進行中 ${active.id}` : ''}`}
              </Text>
            </Box>
          </Box>
          <Box flexDirection="column" marginTop={1}>
            {blocks}
          </Box>
          {quoteBar}
        </Box>
      )
    }

    // Terminal: the tree in box-drawing lines, a bar for progress.
    const filled = Math.round(progress * BAR)
    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate">
          {plan.goal || '目前的計畫'}
        </Text>
        <Box flexDirection="row">
          <Text color={progress >= 1 ? DONE : ACCENT}>{'━'.repeat(filled)}</Text>
          <Text dimColor>{'─'.repeat(BAR - filled)}</Text>
          <Text dimColor> {Math.round(progress * 100)}%</Text>
        </Box>
        <Box flexDirection="row">
          <Text color={isFinished ? DONE : undefined} dimColor={!isFinished}>{summary}</Text>
          {active && (
            <Text color={ACCENT} wrap="truncate">
              {active.id} {active.title}
            </Text>
          )}
        </Box>
        <Text> </Text>
        {rowsOf(plan.steps).map(({ step, lead, rest }) => {
          const isActive = step.status === 'active'
          const isQuiet = step.status === 'done' || step.status === 'skipped'
          const indent = (key: string) => (
            <Text key={`i${key}`} dimColor>
              {rest}{'  '}
            </Text>
          )
          return (
            <Box key={`step:${step.id}`} flexDirection="column">
              <Box flexDirection="row" hover={{ scope: groupOf(step.id) }}>
                <Text dimColor>{lead}</Text>
                <Text color={COLOR[step.status]} dimColor={step.status === 'pending' || step.status === 'skipped'}>
                  {GLYPH[step.status]}{' '}
                </Text>
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Text
                    bold={isActive}
                    color={isActive ? ACCENT : undefined}
                    dimColor={isQuiet}
                    strikethrough={step.status === 'skipped'}
                    wrap="truncate"
                  >
                    {step.id} {step.title}
                  </Text>
                </Box>
                {quoted.includes(step.id) && <Text color={ACCENT}>❝ </Text>}
                {actions(step)}
              </Box>
              {beneath(step, indent, 'truncate')}
            </Box>
          )
        })}
        {quoteBar}
      </Box>
    )
  })
}
