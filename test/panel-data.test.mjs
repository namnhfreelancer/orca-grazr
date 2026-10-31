import { test } from 'node:test'
import assert from 'node:assert/strict'
import { windowOf, nextAccount, rowState, centre, hostChip, orderedAccounts, buildPanelData } from '../lib/panel-data.mjs'

const ZONE = { timeZone: 'Europe/Zurich' }
const NOW = new Date('2026-10-21T10:00:00Z')
const at = { ...ZONE, now: NOW }
const thresholds = { session: 15, weekly: 20 }

// The entries the engine reports: the 5h window is group session, the weekly one group weekly, both account-wide (scope null).
const session = (remaining, resets_at = null) => ({ kind: 'session', scope: null, group: 'session', remaining, resets_at })
const weekly = (remaining, resets_at = null) => ({ kind: 'weekly_all', scope: null, group: 'weekly', remaining, resets_at })

// a: active, 42.01 session and 70 weekly; b: parked and full; c: parked and spent on session; d: blocked, never read.
const fixture = () => ({
  active: { id: 'a', name: 'a', enrolled: true, in_order: true },
  order: ['a', 'b', 'c', 'd'],
  settings: { enabled: true, thresholds: { ...thresholds } },
  accounts: [
    { id: 'a', name: 'a', email: 'a@example.com', parked: false, in_order: true, blocked: null, first_reading_due: false,
      snapshot: [session(42.01, '2026-10-21T18:00:00+02:00'), weekly(70, '2026-10-27T09:00:00+02:00')] },
    { id: 'b', name: 'b', email: 'b@example.com', parked: true, in_order: true, blocked: null, first_reading_due: false,
      snapshot: [session(100), weekly(100)] },
    { id: 'c', name: 'c', email: 'c@example.com', parked: true, in_order: true, blocked: null, first_reading_due: false,
      snapshot: [session(5, '2026-10-24T13:00:00+02:00'), weekly(50, '2026-10-27T09:00:00+02:00')] },
    { id: 'd', name: 'd', email: 'd@example.com', parked: true, in_order: true, blocked: 'authentication_failed', first_reading_due: false,
      snapshot: null },
  ],
})

const accountNamed = (report, name) => report.accounts.find((a) => a.name === name)

// A small report: every account parked and full unless the test changes it.
const account = (id, extra = {}) => ({ id, name: id, parked: true, blocked: null, snapshot: [session(100), weekly(100)], ...extra })
const reportOf = ({ order, active, accounts, thresholds: t = thresholds }) => ({
  active: active === null ? null : { id: active, name: active },
  order,
  settings: { enabled: true, thresholds: t },
  accounts,
})

test('windowOf picks the account-wide entry of each group', () => {
  const snapshot = fixture().accounts[0].snapshot
  assert.deepEqual(windowOf(snapshot, 'session', NOW), { remaining: 42.01, resets_at: '2026-10-21T18:00:00+02:00' })
  assert.deepEqual(windowOf(snapshot, 'weekly', NOW), { remaining: 70, resets_at: '2026-10-27T09:00:00+02:00' })
  assert.equal(windowOf(null, 'session', NOW), null)
  assert.equal(windowOf([weekly('lots')], 'weekly', NOW), null)
})

test('windowOf never shows a per-model weekly entry, even when it is listed first', () => {
  const snapshot = [
    { kind: 'weekly_scoped', scope: 'Fable', group: 'weekly', remaining: 3, resets_at: '2026-10-27T09:00:00+02:00' },
    weekly(70, '2026-10-27T09:00:00+02:00'),
  ]
  assert.deepEqual(windowOf(snapshot, 'weekly', NOW), { remaining: 70, resets_at: '2026-10-27T09:00:00+02:00' })
  assert.equal(windowOf([snapshot[0]], 'weekly', NOW), null)
})

test('windowOf treats a window whose reset is at or before now as absent, as the engine does', () => {
  assert.equal(windowOf([session(40, '2026-10-21T09:00:00Z')], 'session', NOW), null)
  assert.equal(windowOf([session(40, NOW.toISOString())], 'session', NOW), null)
  assert.equal(windowOf([session(40, '2026-10-21T11:00:00Z')], 'session', NOW)?.remaining, 40)
  assert.equal(windowOf([session(40, null)], 'session', NOW)?.remaining, 40)
})

test('an expired window reads as not read yet and never makes its account spent', () => {
  const report = fixture()
  accountNamed(report, 'c').snapshot = [session(5, '2026-10-21T09:00:00Z'), weekly(50, '2026-10-27T09:00:00+02:00')]
  assert.deepEqual(rowState(accountNamed(report, 'c'), report, 'session', at), { percent: null, status: 'unread', label: 'not read yet' })
  assert.equal(nextAccount(report, NOW)?.name, 'b')
})

test('nextAccount is the first eligible account after the active one, in order, with no wrap', () => {
  const report = fixture()
  assert.equal(nextAccount(report, NOW)?.name, 'b')

  const bSpent = fixture()
  accountNamed(bSpent, 'b').snapshot[0].remaining = 3
  assert.equal(nextAccount(bSpent, NOW), null)
})

test('nextAccount takes the first eligible in order, not the one after the active one, and does not wrap', () => {
  // The case that differed from the engine: active b, a and c both fine; the engine swaps to a, not to c.
  const report = reportOf({
    order: ['a', 'b', 'c'], active: 'b',
    accounts: [account('a'), account('b'), account('c')],
  })
  assert.equal(nextAccount(report, NOW)?.name, 'a')
})

test('nextAccount with an order set never picks an unordered account', () => {
  // The engine only sees ordered accounts when ACCOUNTS is set, so an unordered z is never next.
  const report = reportOf({
    order: ['a'], active: 'a',
    accounts: [account('a'), account('z')],
  })
  assert.equal(nextAccount(report, NOW), null)
})

test('nextAccount with no order picks the first eligible account in the report', () => {
  const report = reportOf({
    order: [], active: 'b',
    accounts: [account('a'), account('b'), account('z')],
  })
  assert.equal(nextAccount(report, NOW)?.name, 'a')
})

test('nextAccount treats an exact threshold as headroom: remaining below it fails, equal passes', () => {
  const t = { session: 15, weekly: 10 }
  const atThreshold = reportOf({
    order: ['a', 'b'], active: 'a', thresholds: t,
    accounts: [account('a'), account('b', { snapshot: [session(15), weekly(10)] })],
  })
  assert.equal(nextAccount(atThreshold, NOW)?.name, 'b')
  const below = reportOf({
    order: ['a', 'b'], active: 'a', thresholds: t,
    accounts: [account('a'), account('b', { snapshot: [session(14.99), weekly(10)] })],
  })
  assert.equal(nextAccount(below, NOW), null)
})

test('nextAccount skips an account whose per-model weekly window is below its threshold when model limits are on', () => {
  const report = reportOf({
    order: ['a', 'b', 'c'], active: 'a',
    accounts: [
      account('a'),
      account('b', { snapshot: [session(100), weekly(100), { kind: 'weekly_scoped', scope: 'Fable', group: 'weekly', remaining: 3, resets_at: null }] }),
      account('c'),
    ],
  })
  report.settings.model_limits = true
  assert.equal(nextAccount(report, NOW)?.name, 'c')
})

test('a leftover per-model weekly window is ignored when model limits are off', () => {
  // The reviewer's probe: b is at 90% on both account-wide windows, with a stale per-model weekly at 3%.
  const probe = () => reportOf({
    order: ['a', 'b'], active: 'a',
    accounts: [
      account('a'),
      account('b', { snapshot: [session(90), weekly(90), { kind: 'weekly_scoped', scope: 'Fable', group: 'weekly', remaining: 3, resets_at: null }] }),
    ],
  })
  const off = probe()
  off.settings.model_limits = false
  assert.equal(nextAccount(off, NOW)?.name, 'b')
  assert.equal(rowState(accountNamed(off, 'b'), off, 'session', { now: NOW }).status, 'next')
  // With model limits on, the same stale window makes b spent, so it is not next.
  const on = probe()
  on.settings.model_limits = true
  assert.equal(nextAccount(on, NOW), null)
  assert.equal(rowState(accountNamed(on, 'b'), on, 'session', { now: NOW }).status, 'spent')
})

test('nextAccount is null when nobody is logged in or the active account is unknown', () => {
  const none = fixture()
  none.active = null
  assert.equal(nextAccount(none, NOW), null)
  const unknown = fixture()
  unknown.active = { id: 'zz', name: 'zz', enrolled: true, in_order: false }
  assert.equal(nextAccount(unknown, NOW), null)
})

test('rowState: active / NEXT ▸ / spent · resets Sat 13:00 / blocked: authentication_failed / not enrolled / not read yet', () => {
  const report = fixture()
  assert.deepEqual(rowState(accountNamed(report, 'a'), report, 'session', at), { percent: 42, status: 'active', label: 'active' })
  assert.deepEqual(rowState(accountNamed(report, 'b'), report, 'session', at), { percent: 100, status: 'next', label: 'NEXT ▸' })
  assert.deepEqual(rowState(accountNamed(report, 'c'), report, 'session', at),
    { percent: 5, status: 'spent', label: 'spent · resets Sat 13:00' })
  // c's 5h window is below its threshold, so c is spent in the weekly view too, showing its own 50%.
  assert.deepEqual(rowState(accountNamed(report, 'c'), report, 'weekly', at),
    { percent: 50, status: 'spent', label: 'spent · resets Sat 13:00' })
  assert.deepEqual(rowState(accountNamed(report, 'a'), report, 'weekly', at),
    { percent: 70, status: 'active', label: 'active' })
  assert.deepEqual(rowState(accountNamed(report, 'd'), report, 'session', at),
    { percent: null, status: 'blocked', label: 'blocked: authentication_failed' })
  // Blocked beats spent: a low reading on a blocked account still shows blocked, with no percent.
  const lowBlocked = fixture()
  accountNamed(lowBlocked, 'd').snapshot = [session(5, '2026-10-24T13:00:00+02:00')]
  assert.deepEqual(rowState(accountNamed(lowBlocked, 'd'), lowBlocked, 'session', at),
    { percent: null, status: 'blocked', label: 'blocked: authentication_failed' })
  assert.deepEqual(rowState(accountNamed(lowBlocked, 'd'), lowBlocked, 'weekly', at),
    { percent: null, status: 'blocked', label: 'blocked: authentication_failed' })
  assert.deepEqual(rowState({ name: 'e', missing: true }, report, 'session', at),
    { percent: null, status: 'not-enrolled', label: 'not enrolled' })
  const unread = { id: 'x', name: 'x', parked: true, blocked: null, snapshot: null }
  assert.deepEqual(rowState(unread, report, 'session', at), { percent: null, status: 'unread', label: 'not read yet' })
})

test('rowState: an account spent on its weekly window is spent in the 5h view, labelled with the weekly reset', () => {
  const report = fixture()
  accountNamed(report, 'c').snapshot = [session(80, '2026-10-24T13:00:00+02:00'), weekly(10, '2026-10-27T09:00:00+02:00')]
  // The 5h view shows the 5h percentage, with the binding weekly reset in the label.
  assert.deepEqual(rowState(accountNamed(report, 'c'), report, 'session', at),
    { percent: 80, status: 'spent', label: 'spent · resets Tue 08:00' })
  assert.deepEqual(rowState(accountNamed(report, 'c'), report, 'weekly', at),
    { percent: 10, status: 'spent', label: 'spent · resets Tue 08:00' })
})

test('rowState: a blocked account that is also active shows active · blocked', () => {
  const report = fixture()
  report.active = { id: 'd', name: 'd', enrolled: true, in_order: true }
  assert.deepEqual(rowState(accountNamed(report, 'd'), report, 'session', at),
    { percent: null, status: 'active', label: 'active · blocked: authentication_failed' })
})

test('rowState rounds 42.01 to 42 and renders — without a live window', () => {
  const report = fixture()
  assert.equal(rowState(accountNamed(report, 'a'), report, 'session', at).percent, 42)
  assert.equal(rowState(accountNamed(report, 'a'), report, 'weekly', at).percent, 70)
  assert.equal(rowState(accountNamed(report, 'd'), report, 'weekly', at).percent, null)
})

test('rowState: an account at exactly its threshold is not spent; the first eligible one is next', () => {
  const t = { session: 15, weekly: 10 }
  const report = reportOf({
    order: ['a', 'c', 'b'], active: 'a', thresholds: t,
    accounts: [account('a'), account('c'), account('b', { snapshot: [session(15), weekly(10)] })],
  })
  assert.deepEqual(rowState(accountNamed(report, 'b'), report, 'session', { now: NOW }),
    { percent: 15, status: 'ok', label: '' })
  assert.equal(nextAccount(report, NOW)?.name, 'c')
})

test('centre: below-threshold active says swaps next turn; fine otherwise; no active login when active is null', () => {
  const report = fixture()
  assert.deepEqual(centre(report, 'session', { now: NOW }),
    { name: 'a', percentText: '42% left', hint: 'fine', nextName: 'b', tone: 'fine' })
  assert.equal(centre(report, 'weekly', { now: NOW }).percentText, '70% left')

  const low = fixture()
  accountNamed(low, 'a').snapshot[0].remaining = 10
  assert.equal(centre(low, 'session', { now: NOW }).hint, 'swaps next turn')

  // The hint looks at both windows: a weekly shortfall shows on the 5h view too.
  const weeklyLow = fixture()
  accountNamed(weeklyLow, 'a').snapshot[1].remaining = 10
  assert.equal(centre(weeklyLow, 'session', { now: NOW }).hint, 'swaps next turn')

  // A long block reason is cut to 24 characters, ellipsis included, so it stays inside the ring.
  const longBlock = fixture()
  accountNamed(longBlock, 'a').blocked = 'authentication_failed'
  const hint = centre(longBlock, 'session', { now: NOW }).hint
  assert.equal(hint, 'blocked: authentication…')
  assert.equal([...hint].length, 24)
  const shortBlock = fixture()
  accountNamed(shortBlock, 'a').blocked = 'usage'
  assert.equal(centre(shortBlock, 'session', { now: NOW }).hint, 'blocked: usage')

  const none = fixture()
  none.active = null
  assert.deepEqual(centre(none, 'session', { now: NOW }),
    { name: '—', percentText: '—', hint: 'no active login', nextName: null, tone: 'none' })
})

test('centre tone: fine, warning on the shown window, spent on the other window, blocked, none', () => {
  assert.equal(centre(fixture(), 'session', { now: NOW }).tone, 'fine')

  // The shown window below its threshold is amber.
  const low = fixture()
  accountNamed(low, 'a').snapshot[0].remaining = 10
  assert.equal(centre(low, 'session', { now: NOW }).tone, 'warning')
  // On the weekly view the 5h shortfall is on the other window, so the shown 70% is red-spent, not amber.
  assert.equal(centre(low, 'weekly', { now: NOW }).tone, 'spent')

  // The shown window is fine and the other window is below its threshold: spent (red).
  const weeklyLow = fixture()
  accountNamed(weeklyLow, 'a').snapshot[1].remaining = 10
  assert.equal(centre(weeklyLow, 'session', { now: NOW }).tone, 'spent')
  assert.equal(centre(weeklyLow, 'weekly', { now: NOW }).tone, 'warning')

  const blocked = fixture()
  accountNamed(blocked, 'a').blocked = 'authentication_failed'
  assert.equal(centre(blocked, 'session', { now: NOW }).tone, 'blocked')

  const unread = fixture()
  accountNamed(unread, 'a').snapshot = null
  assert.equal(centre(unread, 'session', { now: NOW }).tone, 'none')

  const none = fixture()
  none.active = null
  assert.equal(centre(none, 'session', { now: NOW }).tone, 'none')
})

test('hostChip: on, off, unreachable, not-installed, managed, foreign', () => {
  const ok = (value) => ({ ok: true, value })
  const on = { host: { name: 'mac' }, result: ok({ settings: { enabled: true }, accounts: [], order: [] }) }
  assert.deepEqual(hostChip(on), { kind: 'on', label: 'rotation on' })
  const off = { host: { name: 'mac' }, result: ok({ settings: { enabled: false }, accounts: [], order: [] }) }
  assert.deepEqual(hostChip(off), { kind: 'off', label: 'rotation off' })
  const down = { host: { name: 'devbox' }, result: { ok: false, failure: { kind: 'unreachable', detail: 'Connection refused' } } }
  assert.deepEqual(hostChip(down), { kind: 'unreachable', label: 'unreachable' })
  const bare = { host: { name: 'devbox-2' }, result: { ok: false, failure: { kind: 'not-installed', detail: 'no engine' } } }
  assert.deepEqual(hostChip(bare), { kind: 'not-installed', label: 'engine not installed' })
  const managed = { host: { name: 'mac' }, result: ok({ settings: { enabled: true }, managed_profile: true, accounts: [], order: [] }) }
  assert.deepEqual(hostChip(managed), { kind: 'managed', label: 'managed profile' })
  const foreign = { host: { name: 'mac' }, result: ok({ settings: { enabled: true }, connection: { foreign: { statusline: 'other' } }, accounts: [], order: [] }) }
  assert.deepEqual(hostChip(foreign), { kind: 'foreign', label: 'another grazr owns the status line' })
})

test('hostChip: a host with its status line or hook disconnected is not connected, whatever its setting says', () => {
  const ok = (value) => ({ ok: true, value })
  const disconnected = { host: { name: 'mac' }, result: ok({ installed: false, settings: { enabled: true }, accounts: [], order: [] }) }
  assert.deepEqual(hostChip(disconnected), { kind: 'not-connected', label: 'not connected' })
  // A foreign owner and a managed profile both outrank not connected.
  const foreign = { host: { name: 'mac' }, result: ok({ installed: false, connection: { foreign: { statusline: 'x' } }, settings: { enabled: true } }) }
  assert.equal(hostChip(foreign).kind, 'foreign')
  const managed = { host: { name: 'mac' }, result: ok({ installed: false, managed_profile: true, settings: { enabled: true } }) }
  assert.equal(hostChip(managed).kind, 'managed')
  // An engine that reports no installed key is read as connected, as before.
  const silent = { host: { name: 'mac' }, result: ok({ settings: { enabled: true } }) }
  assert.deepEqual(hostChip(silent), { kind: 'on', label: 'rotation on' })
})

test('buildPanelData shows a timeout as timed out, without the budget it was cut to', () => {
  const settings = { hosts: [{ name: 'mac' }], target: 'mac' }
  const timeout = (ms) => ({ ok: false, failure: { kind: 'timeout', detail: `timed out after ${ms / 1000}s` } })
  const six = buildPanelData({ settings, now: NOW, hosts: [{ host: settings.hosts[0], result: timeout(6000) }] })
  const four = buildPanelData({ settings, now: NOW, hosts: [{ host: settings.hosts[0], result: timeout(4000) }] })
  assert.equal(six.hosts[0].failure.detail, 'timed out')
  assert.deepEqual(six.hosts[0].failure, four.hosts[0].failure)
})

test('orderedAccounts puts named accounts first in order and adds placeholders for missing ones', () => {
  const report = fixture()
  report.order = ['c', 'missing', 'a']
  report.accounts = report.accounts.filter((a) => a.name !== 'b')
  const names = orderedAccounts(report).map((a) => a.name ?? a.missing)
  assert.deepEqual(names, ['c', 'missing', 'a', 'd'])
  assert.equal(orderedAccounts(report)[1].missing, true)
})

test('buildPanelData puts the target first, keeps failed hosts with reachable:false and no views', () => {
  const settings = {
    hosts: [{ name: 'mac' }, { name: 'devbox' }, { name: 'devbox-2' }],
    target: 'devbox',
  }
  const now = NOW
  const data = buildPanelData({
    settings,
    now,
    timeZone: 'Europe/Zurich',
    hosts: [
      { host: settings.hosts[0], result: { ok: true, value: fixture() } },
      { host: settings.hosts[1], result: { ok: false, failure: { kind: 'unreachable', detail: 'Connection refused' } } },
      { host: settings.hosts[2], result: { ok: false, failure: { kind: 'not-installed', detail: 'no engine' } } },
    ],
  })
  assert.equal(data.generatedAt, now.toISOString())
  assert.equal(data.target, 'devbox')
  assert.deepEqual(data.hosts.map((h) => h.name), ['devbox', 'mac', 'devbox-2'])

  const down = data.hosts[0]
  assert.equal(down.reachable, false)
  assert.equal(down.failure.kind, 'unreachable')
  assert.equal(down.chip.kind, 'unreachable')
  assert.equal(down.views, null)
  assert.equal(down.updatedAt, null)

  const mac = data.hosts[1]
  assert.equal(mac.reachable, true)
  assert.equal(mac.failure, null)
  assert.equal(mac.updatedAt, now.toISOString())
  assert.deepEqual(mac.thresholds, thresholds)
  assert.deepEqual(mac.views.session.rows.map((r) => r.status), ['active', 'next', 'spent', 'blocked'])
  assert.deepEqual(mac.views.session.rows.map((r) => r.index), [1, 2, 3, 4])
  assert.equal(mac.views.session.rows[0].isActive, true)
  assert.equal(mac.views.session.rows[1].isNext, true)
  assert.deepEqual(mac.views.session.segments.map((s) => s.state), ['active', 'next', 'spent', 'blocked'])
  assert.equal(mac.views.session.segments[0].remaining, 42.01)
  assert.equal(mac.views.session.segments[3].remaining, null)
  assert.equal(mac.views.session.centre.nextName, 'b')
  assert.equal(data.hosts[2].chip.kind, 'not-installed')
})

test('buildPanelData rows carry the blocked reason, so an active blocked row can offer re-authentication', () => {
  const report = fixture()
  report.active = { id: 'd', name: 'd', enrolled: true, in_order: true }
  const settings = { hosts: [{ name: 'mac' }], target: 'mac' }
  const data = buildPanelData({ settings, now: NOW, timeZone: 'Europe/Zurich', hosts: [{ host: settings.hosts[0], result: { ok: true, value: report } }] })
  const row = data.hosts[0].views.session.rows.find((r) => r.name === 'd')
  assert.equal(row.blocked, 'authentication_failed')
  assert.equal(row.label, 'active · blocked: authentication_failed')
  assert.equal(data.hosts[0].views.session.rows.find((r) => r.name === 'a').blocked, null)
})

test('a name with a quote and $ survives into rows unchanged (escaping is the renderer\'s job)', () => {
  const report = fixture()
  report.order = ['a', "o'brien $x"]
  report.accounts.push({ id: 'q', name: "o'brien $x", email: null, parked: true, in_order: true, blocked: null,
    first_reading_due: false, snapshot: null })
  const settings = { hosts: [{ name: 'mac' }], target: 'mac' }
  const data = buildPanelData({ settings, now: NOW, hosts: [{ host: settings.hosts[0], result: { ok: true, value: report } }] })
  const names = data.hosts[0].views.session.rows.map((r) => r.name)
  assert.ok(names.includes("o'brien $x"))
})

test('engine: outdated when the installed version differs from the bundled one, equal means current', () => {
  const settings = { hosts: [{ name: 'mac' }], target: 'mac' }
  const value = { ...fixture(), version: '0.4.7+fork.5' }
  const host = (bundledVersion) => buildPanelData({
    settings,
    now: NOW,
    bundledVersion,
    hosts: [{ host: settings.hosts[0], result: { ok: true, value } }],
  }).hosts[0].engine
  assert.deepEqual(host('0.4.7+fork.6'), { installed: '0.4.7+fork.5', bundled: '0.4.7+fork.6', outdated: true })
  assert.deepEqual(host('0.4.7+fork.5'), { installed: '0.4.7+fork.5', bundled: '0.4.7+fork.5', outdated: false })
})

test('engine: an installed version newer than the bundled one is not outdated, and numbers compare as numbers', () => {
  const settings = { hosts: [{ name: 'mac' }], target: 'mac' }
  const host = (installed, bundledVersion) => buildPanelData({
    settings,
    now: NOW,
    bundledVersion,
    hosts: [{ host: settings.hosts[0], result: { ok: true, value: { ...fixture(), version: installed } } }],
  }).hosts[0].engine
  assert.equal(host('0.4.7+fork.11', '0.4.7+fork.10').outdated, false)
  assert.equal(host('0.4.9+fork.1', '0.4.10+fork.1').outdated, true)
  assert.equal(host('0.4.10+fork.1', '0.4.9+fork.99').outdated, false)
})

test('engine: a report without a version has installed null and is not outdated, and an unknown bundled version is never outdated', () => {
  const settings = { hosts: [{ name: 'mac' }], target: 'mac' }
  const run = (value, bundledVersion) => buildPanelData({
    settings,
    now: NOW,
    bundledVersion,
    hosts: [{ host: settings.hosts[0], result: { ok: true, value } }],
  }).hosts[0].engine
  assert.deepEqual(run(fixture(), '0.4.7+fork.6'), { installed: null, bundled: '0.4.7+fork.6', outdated: false })
  assert.deepEqual(run({ ...fixture(), version: 7 }, '0.4.7+fork.6'), { installed: null, bundled: '0.4.7+fork.6', outdated: false })
  assert.deepEqual(run({ ...fixture(), version: '0.4.7+fork.5' }, null), { installed: '0.4.7+fork.5', bundled: null, outdated: false })
})

test('buildPanelData carries whether rotation is on, and an unreachable host has no engine', () => {
  const settings = { hosts: [{ name: 'mac' }, { name: 'devbox' }], target: 'mac' }
  const data = buildPanelData({
    settings,
    now: NOW,
    bundledVersion: null,
    hosts: [
      { host: settings.hosts[0], result: { ok: true, value: fixture() } },
      { host: settings.hosts[1], result: { ok: false, failure: { kind: 'unreachable', detail: 'Connection refused' } } },
    ],
  })
  assert.equal(data.hosts[0].enabled, true)
  assert.equal(data.hosts[1].enabled, false)
  assert.equal(data.hosts[1].engine, null)
})

test('buildPanelData gives each view its swap threshold, or null when the report sets none', () => {
  const settings = { hosts: [{ name: 'mac' }], target: 'mac' }
  const view = (value) => buildPanelData({
    settings,
    now: NOW,
    hosts: [{ host: settings.hosts[0], result: { ok: true, value } }],
  }).hosts[0].views
  const set = view(fixture())
  assert.equal(set.session.threshold, 15)
  assert.equal(set.weekly.threshold, 20)
  const bare = fixture()
  delete bare.settings.thresholds
  assert.equal(view(bare).session.threshold, null)
  assert.equal(view(bare).weekly.threshold, null)
})
