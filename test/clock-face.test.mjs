import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clockSvg, turn, timeLabel, HORIZON, project } from '../lib/clock.mjs'

// The face of HerdrM's clock, ported to the dial's box: 24-hour and 7-day rings, the hand at now, swaps, refills and the centre text.
const TZ = 'Europe/Zurich'
// 2026-10-22T13:00:00Z is Thursday 15:00 in Zurich (CEST).
const NOON = Date.UTC(2026, 9, 22, 13, 0, 0) / 1000
// 2026-10-18T22:00:00Z is Monday 00:00 in Zurich (the brief's 2026-10-19T22:00Z is Tuesday 00:00 there).
const MONDAY = Date.UTC(2026, 9, 18, 22, 0, 0) / 1000
const HOUR = 3600
const DAY = 86400
const thresholds = { session: 15, weekly: 15 }
const win = (group, remaining, resetsInHours, scope = null) =>
  ({ group, scope, remaining, resetsAt: resetsInHours === null ? null : NOON + resetsInHours * HOUR })
const acct = (id, windows = [], extra = {}) => ({ id, name: id, index: 1, blocked: false, updated: null, windows, ...extra })
const clock = ({ active = null, accounts }) => ({ active, thresholds, modelLimits: false, accounts })
const at = (r, deg) => {
  const a = (deg * Math.PI) / 180
  return [110 + r * Math.sin(a), 110 - r * Math.cos(a)]
}
const CENTRE_Y = {
  session: { time: 98, name: 118, runs: 132, then: 146 },
  weekly: { time: 92, day: 106, name: 122, runs: 136, then: 150 },
}

const svgOf = (c, span, now = NOON) => clockSvg(c, { now, span, timeZone: TZ })
const count = (svg, re) => (svg.match(re) || []).length
// Every centre line: text at x 110, with its class, y and visible text (the <title> holds the full text).
const centre = (svg) => [...svg.matchAll(/<text class="([^"]*)" x="110" y="([\d.]+)"[^>]*>(?:<title>[^<]*<\/title>)?([^<]*)<\/text>/g)]
  .map((m) => ({ cls: m[1], y: Number(m[2]), text: m[3] }))
  .filter((l) => !l.cls.startsWith('clock-label'))
const stretchPaths = (svg) => [...svg.matchAll(/<path class="stretch (acct-\d|stretch-gap)"[^>]*d="([^"]+)"/g)]
  .map((m) => ({ cls: m[1], d: m[2] }))
const arcEnds = (d) => {
  const m = d.match(/^M ([-\d.]+) ([-\d.]+) A [\d.]+ [\d.]+ 0 (\d) 1 ([-\d.]+) ([-\d.]+)$/)
  assert.ok(m, `not an arc: ${d}`)
  return { start: [Number(m[1]), Number(m[2])], large: Number(m[3]), end: [Number(m[4]), Number(m[5])] }
}
const near = (actual, expected, tolerance = 0.05) => Math.abs(actual - expected) <= tolerance
const handOf = (svg) => {
  const m = svg.match(/<line class="clock-hand" x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)"/)
  assert.ok(m, 'no hand')
  return m.slice(1).map(Number)
}

test('turn puts Zurich 15:00 at 15/24 on the day face and Thursday 15:00 at (3·24+15)/168 on the week face', () => {
  assert.ok(near(turn(NOON, 'session', TZ), 0.625, 1e-6))
  assert.ok(near(turn(NOON, 'weekly', TZ), (3 * 24 + 15) / 168, 1e-6))
})

test('turn puts Monday 00:00 local at 0 on the week face', () => {
  assert.equal(turn(MONDAY, 'weekly', TZ), 0)
  assert.equal(turn(MONDAY, 'session', TZ), 0)
})

test('turn works without a time zone, which means the browser zone', () => {
  assert.doesNotThrow(() => turn(NOON, 'session'))
  assert.doesNotThrow(() => timeLabel(NOON, NOON))
})

test('timeLabel shows HH:MM on the same local day and Wed HH:MM otherwise', () => {
  assert.equal(timeLabel(NOON, NOON, TZ), '15:00')
  assert.equal(timeLabel(NOON + DAY, NOON, TZ), 'Fri 15:00')
  assert.equal(timeLabel(MONDAY, NOON, TZ), 'Mon 00:00')
  assert.equal(timeLabel(MONDAY + 30 * 60 - 1, MONDAY, TZ), '00:29')
})

test('HORIZON is one day and one week in seconds', () => {
  assert.deepEqual(HORIZON, { session: DAY, weekly: 7 * DAY })
})

test('the day face has 24 ticks, four labels and a hand at 15:00', () => {
  const svg = svgOf(clock({ accounts: [] }), 'session')
  assert.match(svg, /^<svg[^>]* viewBox="0 0 220 220"/)
  assert.equal(count(svg, /class="clock-tick/g), 24)
  assert.equal(count(svg, /class="clock-tick major"/g), 4)
  assert.deepEqual([...svg.matchAll(/<text class="clock-label"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]), ['00', '06', '12', '18'])
  const [x1, y1, x2, y2] = handOf(svg)
  const [ex1, ey1] = at(65, 225)
  const [ex2, ey2] = at(95, 225)
  assert.ok(near(x1, ex1) && near(y1, ey1) && near(x2, ex2) && near(y2, ey2), `hand ${[x1, y1, x2, y2]}`)
})

test('the week face has 7 ticks, Mon to Sun labels and the weekday in full in the centre', () => {
  const svg = svgOf(clock({ accounts: [] }), 'weekly')
  assert.equal(count(svg, /class="clock-tick major"/g), 7)
  assert.equal(count(svg, /class="clock-tick"/g), 0)
  assert.deepEqual([...svg.matchAll(/<text class="clock-label"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]),
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
  const lines = centre(svg)
  assert.ok(lines.some((l) => l.cls === 'clock-day' && l.text === 'Thursday' && l.y === 106))
  assert.ok(lines.some((l) => l.cls === 'clock-time' && l.text === '15:00' && l.y === 92))
  const [x1, y1] = handOf(svg)
  const [hx, hy] = at(65, (87 / 168) * 360)
  assert.ok(near(x1, hx) && near(y1, hy), 'hand at Thursday 15:00 on the week ring')
})

test('a single stretch to the horizon draws one stretch path with the large-arc flag set', () => {
  const a = acct('a', [win('weekly', 60, 100)])
  const svg = svgOf(clock({ active: 'a', accounts: [a] }), 'session')
  const paths = stretchPaths(svg)
  assert.equal(paths.length, 1)
  assert.equal(paths[0].cls, 'acct-1')
  const { start, end, large } = arcEnds(paths[0].d)
  assert.equal(large, 1)
  assert.ok(Math.hypot(end[0] - start[0], end[1] - start[1]) < 1.5, 'the arc closes on its start')
})

test('a gap that ends inside the horizon draws a stretch-gap path and the centre says nothing until it ends', () => {
  const svg = svgOf(clock({ accounts: [acct('x', [win('session', 5, 5)])] }), 'session')
  assert.equal(stretchPaths(svg)[0].cls, 'stretch-gap')
  const lines = centre(svg)
  assert.ok(lines.some((l) => l.cls === 'clock-gap' && l.y === 118 && l.text === `nothing until ${timeLabel(NOON + 5 * HOUR, NOON, TZ)}`))
  assert.equal(lines.some((l) => l.text.startsWith('runs')), false)
})

test('a gap with no accounts draws one stretch-gap path to the horizon, and the centre says nothing to run', () => {
  const svg = svgOf(clock({ accounts: [] }), 'session')
  const paths = stretchPaths(svg)
  assert.equal(paths.length, 1)
  assert.equal(paths[0].cls, 'stretch-gap')
  assert.equal(arcEnds(paths[0].d).large, 1)
  assert.ok(svg.includes('<text class="clock-gap" x="110" y="118"'))
})

// The swap fixture: a runs down to its threshold after 1.75 h and hands over to b.
const swapClock = (aIndex = 1, bIndex = 2) => clock({
  active: 'a',
  accounts: [
    acct('a', [win('session', 50, 2.5), win('weekly', 90, 100)], { updated: NOON, index: aIndex }),
    acct('s', [win('weekly', 0, 60)], { index: 3 }),
    acct('b', [], { index: bIndex }),
  ],
})

test('a swap draws a clock-swap tick and the centre names the account, runs until, then the next', () => {
  const svg = svgOf(swapClock(), 'session')
  assert.equal(count(svg, /class="clock-swap"/g), 1)
  assert.deepEqual(stretchPaths(svg).map((p) => p.cls), ['acct-1', 'acct-2'])
  const lines = centre(svg)
  assert.deepEqual(lines.map((l) => [l.y, l.cls, l.text]), [
    [98, 'clock-time', '15:00'],
    [118, 'clock-name acct-1', 'a'],
    [132, 'clock-runs', `runs until ~${timeLabel(NOON + 1.75 * HOUR, NOON, TZ)}`],
    [146, 'clock-then', 'then b'],
  ])
  assert.equal(timeLabel(NOON + 1.75 * HOUR, NOON, TZ), '16:45')
})

test('a refill draws a numbered dot at radius 91 with the account index in it', () => {
  const svg = svgOf(swapClock(2, 3), 'session')
  const refillAt = NOON + 2.5 * HOUR
  const [cx, cy] = at(91, turn(refillAt, 'session', TZ) * 360)
  const dot = svg.match(/<circle class="clock-refill acct-2" cx="([-\d.]+)" cy="([-\d.]+)" r="5.5"/)
  assert.ok(dot, 'refill dot for account 2')
  assert.ok(near(Number(dot[1]), cx, 0.02) && near(Number(dot[2]), cy, 0.02))
  assert.ok(svg.includes('<text class="clock-refill-num"'), 'the dot is numbered')
  assert.match(svg, />2<\/text>/)
})

test('the centre lines sit at the spec y positions on both faces, all at x 110', () => {
  const day = centre(svgOf(swapClock(), 'session'))
  assert.deepEqual(day.map((l) => l.y), [CENTRE_Y.session.time, CENTRE_Y.session.name, CENTRE_Y.session.runs, CENTRE_Y.session.then])
  const week = centre(svgOf(swapClock(), 'weekly'))
  assert.deepEqual(week.map((l) => l.y), [CENTRE_Y.weekly.time, CENTRE_Y.weekly.day, CENTRE_Y.weekly.name, CENTRE_Y.weekly.runs, CENTRE_Y.weekly.then])
  assert.ok(week.some((l) => l.text === 'then b' && l.y === 150))
  const svg = svgOf(swapClock(), 'session')
  assert.equal(count(svg, /<text class="clock-time"[^>]* font-size="20"[^>]* font-weight="bold"/g), 1)
})

test('the centre name takes its row colour modulo five, so row 6 is acct-1', () => {
  const svg = svgOf(clock({ active: 'a', accounts: [acct('a', [win('weekly', 60, 100)], { index: 6 })] }), 'session')
  assert.equal(centre(svg).find((l) => l.cls.startsWith('clock-name')).cls, 'clock-name acct-1')
})

test('the second stretch starts in degrees exactly where the first ends', () => {
  const [first, second] = stretchPaths(svgOf(swapClock(), 'session')).map((p) => arcEnds(p.d))
  assert.deepEqual(first.end, second.start)
})

test('a full-horizon stretch closes its arc on a DST day, when the local day is 23 or 25 hours', () => {
  const dstEve = Date.UTC(2026, 2, 28, 22, 30, 0) / 1000
  const svg = svgOf(clock({ active: 'a', accounts: [acct('a', [win('weekly', 60, 100)])] }), 'session', dstEve)
  const { start, end, large } = arcEnds(stretchPaths(svg)[0].d)
  assert.equal(large, 1)
  assert.ok(Math.hypot(end[0] - start[0], end[1] - start[1]) < 1.5, 'the arc closes on its start')
})

test('the labels sit at radius 102 on the day face', () => {
  const svg = svgOf(clock({ accounts: [] }), 'session')
  const [x, y] = svg.match(/<text class="clock-label" x="([-\d.]+)" y="([-\d.]+)"[^>]*>06</).slice(1).map(Number)
  const [ex, ey] = at(102, 90)
  assert.ok(near(x, ex) && near(y, ey))
})

test('a first stretch that runs to the horizon says runs all day on the day face and runs all week on the week face', () => {
  const full = clock({ active: 'a', accounts: [acct('a', [win('weekly', 60, 100)])] })
  assert.ok(centre(svgOf(full, 'session')).some((l) => l.cls === 'clock-runs' && l.text === 'runs all day'))
  assert.ok(centre(svgOf(full, 'weekly')).some((l) => l.cls === 'clock-runs' && l.text === 'runs all week'))
})

// The visible line is short: the chord cuts a longer one at this size.
test('a gap that reaches the horizon says nothing to run', () => {
  const spent = clock({ accounts: [acct('x', [win('session', 5, 48)])] })
  const svg = svgOf(spent, 'session')
  assert.ok(svg.includes('<text class="clock-gap" x="110" y="118" font-size="10" text-anchor="middle"><title>nothing to run</title>nothing to run</text>'))
  const gap = centre(svg).find((l) => l.cls === 'clock-gap')
  assert.equal(gap.text, 'nothing to run')
})

// 2026-10-25 01:00Z is 03:00 CEST, the moment the clocks go back to 02:00 CET. The stretch runs 00:30Z to 01:30Z, that is
// 02:30 CEST to 02:30 CET: both ends sit at the same angle on the day face, so it must draw as a sliver, not a near-full circle.
test('a one-hour stretch across the repeated hour of a fall-back day draws a small arc, not a near-full circle', () => {
  const fallNow = Date.UTC(2026, 9, 24, 22, 30, 0) / 1000
  const aResets = fallNow + 2 * HOUR
  const bResets = fallNow + 2 * HOUR + 50 * 60
  // a is spent until its window resets at 00:30Z, then burns 85 points in about an hour; b is spent until 01:20Z, so it is
  // ready when a runs down to its threshold at about 01:30Z.
  const c = clock({
    active: 'a',
    accounts: [
      acct('a', [{ group: 'session', scope: null, remaining: 0, resetsAt: aResets }], { updated: aResets - (5 * HOUR - 4235) }),
      acct('b', [{ group: 'session', scope: null, remaining: 0, resetsAt: bResets }], { index: 2 }),
    ],
  })
  const projected = project(c, fallNow, DAY).stretches
  const fromA = projected.find((s) => s.account === 'a')
  assert.ok(fromA, 'the projection runs a')
  assert.ok(Math.abs(fromA.from - aResets) < 1 && Math.abs(fromA.to - (fallNow + 3 * HOUR)) < 60, `a runs ${fromA.from}..${fromA.to}`)
  const svg = svgOf(c, 'session', fallNow)
  // The paths follow the projection's stretches one for one, so a's fall-back stretch is the path at its index.
  const { start, end, large } = arcEnds(stretchPaths(svg)[projected.indexOf(fromA)].d)
  assert.equal(stretchPaths(svg)[projected.indexOf(fromA)].cls, 'acct-1')
  assert.equal(large, 0)
  assert.ok(Math.hypot(end[0] - start[0], end[1] - start[1]) < 20, `endpoints ${start} ${end}`)
})

test('a short stretch that crosses local midnight still sweeps across midnight, not a sliver', () => {
  // now is 23:30 in Zurich; a runs down to its threshold at about 00:12 the next day, then b takes over.
  const lateNow = Date.UTC(2026, 9, 22, 21, 30, 0) / 1000
  // a is at 50 with its window resetting in 4 h and used 50 points in the last hour: it runs down to 15 in about 42 minutes.
  const c = clock({
    active: 'a',
    accounts: [
      acct('a', [{ group: 'session', scope: null, remaining: 50, resetsAt: lateNow + 4 * HOUR }], { updated: lateNow }),
      acct('b', [], { index: 2 }),
    ],
  })
  const stretch = project(c, lateNow, DAY).stretches.find((s) => s.account === 'a')
  assert.ok(stretch && stretch.to - stretch.from < HOUR, 'a short stretch')
  const { end, large } = arcEnds(stretchPaths(svgOf(c, 'session', lateNow)).find((p) => p.cls === 'acct-1').d)
  const [ex, ey] = at(80, turn(stretch.to, 'session', TZ) * 360)
  assert.equal(large, 0)
  assert.ok(near(end[0], ex, 0.1) && near(end[1], ey, 0.1), `ends at the stretch's end ${end}`)
  // The stretch crosses midnight, so its sweep is the few degrees past 23:30 and not the 350 the wrap-free step would give.
  const sweep = (((turn(stretch.to, 'session', TZ) - turn(stretch.from, 'session', TZ)) % 1) + 1) % 1 * 360
  assert.ok(sweep > 5 && sweep < 30, `sweep ${sweep}`)
})

test('a first stretch followed by a gap says then nothing', () => {
  const c = clock({
    active: 'a',
    accounts: [acct('a', [win('session', 50, 4), win('weekly', 90, 100)], { updated: NOON }), acct('b', [win('session', 5, 2.6)], { index: 2 })],
  })
  const lines = centre(svgOf(c, 'session'))
  assert.ok(lines.some((l) => l.cls === 'clock-then gap' && l.y === 146 && l.text === 'then nothing'), JSON.stringify(lines))
})

test('the swap tick carries no stroke-width attribute of its own, so the CSS width applies', () => {
  const svg = svgOf(swapClock(), 'session')
  assert.equal(count(svg, /<line class="clock-swap"[^>]*stroke-width/g), 0)
})

test('a long account name is cut to its line and the full name stays in a title', () => {
  const name = 'Abteilung Entwicklung Plattform Zuerich Nord'
  const svg = svgOf(clock({ active: 'a', accounts: [acct('a', [win('weekly', 60, 100)], { name })] }), 'session')
  const line = centre(svg).find((l) => l.cls === 'clock-name acct-1')
  assert.ok(line.text.endsWith('…'), `cut: ${line.text}`)
  assert.ok(line.text.length < name.length)
  assert.ok(svg.includes(`<title>${name}</title>`))
})

test('account names are escaped in the centre and the titles', () => {
  const svg = svgOf(clock({ active: 'a', accounts: [acct('a', [win('weekly', 60, 100)], { name: 'A<B & C' })] }), 'session')
  assert.ok(svg.includes('A&lt;B &amp; C'))
  assert.ok(!svg.includes('A<B'))
})

test('clock.mjs has no imports and no script terminator', () => {
  const source = readFileSync(new URL('../lib/clock.mjs', import.meta.url), 'utf8')
  assert.equal(/^import /m.test(source), false)
  assert.equal(/^export .* from /m.test(source), false)
  assert.equal(source.includes('</script'), false)
  assert.equal(source.includes('import.meta'), false)
  assert.equal(/^await /m.test(source), false)
})

test('the projection the face draws is the one project returns', () => {
  const c = swapClock()
  const t = project(c, NOON, DAY)
  const svg = svgOf(c, 'session')
  assert.equal(stretchPaths(svg).length, t.stretches.length)
})
