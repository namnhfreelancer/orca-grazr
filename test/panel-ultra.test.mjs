import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPanelData, centre, hostDefaultView, listOf, nextAccount, NO_FIVE_HOUR_ULTRA, rowState, ultraNoLimit } from '../lib/panel-data.mjs'
import { renderCard, renderPanel, ringSvg } from '../lib/panel.mjs'

const NOW = new Date('2026-10-31T10:00:00Z')
const TZ = 'Europe/Zurich'
const FUTURE = '2026-11-05T10:00:00Z'
const SUFFIX = ' · Ultra: week only'

const session = (remaining, resets_at = FUTURE) => ({ kind: 'session', scope: null, group: 'session', remaining, resets_at })
const weekly = (remaining, resets_at = FUTURE) => ({ kind: 'weekly_all', scope: null, group: 'weekly', remaining, resets_at })

const PRO = { type: 'claude_pro' }
const TEAM = { type: 'claude_team', seat_tier: 'default_claude_max_5x' }
const ULTRA = { type: 'claude_max', seat_tier: 'default_claude_max_20x' }

// Ids are names. The active account is not parked, as the engine reports it; the others are parked.
const account = (name, active, extra) => ({
  id: name, name, parked: name !== active, blocked: null, in_order: true, updated: null, ...extra,
})

// a is Pro with a 5-hour window (42 left, not spent); b is Ultra with a 5-hour window at 5% (below the 15% threshold);
// c is Ultra and full. With the flag on, b's and c's 5-hour windows do not count.
const fixture = ({ flag = true, active = 'a', accounts, order = ['a', 'c', 'b'] } = {}) => ({
  active: { id: active, name: active },
  order,
  settings: { enabled: true, thresholds: { session: 15, weekly: 20 }, ultra_no_session: flag },
  accounts: accounts ?? [
    account('a', active, { plan: PRO, snapshot: [session(42), weekly(80)] }),
    account('b', active, { plan: ULTRA, ultra: true, snapshot: [session(5), weekly(70)] }),
    account('c', active, { plan: ULTRA, ultra: true, snapshot: [session(100), weekly(90)] }),
  ],
})

const byName = (report, name) => report.accounts.find((a) => a.name === name)
const hostOf = (report, panelView = 'session') => buildPanelData({
  settings: { hosts: [{ name: 'mac' }], target: 'mac', panelView },
  now: NOW,
  timeZone: TZ,
  hosts: [{ host: { name: 'mac' }, result: { ok: true, value: report } }],
}).hosts[0]
const rowOf = (host, name) => host.views.session.rows.find((r) => r.name === name)
const segOf = (host, name) => host.views.session.segments.find((s) => s.name === name)

test('an Ultra account with the flag on reads no 5-hour limit on the 5h view, muted, and is not spent for its 5-hour window', () => {
  const report = fixture()
  assert.deepEqual(rowState(byName(report, 'b'), report, 'session', { now: NOW, timeZone: TZ }), { percent: null, status: 'no-limit', label: NO_FIVE_HOUR_ULTRA })
  assert.deepEqual(rowState(byName(report, 'a'), report, 'session', { now: NOW, timeZone: TZ }), { percent: 42, status: 'active', label: 'active' })
})

test('the next account with the flag on keeps NEXT and names the wording after it', () => {
  const report = fixture()
  assert.equal(nextAccount(report, NOW).name, 'c')
  assert.deepEqual(rowState(byName(report, 'c'), report, 'session', { now: NOW, timeZone: TZ }), { percent: null, status: 'next', label: `NEXT ▸ · ${NO_FIVE_HOUR_ULTRA}` })
})

test('the Week view of an Ultra account keeps its weekly reading', () => {
  const report = fixture()
  assert.deepEqual(rowState(byName(report, 'b'), report, 'weekly', { now: NOW, timeZone: TZ }), { percent: 70, status: 'ok', label: '' })
})

test('an active Ultra account reads no 5-hour limit in its row and its centre, and the centre is muted', () => {
  const report = fixture({ active: 'b', order: ['a', 'c', 'b'] })
  assert.deepEqual(rowState(byName(report, 'b'), report, 'session', { now: NOW, timeZone: TZ }), { percent: null, status: 'active', label: `active · ${NO_FIVE_HOUR_ULTRA}` })
  const c = centre(report, 'session', { now: NOW })
  assert.equal(c.name, 'b')
  assert.equal(c.percentText, '—')
  assert.equal(c.hint, NO_FIVE_HOUR_ULTRA)
  assert.equal(c.tone, 'none')
})

test('the dial segment and its tooltip of an Ultra account read no 5-hour limit, muted, with no reading', () => {
  const host = hostOf(fixture())
  const seg = segOf(host, 'b')
  assert.equal(seg.noLimit, true)
  assert.equal(seg.noLimitText, NO_FIVE_HOUR_ULTRA)
  assert.equal(seg.remaining, null)
  assert.equal(seg.tone, 'none')
  assert.equal(seg.state, 'unknown')
  const svg = ringSvg(host.views.session, 'session')
  assert.ok(svg.includes(`data-tip-left="${NO_FIVE_HOUR_ULTRA}"`))
  assert.equal(svg.includes('data-tip-left="5% left"'), false)
})

test('the list face omits the 5-hour bar of an Ultra account and keeps its week', () => {
  const list = listOf(fixture(), { now: NOW, timeZone: TZ })
  assert.deepEqual(list.accounts.find((a) => a.name === 'b').windows.map((w) => w.label), ['Week'])
  assert.deepEqual(list.accounts.find((a) => a.name === 'b').windows[0].left, 70)
  assert.deepEqual(list.accounts.find((a) => a.name === 'a').windows.map((w) => w.label), ['5h', 'Week'])
})

test('the clock of an Ultra account carries no 5-hour window', () => {
  const host = hostOf(fixture())
  const b = host.clock.accounts.find((a) => a.name === 'b')
  assert.deepEqual(b.windows.map((w) => w.group), ['weekly'])
  assert.deepEqual(host.clock.accounts.find((a) => a.name === 'a').windows.map((w) => w.group), ['session', 'weekly'])
})

test('the card header appends Ultra: week only when the host has an Ultra account with no 5-hour limit', () => {
  const host = hostOf(fixture())
  const html = renderCard(host, {}, { timeZone: TZ })
  assert.ok(html.includes(`<p class="thresholds">swaps below 15% 5h · 20% week · updated 11:00${SUFFIX}</p>`))
})

test('a host with an Ultra account opens on the configured view when it also has a 5-hour account', () => {
  const host = hostOf(fixture(), 'session')
  assert.equal(host.view, 'session')
  assert.equal(rowOf(host, 'a').label, 'active')
  assert.equal(rowOf(host, 'b').label, NO_FIVE_HOUR_ULTRA)
  assert.ok(renderCard(host, {}, { timeZone: TZ }).includes(SUFFIX))
})

test('a host where every account with a reading is Ultra opens on Week', () => {
  const report = fixture({
    active: 'b',
    order: ['b', 'c'],
    accounts: [
      account('b', 'b', { plan: ULTRA, ultra: true, snapshot: [session(5), weekly(70)] }),
      account('c', 'b', { plan: ULTRA, ultra: true, snapshot: [session(100), weekly(90)] }),
    ],
  })
  assert.equal(hostDefaultView(report, 'session', NOW), 'weekly')
  const host = hostOf(report, 'session')
  assert.equal(host.view, 'weekly')
  const html = renderPanel(buildPanelData({
    settings: { hosts: [{ name: 'mac' }], target: 'mac', panelView: 'session' },
    now: NOW,
    timeZone: TZ,
    hosts: [{ host: { name: 'mac' }, result: { ok: true, value: report } }],
  }), { template: '<html><body><!--__CARDS__--><script>/*__CLOCK__*/ /*__DATA__*/</script></body></html>' })
  assert.ok(html.includes(' data-view="weekly" data-face='))
  assert.ok(html.includes(SUFFIX))
})

test('with the flag off an Ultra account reads its 5-hour window as before, with no header suffix', () => {
  const report = fixture({ flag: false })
  const b = byName(report, 'b')
  assert.equal(ultraNoLimit(b, report), false)
  assert.deepEqual(rowState(b, report, 'session', { now: NOW, timeZone: TZ }), { percent: 5, status: 'spent', label: 'spent · resets Thu 11:00' })
  const host = hostOf(report)
  assert.equal(segOf(host, 'b').noLimit, false)
  assert.equal(segOf(host, 'b').noLimitText, null)
  assert.equal(rowOf(host, 'b').label.includes('Ultra'), false)
  assert.equal(renderCard(host, {}, { timeZone: TZ }).includes('Ultra: week only'), false)
})

test('with the flag off a host with only Ultra accounts keeps the configured view', () => {
  const report = fixture({ flag: false, active: 'b', accounts: [
    account('b', 'b', { plan: ULTRA, ultra: true, snapshot: [session(5), weekly(70)] }),
    account('c', 'b', { plan: ULTRA, ultra: true, snapshot: [session(100), weekly(90)] }),
  ], order: ['b', 'c'] })
  assert.equal(hostOf(report, 'session').view, 'session')
})

test('with the flag off an Ultra account below its 5-hour threshold is not eligible for next', () => {
  const report = fixture({ flag: false, order: ['a', 'b'], accounts: [
    account('a', 'a', { plan: PRO, snapshot: [session(42), weekly(80)] }),
    account('b', 'a', { plan: ULTRA, ultra: true, snapshot: [session(5), weekly(70)] }),
  ] })
  assert.equal(nextAccount(report, NOW), null)
})

test('with the flag on an Ultra account below its 5-hour threshold stays eligible for next, as the engine treats it', () => {
  const report = fixture({ order: ['a', 'b'], accounts: [
    account('a', 'a', { plan: PRO, snapshot: [session(42), weekly(80)] }),
    account('b', 'a', { plan: ULTRA, ultra: true, snapshot: [session(5), weekly(70)] }),
  ] })
  assert.equal(nextAccount(report, NOW).name, 'b')
})

test('an Ultra account whose week is spent is still spent on the 5-hour view', () => {
  const report = fixture({ accounts: [
    account('a', 'a', { plan: PRO, snapshot: [session(42), weekly(80)] }),
    account('b', 'a', { plan: ULTRA, ultra: true, snapshot: [session(100), weekly(10)] }),
  ], order: ['a', 'b'] })
  assert.equal(rowState(byName(report, 'b'), report, 'session', { now: NOW, timeZone: TZ }).status, 'spent')
  assert.equal(rowState(byName(report, 'b'), report, 'weekly', { now: NOW, timeZone: TZ }).status, 'spent')
})

test('without an ultra field, an account on the Ultra plan is Ultra', () => {
  const report = fixture({ accounts: [
    account('a', 'a', { plan: PRO, snapshot: [session(42), weekly(80)] }),
    account('b', 'a', { plan: ULTRA, snapshot: [session(5), weekly(70)] }),
  ], order: ['a', 'b'] })
  assert.equal(ultraNoLimit(byName(report, 'b'), report), true)
  assert.equal(rowState(byName(report, 'b'), report, 'session', { now: NOW, timeZone: TZ }).label, `NEXT ▸ · ${NO_FIVE_HOUR_ULTRA}`, 'b is next')
})

test('without an ultra field, a Pro account is not Ultra even with the flag on', () => {
  const report = fixture({ accounts: [
    account('a', 'a', { plan: PRO, snapshot: [session(42), weekly(80)] }),
    account('b', 'a', { plan: PRO, snapshot: [session(5), weekly(70)] }),
  ], order: ['a', 'b'] })
  assert.equal(ultraNoLimit(byName(report, 'b'), report), false)
  assert.equal(rowState(byName(report, 'b'), report, 'session', { now: NOW, timeZone: TZ }).status, 'spent')
})

test('an explicit ultra false wins over an Ultra plan label', () => {
  const report = fixture({ accounts: [
    account('a', 'a', { plan: PRO, snapshot: [session(42), weekly(80)] }),
    account('b', 'a', { plan: ULTRA, ultra: false, snapshot: [session(5), weekly(70)] }),
  ], order: ['a', 'b'] })
  assert.equal(ultraNoLimit(byName(report, 'b'), report), false)
})

test('a Team account is unaffected by the flag, and its 5-hour window still counts', () => {
  const report = fixture({ accounts: [
    account('a', 'a', { plan: PRO, snapshot: [session(42), weekly(80)] }),
    account('b', 'a', { plan: TEAM, ultra: false, snapshot: [session(5), weekly(70)] }),
  ], order: ['a', 'b'] })
  assert.equal(ultraNoLimit(byName(report, 'b'), report), false)
  assert.equal(rowState(byName(report, 'b'), report, 'session', { now: NOW, timeZone: TZ }).status, 'spent')
  assert.equal(hostOf(report).ultraNoSession, false)
})

test('a host with no Ultra account has no header suffix, even with the flag on', () => {
  const report = fixture({ accounts: [
    account('a', 'a', { plan: PRO, snapshot: [session(42), weekly(80)] }),
    account('b', 'a', { plan: TEAM, snapshot: [session(60), weekly(70)] }),
  ], order: ['a', 'b'] })
  const host = hostOf(report)
  assert.equal(host.ultraNoSession, false)
  assert.equal(host.view, 'session')
  assert.equal(renderCard(host, {}, { timeZone: TZ }).includes('Ultra: week only'), false)
})

test('a mixed host with a Pro account on the 5-hour view keeps its configured view and labels only the Ultra account', () => {
  const host = hostOf(fixture(), 'session')
  assert.equal(host.view, 'session')
  assert.equal(segOf(host, 'a').noLimit, false)
  assert.equal(segOf(host, 'b').noLimitText, NO_FIVE_HOUR_ULTRA)
  assert.equal(segOf(host, 'c').noLimitText, NO_FIVE_HOUR_ULTRA)
})
