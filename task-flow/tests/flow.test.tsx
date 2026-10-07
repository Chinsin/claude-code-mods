import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fold, timelineLines } from '../hooks/register'
import { railSvg } from '../hooks/rail'
import type { Plan } from '../types'

const PANE = {
  plugin: 'task-flow',
  component: 'Pane',
  requestId: 'task-flow',
  props: {
    title: '任務流程',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const PLAN = {
  goal: '重構登入流程',
  steps: [
    { id: '1', title: '盤點現有登入程式', status: 'done' },
    {
      id: '2',
      title: '改寫驗證模組',
      detail: '拆出 token 驗證',
      status: 'active',
      children: [
        { id: '2.1', title: '抽出 TokenService' },
        { id: '2.2', title: '補單元測試' },
      ],
    },
    { id: '3', title: '更新文件' },
  ],
}

type World = {
  appended: string[]
  filled: string[]
  submitted: string[]
  toasts: string[]
  clock: ReturnType<typeof mock.clock>
}

// The engine beneath the plugin, recording what the plugin asks of it.
function world(on: On, { hasComposer = true }: { hasComposer?: boolean } = {}): World {
  const clock = mock.clock(on, { now: 1_760_000_000_000 })
  const w: World = { appended: [], filled: [], submitted: [], toasts: [], clock }
  // A session.append hook may only pass the row on or refuse it, and nothing
  // beneath a test stores it: record the row, then refuse it.
  on('session.append', (_$, e) => {
    const block = (e.message.content as readonly { type: string; text?: string }[])[0]
    w.appended.push(block?.text ?? '')
    return { deny: 'not stored in a test' }
  })
  // The desktop app draws its own prompt box, which refuses a fill.
  on('prompt.fill', (_$, e) => {
    if (!hasComposer) return { isFilled: false, refusal: 'no_composer' as const }
    w.filled.push(e.text)
    return { isFilled: true }
  })
  on('prompt.submit', (_$, e) => {
    w.submitted.push([e.text, ...(e.context ?? [])].join(' | '))
    return { text: e.text }
  })
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  return w
}

async function publish($: Engine, plan: unknown = PLAN) {
  return $.tool.call({ tool: 'mcp__task-flow__plan', ...(plan as object) } as never)
}

test('the plan tool draws the tree, and the step tool moves a step', async ($, on) => {
  world(on)
  const ran = await publish($)
  expect(String(ran.result)).toContain('5 steps')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /^重構登入流程$/ })).toBeDefined()
  expect(await ui.find({ text: /^1\/5 完成 · 進行中：$/ })).toBeDefined()
  expect(await ui.find({ text: /^2\.1 抽出 TokenService$/ })).toBeDefined()
  expect(await ui.find({ text: /拆出 token 驗證/ })).toBeDefined()

  await $.tool.call({ tool: 'mcp__task-flow__step', id: '2.1', status: 'done', note: '已拆出' } as never)
  await ui.redraw()
  expect(await ui.find({ text: /^2\/5 完成/ })).toBeDefined()
  expect(await ui.find({ text: /— 已拆出/ })).toBeDefined()

  const missing = await $.tool.call({ tool: 'mcp__task-flow__step', id: '9', status: 'done' } as never)
  expect(String(missing.deny ?? missing.text)).toContain('no step 9')
  await ui.unmount()
})

test('引用 puts a reference to the step in the prompt box; steps carry no other actions', async ($, on) => {
  const w = world(on)
  await publish($)
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'redirect:3' })).toBeUndefined()
    expect(await ui.find({ key: 'skip:3' })).toBeUndefined()
    await ui.press({ key: 'quote:2' })
    await ui.unmount()
  }
  expect(w.filled).toEqual(['[步驟 2「改寫驗證模組」] ', '[步驟 2「改寫驗證模組」] '])
})

test('the system prompt tells the model about the pane', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' as const }] }))
  const { sections } = await $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'],
    tools: [],
    outputStyle: { name: 'default', isKeepingCodingInstructions: true },
    traits: [],
  } as never)
  expect(sections.at(-1)?.id).toBe('task-flow:guide')
  expect(sections.at(-1)?.text).toContain('mcp__task-flow__plan')
})

test('an empty pane says how it fills', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /還沒有流程/ })).toBeDefined()
  await ui.unmount()
})

test('the guide rides the first prompt once, and again after /clear', async ($, on) => {
  const w = world(on)
  on('session.end', () => ({ sessionId: 's1' }))
  const ask = (text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
  await ask('第一個需求')
  await ask('第二個需求')
  expect(w.submitted[0]).toContain('# Task flow pane')
  expect(w.submitted[0]).toContain('select:mcp__task-flow__plan,mcp__task-flow__step')
  expect(w.submitted[1]).toBe('第二個需求')

  await $.session.end({ reason: 'clear' } as never)
  await ask('清除後的需求')
  expect(w.submitted[2]).toContain('# Task flow pane')
})

test('the desktop draws a timeline: a ring, a node per step on one spine, live frames only where it moves', async ($, on) => {
  world(on)
  await publish($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svgs = await ui.findAll({ type: 'Svg' })
  expect(svgs[0]?.props.alt).toBe('20%')
  expect(String(svgs[0]?.props.source)).toContain('stroke-dashoffset')
  // Nodes, in order, on the slices of their titles' first lines.
  const alts = svgs.slice(1).map(s => s.props.alt)
  expect(alts.filter(a => a !== '時間軸' && a !== '')).toEqual(['done', 'active', 'pending', 'pending', 'pending'])
  // No slice of the timeline goes without an alt: the desktop draws nothing for one.
  const timelineSvgs = svgs.slice(1)
  expect(timelineSvgs.every(s => String(s.props.alt).length > 0)).toBe(true)
  // The ring, and the running stretch: step 2's node, its detail, and 2.1's
  // line where the flow arrives. Every other slice is a still image.
  const live = svgs.slice(1).filter(s => s.props.isInteractive)
  expect(live).toHaveLength(3)
  expect(live.every(s => String(s.props.source).includes('repeatCount="indefinite"'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: '1/5 完成 · 進行中 2' })).toBeDefined()

  const tree = JSON.stringify(await ui.drawn())
  // Each slice sits in a box laid over its row, so it stretches with the row.
  expect(tree).toContain('"position":"absolute","top":0,"left":0,"right":0,"bottom":0,"alignItems":"center","overflow":"hidden"')
  expect(tree).not.toContain('"hover":{"display":"flex"}')
  expect(await ui.find({ key: 'quote:2.2' })).toBeDefined()
  expect(tree).toContain('"backgroundColor":"#d977571c"')
  await ui.unmount()
})

test('on the desktop long details wrap whole and every text box may shrink; a finished plan shows a check', async ($, on) => {
  world(on)
  await publish($, {
    goal: '一個很長很長的目標',
    steps: [{ id: '1', title: '唯一的一步', status: 'done', detail: '進行中轉圈動畫、完成打勾、跳過斜線、受阻驚嘆號，全部改成向量圖示' }],
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const detail = await ui.find({ type: 'Text', text: /進行中轉圈動畫/ })
  expect(detail?.props.wrap).toBe('wrap')
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).not.toContain('"flexShrink":1}')
  const ring = (await ui.findAll({ type: 'Svg' }))[0]
  expect(ring?.props.alt).toBe('100%')
  expect(String(ring?.props.source)).not.toContain('>100%<')
  await ui.unmount()

  // The terminal keeps its tree lines and cuts instead.
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await term.find({ type: 'Text', text: /進行中轉圈動畫/ }))?.props.wrap).toBe('truncate')
  await term.unmount()
})

test('a finished plan sums up: steps, skips and the time it took since its first publish', async ($, on) => {
  const { clock } = world(on)
  await publish($, { goal: '小任務', steps: [{ id: '1', title: '甲' }, { id: '2', title: '乙' }, { id: '3', title: '丙' }] })
  await clock.advance(90_000)
  // A revision keeps the start.
  await publish($, { goal: '小任務', steps: [{ id: '1', title: '甲' }, { id: '2', title: '乙' }, { id: '3', title: '丙' }] })
  await $.tool.call({ tool: 'mcp__task-flow__step', id: '1', status: 'done' } as never)
  await $.tool.call({ tool: 'mcp__task-flow__step', id: '2', status: 'skipped' } as never)
  await clock.advance(90_000)
  await $.tool.call({ tool: 'mcp__task-flow__step', id: '3', status: 'done' } as never)

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const line = await ui.find({ type: 'Text', text: /^完成 · / })
    expect(line?.text).toBe('完成 · 共 3 步 · 跳過 1 · 用時 3 分鐘')
    expect(line?.props.color).toBe('#5fd38d')
    await ui.unmount()
  }

  // Reopened, the summary gives way to the count again.
  await $.tool.call({ tool: 'mcp__task-flow__step', id: '3', status: 'active' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '2/3 完成 · 進行中 3' })).toBeDefined()
  await ui.unmount()
})

test('finished steps fold their details away until hovered; a gap row keeps the spine between top-level steps', async ($, on) => {
  world(on)
  await publish($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('"hover":{"scope":"task-flow:1","backgroundColor":"#8080801a"}')
  expect(await ui.find({ type: 'Text', text: '拆出 token 驗證' })).toBeDefined()
  expect(await ui.find({ key: 'gap:2' })).toBeDefined()
  expect(await ui.find({ key: 'gap:3' })).toBeDefined()
  expect(await ui.find({ key: 'gap:2.1' })).toBeUndefined()
  await ui.unmount()

  await $.tool.call({ tool: 'mcp__task-flow__step', id: '2', status: 'done' } as never)
  const after = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const folded = JSON.stringify(await after.drawn())
  expect(folded).toContain('"display":"none"},"hover":{"scope":"task-flow:2","display":"flex"}')
  await after.unmount()
})

test('where the prompt box refuses the quote, 引用 queues the step and the next prompt carries it', async ($, on) => {
  const w = world(on, { hasComposer: false })
  await publish($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'quote:2.1' })
  await ui.press({ key: 'quote:3' })
  expect(w.filled).toEqual([])
  expect(w.toasts).toEqual([])
  expect(await ui.find({ type: 'Text', text: '下一則訊息會引用：2.1、3' })).toBeDefined()
  expect((await ui.find({ key: 'quote:2.1' }))?.props.label).toBe('已引用')

  // Pressed again, a step is no longer quoted.
  await ui.press({ key: 'quote:3' })
  expect(await ui.find({ type: 'Text', text: '下一則訊息會引用：2.1' })).toBeDefined()
  expect((await ui.find({ key: 'quote:3' }))?.props.label).toBe('引用')

  await $.prompt.submit({ text: '這一步先等等', wait: false, origin: { kind: 'composer' } })
  expect(w.submitted[0]).toContain('這一步先等等')
  expect(w.submitted[0]).toContain('[task-flow] 使用者在這則訊息中引用了目前計畫的步驟：\n- 2.1「抽出 TokenService」（待辦）')
  expect(w.submitted[0]).not.toContain('3「更新文件」')

  // Carried once: the bar goes.
  await ui.redraw()
  expect(await ui.find({ key: 'unquote-all' })).toBeUndefined()
  await $.prompt.submit({ text: '下一則', wait: false, origin: { kind: 'composer' } })
  expect(w.submitted[1]).toBe('下一則')
  await ui.unmount()
})

test('quoting moves none of the rows: the bar sits at the foot, after every step', async ($, on) => {
  world(on, { hasComposer: false })
  await publish($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const before = JSON.stringify(await ui.drawn())
  await ui.press({ key: 'quote:2' })
  const after = JSON.stringify(await ui.drawn())
  // Everything up to the last step's row is drawn as before, bar the marks on step 2.
  // Handles and the ring's sweep differ from draw to draw; the layout must not.
  const head = (tree: string) =>
    tree
      .slice(0, tree.indexOf('"key":"step:2"'))
      .replace(/"handle":\d+/g, '')
      .replace(/"source":"(?:[^"\\]|\\.)*"/g, '')
  expect(head(after)).toBe(head(before))
  expect(after.indexOf('"key":"unquote-all"')).toBeGreaterThan(after.indexOf('"key":"step:3"'))
  await ui.unmount()
})

test('fold breaks lines by a conservative width: wide glyphs at 2.3 cells, words whole, no line opened by a closer', async () => {
  // 14 cells hold six wide glyphs (13.8), not seven.
  expect(fold('寫不進輸入框就加入待引用清單', 14)).toBe('寫不進輸入框\n就加入待引用\n清單')
  // Latin words move whole to the next line; the space between is dropped.
  expect(fold('README 加入 Ledger 圖表取色規則', 16)).toBe('README 加入\nLedger 圖表取\n色規則')
  // A closing mark stays on the line it closes.
  expect(fold('一二三四五六，七', 14)).toBe('一二三四五六，\n七')
  // A word longer than a line is cut.
  expect(fold('ds-ledger-work/project', 10)).toBe('ds-ledger-\nwork/proje\nct')
  // Nothing to fold: unchanged.
  expect(fold('短句', 40)).toBe('短句')
  // No lone glyph on a last line: it takes one more from above.
  // Nine wide glyphs fit in 21 cells: the tenth would sit alone.
  expect(fold('縱軸切片加上說明文字', 21)).toBe('縱軸切片加上說明\n文字')
  expect(fold('一二三四五六七', 14)).toBe('一二三四五\n六七')
  for (const line of fold('本機 ds-ledger-work/project 與線上設計系統是否一致；共用樣式（ui-theme / global-nav / app-dialog / ui-motion）在上次建置後有沒有新改動', 30).split('\n')) {
    expect([...line].reduce((n, ch) => n + ((ch.codePointAt(0) ?? 0) > 0x2e80 ? 2.3 : 1), 0)).toBeLessThanOrEqual(32.3)
  }
})

test('on a narrow desktop pane, details arrive folded to its width, a row per line', async ($, on) => {
  world(on)
  await publish($, {
    goal: '窄面板',
    steps: [{ id: '1', title: '核對現況', status: 'active', detail: '寫不進輸入框就加入待引用清單，再按一次取消引用' }],
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 36 } })
  // 36 columns less the rail's 3, a margin and 3 to spare: 29 cells, twelve wide glyphs a line.
  expect(await ui.find({ type: 'Text', text: '寫不進輸入框就加入待引用' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '清單，再按一次取消引用' })).toBeDefined()
  await ui.unmount()
})

test('the pane carries no clear button', async ($, on) => {
  world(on)
  await publish($)
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'clear' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', text: /清除/ })).toBeUndefined()
    await ui.unmount()
  }
})

const NOW = 1_760_000_000_000

function timeline(steps: unknown[], now = NOW) {
  const plan = { goal: 'g', updatedAt: NOW, steps } as unknown as Plan
  return timelineLines(plan, 60, now).map(l => ({
    key: l.key,
    up: l.rail.up,
    down: l.rail.down,
    node: l.rail.node?.status,
    fresh: l.rail.node?.freshMs,
    wave: l.rail.wave && `${l.rail.wave.index}/${l.rail.wave.count} ${l.rail.wave.range}`,
    sweep: l.rail.sweep && `${l.rail.sweep.index}/${l.rail.sweep.count} ${l.rail.sweep.range} @${l.rail.sweep.elapsedMs}`,
  }))
}

test('the spine reads by the step it leaves: green past done, flowing past the running step, grey ahead', async () => {
  const lines = timeline([
    { id: '1', title: '甲', status: 'done', children: [] },
    { id: '2', title: '乙', status: 'active', detail: '說明', children: [{ id: '2.1', title: '丙', status: 'pending', children: [] }] },
    { id: '3', title: '丁', status: 'skipped', children: [] },
    { id: '4', title: '戊', status: 'pending', children: [] },
  ])
  expect(lines).toEqual([
    { key: 't:1:0', up: 'none', down: 'done', node: 'done', fresh: undefined, wave: undefined, sweep: undefined },
    { key: 'gap:2', up: 'done', down: 'done', node: undefined, fresh: undefined, wave: undefined, sweep: undefined },
    { key: 't:2:0', up: 'done', down: 'flow', node: 'active', fresh: undefined, wave: '0/3 down', sweep: undefined },
    { key: 'd:2:0', up: 'flow', down: 'flow', node: undefined, fresh: undefined, wave: '1/3 both', sweep: undefined },
    { key: 't:2.1:0', up: 'flow', down: 'todo', node: 'pending', fresh: undefined, wave: '2/3 up', sweep: undefined },
    { key: 'gap:3', up: 'todo', down: 'todo', node: undefined, fresh: undefined, wave: undefined, sweep: undefined },
    { key: 't:3:0', up: 'todo', down: 'skip', node: 'skipped', fresh: undefined, wave: undefined, sweep: undefined },
    { key: 'gap:4', up: 'skip', down: 'skip', node: undefined, fresh: undefined, wave: undefined, sweep: undefined },
    { key: 't:4:0', up: 'skip', down: 'none', node: 'pending', fresh: undefined, wave: undefined, sweep: undefined },
  ])
})

test('a step just finished pops its node and pours green down to the next, once', async () => {
  const steps = [
    { id: '1', title: '甲', status: 'done', changedAt: NOW - 200, detail: '說明', children: [] },
    { id: '2', title: '乙', status: 'active', changedAt: NOW - 200, children: [] },
  ]
  // The finished step's detail is folded away, so the pour skips it.
  expect(timeline(steps).filter(l => l.fresh !== undefined || l.sweep)).toEqual([
    { key: 't:1:0', up: 'none', down: 'done', node: 'done', fresh: 200, wave: undefined, sweep: '0/3 down @200' },
    { key: 'gap:2', up: 'done', down: 'done', node: undefined, fresh: undefined, wave: undefined, sweep: '1/3 both @200' },
    { key: 't:2:0', up: 'done', down: 'none', node: 'active', fresh: undefined, wave: undefined, sweep: '2/3 up @200' },
  ])
  // A second later it is still: no pop, no pour.
  expect(timeline(steps, NOW + 1000).filter(l => l.fresh !== undefined || l.sweep)).toEqual([])
})

test('a slice needs a live frame only while it moves', async () => {
  const still = railSvg({ up: 'done', down: 'todo', node: { status: 'pending', depth: 0 } })
  expect(still.isInteractive).toBe(false)
  expect(still.source).not.toContain('<animate')

  const running = railSvg({ up: 'done', down: 'flow', node: { status: 'active', depth: 0 } })
  expect(running.isInteractive).toBe(true)
  expect(running.source).toContain('repeatCount="indefinite"')

  // Begun in the past by what has elapsed, so a redraw carries the pop on.
  const fresh = railSvg({ up: 'none', down: 'done', node: { status: 'done', depth: 0, freshMs: 300 } })
  expect(fresh.isInteractive).toBe(true)
  expect(fresh.source).toContain('begin="-0.3s"')
  expect(fresh.source).toContain('pathLength="1"')

  // Where green is about to pour, the spine starts grey beneath it.
  const pour = railSvg({ up: 'done', down: 'done', sweep: { index: 1, count: 3, range: 'both', elapsedMs: 100 } })
  expect(pour.source).toContain('stroke="#9aa0a6"')
  expect(pour.source).toContain('attributeName="y2"')
  expect(railSvg({ up: 'done', down: 'done', sweep: { index: 1, count: 3, range: 'both', elapsedMs: 900 } }).isInteractive).toBe(false)

  // A sub-step's node sits off the spine, on a branch.
  const sub = railSvg({ up: 'flow', down: 'todo', node: { status: 'pending', depth: 1 } })
  expect(sub.source).toContain('Q11 20 16 20')
  expect(sub.width).toBeGreaterThan(still.width)
})

test('marking a step done animates its node on the next draw, and is still a moment later', async ($, on) => {
  const { clock } = world(on)
  await publish($)
  await $.tool.call({ tool: 'mcp__task-flow__step', id: '2', status: 'done' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const node = async () => (await ui.findAll({ type: 'Svg' })).filter(s => s.props.alt === 'done')[1]
  expect((await node())?.props.isInteractive).toBe(true)
  expect(String((await node())?.props.source)).toContain('stroke-dashoffset')

  await clock.advance(1000)
  await ui.redraw()
  expect((await node())?.props.isInteractive).toBeUndefined()
  await ui.unmount()
})
