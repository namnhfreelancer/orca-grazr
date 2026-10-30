import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { arcPath, ringSvg } from '../lib/panel.mjs'

const PAGE = readFileSync(new URL('../panel/template.html', import.meta.url), 'utf8')

// Ring geometry as the page draws it: 0 degrees at 12 o'clock, clockwise, rounded to 2 decimals like arcPath.
const at = (r, deg) => {
  const a = (deg * Math.PI) / 180
  return [110 + r * Math.sin(a), 110 - r * Math.cos(a)]
}
const near = (actual, expected) => Math.abs(Number(actual) - expected) <= 0.01

// Four slices of 86 degrees with a 2 degree gap: slice i starts at 90 i + 2 and ends 86 degrees later.
const segments = (active, remaining, state = 'active') => [0, 1, 2, 3].map((i) => ({
  index: i + 1,
  name: `a${i}`,
  remaining: i === active ? remaining : null,
  state: i === active ? state : 'ok',
}))
const view = (active, remaining, { threshold = 15, tone = 'fine', state } = {}) => ({
  centre: { name: 'a1', percentText: `${remaining}% left`, hint: 'fine', tone },
  threshold,
  rows: [],
  segments: segments(active, remaining, state),
})
const lineOf = (svg, cls) => {
  const tag = svg.match(new RegExp(`<line class="${cls}"[^>]*/>`))?.[0]
  if (!tag) return null
  return Object.fromEntries([...tag.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]))
}

test('the needle stands at what the active slice has used: 25 remaining puts it at start plus 0.75 of the slice', () => {
  const svg = ringSvg(view(1, 25))
  const start = 92
  const needle = start + 0.75 * 86
  const line = lineOf(svg, 'needle')
  const [x1, y1] = at(66, needle)
  const [x2, y2] = at(93, needle)
  assert.ok(near(line.x1, x1) && near(line.y1, y1), `inner end ${line.x1},${line.y1}`)
  assert.ok(near(line.x2, x2) && near(line.y2, y2), `outer end ${line.x2},${line.y2}`)
  assert.ok(svg.includes(`<circle class="needle-dot" cx="${line.x1}" cy="${line.y1}" r="3.5"/>`))
})

test('the remaining arc starts at the needle and runs to the slice end, in the centre tone', () => {
  const svg = ringSvg(view(1, 25))
  const needle = 92 + 0.75 * 86
  assert.ok(svg.includes(`<path class="fill fill-fine" fill="none" stroke-width="14" d="${arcPath(110, 110, 80, needle, 178)}"/>`))
  assert.equal((svg.match(/class="fill fill-/g) ?? []).length, 1)
})

test('the threshold tick sits at start plus 0.85 of the slice for a 15 percent threshold, from r 70 to r 90', () => {
  const svg = ringSvg(view(1, 25, { threshold: 15 }))
  const tick = 92 + 0.85 * 86
  const line = lineOf(svg, 'threshold-tick')
  const [x1, y1] = at(70, tick)
  const [x2, y2] = at(90, tick)
  assert.ok(near(line.x1, x1) && near(line.y1, y1))
  assert.ok(near(line.x2, x2) && near(line.y2, y2))
})

test('no threshold tick when the view has no threshold', () => {
  assert.equal(lineOf(ringSvg(view(1, 25, { threshold: null })), 'threshold-tick'), null)
})

test('no needle and no fill when the active account has no reading', () => {
  const svg = ringSvg(view(1, null))
  assert.equal(lineOf(svg, 'needle'), null)
  assert.equal(svg.includes('class="needle-dot"'), false)
  assert.equal((svg.match(/class="fill /g) ?? []).length, 0)
})

test('zero remaining draws no fill arc, and the needle stands at the slice end', () => {
  const svg = ringSvg(view(1, 0, { tone: 'spent' }))
  assert.equal((svg.match(/class="fill /g) ?? []).length, 0)
  const line = lineOf(svg, 'needle')
  const [x1, y1] = at(66, 178)
  assert.ok(near(line.x1, x1) && near(line.y1, y1))
})

test('the needle and dot are drawn after every segment and fill, and before the first badge', () => {
  const svg = ringSvg(view(1, 25))
  const needle = svg.indexOf('class="needle"')
  assert.ok(needle > svg.lastIndexOf('<path class="seg '), 'after the last segment')
  assert.ok(needle > svg.lastIndexOf('<path class="fill '), 'after the last fill')
  assert.ok(needle < svg.indexOf('<text class="badge"'), 'before the first badge')
})

test('the threshold tick clamps to the slice: above 100 sits at the slice start, below 0 at the slice end, non-finite draws none', () => {
  const start = 92
  const end = 178
  const tickAt = (threshold) => lineOf(ringSvg(view(1, 25, { threshold })), 'threshold-tick')
  const high = tickAt(250)
  const [hx, hy] = at(70, start)
  assert.ok(near(high.x1, hx) && near(high.y1, hy))
  const low = tickAt(-5)
  const [lx, ly] = at(70, end)
  assert.ok(near(low.x1, lx) && near(low.y1, ly))
  assert.equal(tickAt(NaN), null)
  assert.equal(tickAt(Infinity), null)
})

test('the template styles the needle, the tick, the tone fills and the dimmed active track', () => {
  const rules = [
    '.seg-active{stroke:var(--grazr-ok);stroke-opacity:.28}',
    '.fill-fine { stroke: var(--grazr-ok); }',
    '.fill-warning { stroke: var(--grazr-warn); }',
    '.needle { stroke: currentColor; stroke-width: 2.5; stroke-linecap: round; }',
    '.needle-dot { fill: currentColor; }',
    '.threshold-tick { stroke: var(--orca-muted-foreground, var(--muted-foreground, #999)); stroke-width: 1.5; stroke-linecap: round; }',
  ]
  for (const rule of rules) assert.ok(PAGE.includes(rule), `missing ${rule}`)
  assert.ok(/\.fill-spent,\s*\.fill-blocked \{ stroke: var\(--orca-destructive, var\(--destructive, #f87171\)\); \}/.test(PAGE))
})
