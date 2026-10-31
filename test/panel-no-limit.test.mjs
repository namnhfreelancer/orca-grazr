import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPanelData, centre, hostDefaultView, NO_FIVE_HOUR_LIMIT, noFiveHourLimit, rowState } from '../lib/panel-data.mjs'
import { renderPanel, ringSvg } from '../lib/panel.mjs'

const NOW = new Date('2026-10-31T10:00:00Z')
const TZ = 'Europe/Zurich'
const FUTURE = '2026-11-05T10:00:00Z'
const PAST = '2026-10-31T09:00:00Z'

const session = (remaining, resets_at = FUTURE) => ({ kind: 'session', scope: null, group: 'session', remaining, resets_at })
const weekly = (remaining, resets_at = FUTURE) => ({ kind: 'weekly_all', scope: null, group: 'weekly', remaining, resets_at })

// `a` is active with a 5-hour window; `c` is the next account, so `b` is not next (NEXT takes the row label before any 5-hour wording);
// `b` has a weekly reading only (a plan with no 5-hour limit).
const mixed = (bSnapshot) => ({
  active: { id: 'a1', name: 'a' },
  order: ['a', 'c', 'b'],
  settings: { enabled: true, thresholds: { session: 15, weekly: 20 } },
  accounts: [
    { name: 'a', id: 'a1', parked: false, blocked: null, in_order: true, updated: NOW.getTime() / 1000, snapshot: [session(42), weekly(80)] },
    { name: 'c', id: 'c3', parked: true, blocked: null, in_order: true, updated: null, snapshot: [session(50), weekly(60)] },
    { name: 'b', id: 'b2', parked: true, blocked: null, in_order: true, updated: null, snapshot: bSnapshot },
  ],
})

const weeklyOnly = () => mixed([weekly(70)])

const byName = (report, name) => report.accounts.find((a) => a.name === name)
const hostsOf = (report, panelView = 'session') => buildPanelData({
  settings: { hosts: [{ name: 'mac' }], target: 'mac', panelView },
  now: NOW,
  timeZone: TZ,
  hosts: [{ host: { name: 'mac' }, result: { ok: true, value: report } }],
})

test('an account with a live weekly reading and no session entry has no 5-hour limit', () => {
  assert.equal(noFiveHourLimit(byName(weeklyOnly(), 'b'), NOW), true)
  assert.equal(noFiveHourLimit(byName(weeklyOnly(), 'a'), NOW), false, 'a session entry means a 5-hour limit')
})

test('an account with no readings at all keeps no reading, not the no-limit wording', () => {
  const report = mixed([])
  assert.equal(noFiveHourLimit(byName(report, 'b'), NOW), false)
  assert.deepEqual(rowState(byName(report, 'b'), report, 'session', { now: NOW, timeZone: TZ }), { percent: null, status: 'unread', label: 'not read yet' })
})

test('an expired weekly reading alone is not a current limit: the account has no reading', () => {
  const report = mixed([weekly(70, PAST)])
  assert.equal(noFiveHourLimit(byName(report, 'b'), NOW), false)
  assert.equal(rowState(byName(report, 'b'), report, 'session', { now: NOW, timeZone: TZ }).status, 'unread')
})

test('the 5-hour row says no 5-hour limit, muted, and is not spent', () => {
  const report = weeklyOnly()
  const row = rowState(byName(report, 'b'), report, 'session', { now: NOW, timeZone: TZ })
  assert.deepEqual(row, { percent: null, status: 'no-limit', label: NO_FIVE_HOUR_LIMIT })
})

test('the Week view of the same account still shows its weekly reading', () => {
  const report = weeklyOnly()
  assert.deepEqual(rowState(byName(report, 'b'), report, 'weekly', { now: NOW, timeZone: TZ }), { percent: 70, status: 'ok', label: '' })
})

test('the centre of a 5-hour view on a no-limit active account says no 5-hour limit, muted', () => {
  const report = { ...weeklyOnly(), active: { id: 'b2', name: 'b' }, order: ['b', 'a', 'c'] }
  const c = centre(report, 'session', { now: NOW })
  assert.equal(c.hint, NO_FIVE_HOUR_LIMIT)
  assert.equal(c.tone, 'none')
  assert.equal(c.percentText, '—')
})

test('the dial tooltip and segment of a no-limit account read no 5-hour limit, in the muted tone', () => {
  const data = hostsOf(weeklyOnly())
  const view = data.hosts[0].views.session
  const seg = view.segments.find((x) => x.name === 'b')
  assert.equal(seg.noLimit, true)
  assert.equal(seg.tone, 'none')
  assert.equal(seg.state, 'unknown')
  const svg = ringSvg(view, 'session')
  assert.ok(svg.includes(`data-tip-left="${NO_FIVE_HOUR_LIMIT}"`))
  assert.equal(svg.includes('data-tip-left="no reading"'), false)
})

test('an account with no readings at all keeps no reading in the 5-hour tooltip', () => {
  const data = hostsOf(mixed([]))
  const view = data.hosts[0].views.session
  assert.equal(view.segments.find((x) => x.name === 'b').noLimit, false)
  assert.ok(ringSvg(view, 'session').includes('data-tip-left="no reading"'))
})

test('the list face omits the 5-hour row for a no-limit account', () => {
  const data = hostsOf(weeklyOnly())
  const b = data.hosts[0].list.accounts.find((a) => a.name === 'b')
  assert.deepEqual(b.windows.map((w) => w.label), ['Week'])
})

test('a host with no 5-hour entries on any account and a live weekly reading opens on Week', () => {
  const report = weeklyOnly()
  report.accounts = report.accounts.filter((a) => a.name !== 'a').map((a) => ({ ...a, snapshot: a.name === 'b' ? a.snapshot : [weekly(60)] }))
  report.active = null
  assert.equal(hostDefaultView(report, 'session', NOW), 'weekly')
  assert.equal(hostsOf(report, 'session').hosts[0].view, 'weekly')
  assert.equal(hostDefaultView(report, 'weekly', NOW), 'weekly')
})

test('a host where one account has a 5-hour entry keeps the panelView setting', () => {
  assert.equal(hostDefaultView(weeklyOnly(), 'session', NOW), 'session')
  assert.equal(hostsOf(weeklyOnly(), 'session').hosts[0].view, 'session')
})

test('a host with no weekly reading keeps the setting, even with no 5-hour entries', () => {
  const report = mixed([])
  report.accounts[0].snapshot = []
  assert.equal(hostDefaultView(report, 'session', NOW), 'session')
})

test('the card of a no-limit host opens on Week while the 5h button stays', () => {
  const data = hostsOf(weeklyOnly(), 'session')
  const html = renderPanel(data, { template: '<html><body><!--__CARDS__--><script>/*__CLOCK__*/ /*__DATA__*/</script></body></html>' })
  assert.ok(html.includes('data-view="weekly"'))
  assert.ok(html.includes('<button class="view" data-view="session">5h</button>'))
})

const segmentOf = (data, name) => data.hosts[0].views.session.segments.find((x) => x.name === name)
const rowOf = (data, name) => data.hosts[0].views.session.rows.find((x) => x.name === name)

test('the active account with no 5-hour window says so in its tooltip and its row', () => {
  const report = { ...weeklyOnly(), active: { id: 'b2', name: 'b' }, order: ['b', 'a', 'c'] }
  const data = hostsOf(report)
  assert.equal(rowOf(data, 'b').status, 'active')
  assert.equal(rowOf(data, 'b').label, `active · ${NO_FIVE_HOUR_LIMIT}`)
  assert.equal(segmentOf(data, 'b').noLimit, true)
  assert.ok(ringSvg(data.hosts[0].views.session, 'session').includes(`data-tip-left="${NO_FIVE_HOUR_LIMIT}"`))
})

test('the next account with no 5-hour window says so in its tooltip and its row, and keeps NEXT', () => {
  const report = { ...weeklyOnly(), order: ['a', 'b', 'c'] }
  const data = hostsOf(report)
  assert.equal(rowOf(data, 'b').status, 'next')
  assert.equal(rowOf(data, 'b').label, `NEXT ▸ · ${NO_FIVE_HOUR_LIMIT}`)
  assert.equal(segmentOf(data, 'b').noLimit, true)
  assert.equal(segmentOf(data, 'b').tone, 'warning', 'the next account keeps its tone')
})

test('a mixed host keeps the configured view and labels only the account with no 5-hour window', () => {
  const report = weeklyOnly()
  report.accounts[2].plan = { type: 'claude_max', seat_tier: 'default_claude_max_20x' }
  const data = hostsOf(report, 'session')
  assert.equal(data.hosts[0].view, 'session')
  assert.equal(rowOf(data, 'b').label, NO_FIVE_HOUR_LIMIT)
  assert.equal(rowOf(data, 'a').label, 'active')
  assert.equal(rowOf(data, 'c').label, 'NEXT ▸')
  assert.equal(segmentOf(data, 'a').noLimit, false)
  assert.equal(segmentOf(data, 'c').noLimit, false)
  assert.equal(segmentOf(data, 'b').noLimit, true)
})
