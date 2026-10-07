import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { resolveTtl } from '../hooks/register'

const NOW = 1_760_000_000_000

const BAND = {
  plugin: 'cc-pulse',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

const toasts: string[] = []

// The engine beneath the plugin: a clock, the session's figures, an empty
// band, and a model that answers every step from the cache.
function world(on: On) {
  const clock = mock.clock(on, { now: NOW })
  on('session.usage', () => ({ value: {
    startedAt: NOW - 3_600_000,
    context: { tokens: 176_000, window: 1_000_000, percent: 18 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 4, resetsAt: new Date(NOW + 100 * 60_000).toISOString() },
      { kind: 'seven_day', percentUsed: 99, resetsAt: new Date(NOW + 221 * 60_000).toISOString() },
    ],
    cost: { usd: 3.37 },
  } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: {
        model: 'claude-opus-5-5',
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 9000,
        cache_creation_input_tokens: 990,
      },
    }
  })
  return clock
}

async function respond($: Engine) {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of stream) void _
  await stream.result
}

test('the TTL follows the option, then what was learned, then the environment', async () => {
  expect(resolveTtl('1h', '5m', false)).toBe('1h')
  expect(resolveTtl('5m', '1h', true)).toBe('5m')
  expect(resolveTtl('auto', '1h', false)).toBe('1h')
  expect(resolveTtl('auto', null, true)).toBe('1h')
  expect(resolveTtl('auto', null, false)).toBe('5m')
})

test('a response moves every meter on one line in the terminal', async ($, on) => {
  world(on)
  await respond($)
  for (const surface of ['terminal'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    await ui.resize({ columns: 100, rows: 1, in: 'pulse' })
    await ui.advance(3000)
    expect(await ui.find({ in: 'pulse', text: /^18%$/ })).toBeDefined()
    expect(await ui.find({ in: 'pulse', text: /^4\.0%$/ })).toBeDefined()
    // A window past 80% shows when it resets.
    expect(await ui.find({ in: 'pulse', text: /^99% ↻3h41$/ })).toBeDefined()
    expect(await ui.find({ in: 'pulse', text: /^(5:00|4:5\d)$/ })).toBeDefined()
    expect(await ui.find({ in: 'pulse', text: /\$3\.37/ })).toBeDefined()

    await ui.redraw({ ...BAND.props, isWorking: true })
    expect(await ui.find({ in: 'pulse', text: /^live$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the cache countdown goes cold once its TTL has passed', async ($, on) => {
  const clock = world(on)
  await respond($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ in: 'pulse', text: /^(5:00|4:5\d)$/ })).toBeDefined()

  await clock.advance(5 * 60_000 + 1000)
  await ui.redraw()
  expect(await ui.find({ in: 'pulse', text: /^cold$/ })).toBeDefined()
  await ui.unmount()
})

test('the band yields to a survey', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, hasSurvey: true } })
  expect(await ui.find({ key: 'engine' })).toBeDefined()
  expect(await ui.find({ key: 'pulse' })).toBeUndefined()
  await ui.unmount()
})

test('each meter keeps a hidden detail row that its hover opens', async ($, on) => {
  world(on)
  await respond($)
  for (const surface of ['terminal'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    await ui.resize({ columns: 120, rows: 6, in: 'pulse' })
    await ui.advance(400)
    expect(await ui.find({ in: 'pulse', text: /^context window · 176k of 1\.0M tokens used · 824k free$/ })).toBeDefined()
    expect(await ui.find({ in: 'pulse', text: /^5-hour window · 4% used · resets in 1h40, at \d\d:\d\d$/ })).toBeDefined()
    expect(await ui.find({ in: 'pulse', text: /^7-day window · 99% used · resets in 3h41/ })).toBeDefined()
    expect(await ui.find({ in: 'pulse', text: /^prompt cache · 5m TTL · expires at \d\d:\d\d:\d\d · last response read 9\.0k, wrote 1\.0k \(90% hit\) · keep-warm off$/ })).toBeDefined()
    expect(await ui.find({ in: 'pulse', text: /spent this session/ })).toBeDefined()

    // Hidden until hovered: each row is drawn display "none", revealed in its group.
    const tree = JSON.stringify(await ui.drawn({ in: 'pulse' }))
    for (const key of ['ctx', 'limit:five_hour', 'limit:seven_day', 'cache', 'cost']) {
      expect(tree).toContain(`"key":"detail:${key}"`)
      expect(tree).toContain(`"scope":"cc-pulse:${key}","display":"flex"`)
    }
    await ui.unmount()
  }
})

const FORKED = {
  isAnswered: true as const,
  text: 'ok',
  usage: { input_tokens: 30, output_tokens: 2, cache_read_input_tokens: 9990, cache_creation_input_tokens: 0 },
}

test('the desktop draws each meter as an animated SVG with its hover row', async ($, on) => {
  world(on)
  await respond($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const svgs = await ui.findAll({ type: 'Svg' })
  expect(svgs.map(s => s.props.alt)).toEqual([
    'pulse',
    'context 18%',
    '5h limit 4.0%',
    '7d limit 99%',
    'cache 5 minutes left',
    'keep-warm off',
  ])
  for (const s of svgs) expect(s.props.isInteractive).toBe(true)

  const source = (alt: string) => String(svgs.find(s => s.props.alt === alt)?.props.source)
  // The context bar eases in from empty to 18% of its 52px.
  expect(source('context 18%')).toContain('from="0" to="9.36"')
  // The cache bar drains over the 300 s left, and the counter rolls its seconds.
  expect(source('cache 5 minutes left')).toContain('to="0" dur="300s"')
  expect(source('cache 5 minutes left')).toContain('dur="10s"')
  expect(source('7d limit 99%')).toContain('↻3h41')

  expect(await ui.find({ text: /^7-day window · 99% used · resets at \d\d:\d\d$/ })).toBeDefined()
  expect(await ui.find({ text: /keep-warm off$/ })).toBeDefined()
  expect(await ui.find({ key: 'detail:cache' })).toBeDefined()
  expect(svgs.at(-1)?.props.alt).toBe('keep-warm off')
  expect(await ui.find({ text: /^自動保溫 · 關 · 點一下開啟/ })).toBeDefined()
  await ui.unmount()
})

test('the 保溫 button turns keep-warm on, which forks before expiry up to its budget', async ($, on) => {
  const clock = world(on)
  const forks: string[] = []
  on('model.fork', (_$, e) => {
    forks.push(e.prompt)
    return { value: FORKED }
  })
  await respond($)

  // Off by default: nothing is sent while the cache runs down.
  await clock.advance(4.5 * 60_000 + 10)
  expect(forks).toHaveLength(0)

  // Clicked on the desktop band's switch, with 30 s of cache left: on, with
  // a fresh budget. The click lands on the transparent region over the SVG.
  const desk = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await desk.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: 'warm-hit' })
  expect(toasts.at(-1)).toContain('已開啟自動保溫')
  const knob = (await desk.findAll({ type: 'Svg' })).find(x => x.props.alt === 'keep-warm on 0/3')
  // The knob slides from off to on.
  expect(String(knob?.props.source)).toContain('attributeName="cx"')
  expect(await desk.find({ text: /^自動保溫 · 開 · 這段閒置已延長 0\/3 次/ })).toBeDefined()
  // Drawn again with nothing toggled, the knob rests where it is.
  await desk.redraw()
  const rest = (await desk.findAll({ type: 'Svg' })).find(x => x.props.alt === 'keep-warm on 0/3')
  expect(String(rest?.props.source)).not.toContain('attributeName="cx"')
  await desk.unmount()
  await respond($)

  // 30 s before the 5 m TTL runs out, a fork reads the cache and restarts it.
  await clock.advance(4.5 * 60_000 + 10)
  expect(forks).toHaveLength(1)
  expect(toasts.at(-1)).toBe('Kept the prompt cache warm (10.0k tokens) · 1/3')
  await clock.advance(4.5 * 60_000 + 10)
  await clock.advance(4.5 * 60_000 + 10)
  expect(forks).toHaveLength(3)
  // The budget of 3 is spent: no fourth, and the cache goes cold.
  await clock.advance(5 * 60_000)
  expect(forks).toHaveLength(3)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ in: 'pulse', text: /keep-warm 3\/3$/ })).toBeDefined()
  expect(await ui.find({ in: 'pulse', text: /^cold$/ })).toBeDefined()
  await ui.unmount()

  // The person's next turn restores the budget.
  await $.turn.start({ text: 'next', turnId: 't2' })
  await respond($)
  const again = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await again.find({ in: 'pulse', text: /keep-warm 0\/3$/ })).toBeDefined()
  await again.unmount()
})

test('the terminal band\'s 保溫 button switches keep-warm on and off', async ($, on) => {
  const clock = world(on)
  let forks = 0
  on('model.fork', () => {
    forks += 1
    return { value: FORKED }
  })
  await respond($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'warm' })
  await ui.redraw()
  expect((await ui.find({ in: 'pulse', key: 'warm' }))?.props.label).toBe('━● 保溫 0/3')

  await ui.press({ key: 'warm' })
  await ui.redraw()
  expect(toasts.at(-1)).toBe('已關閉自動保溫。')
  expect((await ui.find({ in: 'pulse', key: 'warm' }))?.props.label).toBe('○━ 保溫')
  await ui.unmount()

  // Switched off again: the cache runs out untouched.
  await clock.advance(6 * 60_000)
  expect(forks).toBe(0)
})

test('the keepWarm setting starts a session with keep-warm on', { options: { keepWarm: true } }, async ($, on) => {
  const clock = world(on)
  let forks = 0
  on('model.fork', () => {
    forks += 1
    return { value: FORKED }
  })
  await respond($)
  await clock.advance(4.5 * 60_000 + 10)
  expect(forks).toBe(1)
})
