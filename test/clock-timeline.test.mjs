import { test } from 'node:test'
import assert from 'node:assert/strict'
import { project } from '../lib/clock.mjs'

// Ports HerdrKit's GrazrTimelineTests, with the same fixtures.
const NOW = 1790876000
const DAY = 86400
const thresholds = { session: 15, weekly: 15 }
const win = (group, remaining, resetsInHours, scope = null) =>
  ({ group, scope, remaining, resetsAt: resetsInHours === null ? null : NOW + resetsInHours * 3600 })
const acct = (id, windows = [], extra = {}) => ({ id, name: id, index: 1, blocked: false, updated: null, windows, ...extra })
const clock = ({ active = null, accounts }) => ({ active, thresholds, modelLimits: false, accounts })
const ids = (t) => t.stretches.map((s) => s.account)
const contiguous = (t, end) => {
  assert.equal(t.stretches[0].from, NOW)
  t.stretches.forEach((s, i) => {
    if (i) assert.equal(s.from, t.stretches[i - 1].to)
    assert.ok(s.from < s.to)
  })
  assert.equal(t.stretches.at(-1).to, end)
}
const swaps = (t) => t.events.filter((e) => e.kind === 'swap')

test('with no pace the active runs to the horizon', () => {
  const a = acct('a', [win('weekly', 60, 100)])
  const t = project(clock({ active: 'a', accounts: [a] }), NOW, DAY)
  assert.deepEqual(t.stretches, [{ account: 'a', from: NOW, to: NOW + DAY, leftAtStart: 60, leftAtEnd: 60 }])
  assert.deepEqual(t.events, [])
})

test('it swaps to the first listed account with headroom when the active runs low', () => {
  // 50% used in the 2.5 h since the 5-hour window opened: 20% an hour,
  // so the 50% left reaches the 15% threshold after 1.75 h.
  const a = acct('a', [win('session', 50, 2.5), win('weekly', 90, 100)], { updated: NOW })
  const s = acct('s', [win('weekly', 0, 60)])
  const b = acct('b')
  const t = project(clock({ active: 'a', accounts: [a, s, b] }), NOW, DAY)
  assert.deepEqual(ids(t), ['a', 'b'])
  assert.ok(Math.abs(t.stretches[0].to - (NOW + 1.75 * 3600)) < 1)
  assert.equal(t.stretches[0].leftAtStart, 50)
  assert.equal(t.stretches[0].leftAtEnd, 15)
  contiguous(t, NOW + DAY)
  assert.equal(swaps(t).length, 1)
  assert.equal(swaps(t)[0].to, 'b')
  assert.ok(Math.abs(swaps(t)[0].at - (NOW + 1.75 * 3600)) < 1)
  assert.ok(t.events.some((e) => e.kind === 'refill' && e.account === 'a' && e.group === 'session'
    && Math.abs(e.at - (NOW + 2.5 * 3600)) < 1), "the 5-hour reset inside the horizon is an event")
})

test('when nothing has headroom the active runs dry, then a gap until the soonest refill', () => {
  // 70% used in 1.5 h: the 30% left is gone after 30 / (70 / 1.5) h.
  const a = acct('a', [win('session', 30, 3.5)], { updated: NOW })
  const b = acct('b', [win('session', 0, 4)])
  const t = project(clock({ active: 'a', accounts: [a, b] }), NOW, DAY)
  const dry = 30 / (70 / 1.5) * 3600
  assert.deepEqual(ids(t).slice(0, 3), ['a', null, 'a'])
  assert.ok(Math.abs(t.stretches[0].to - (NOW + dry)) < 1)
  assert.equal(t.stretches[1].account, null)
  assert.ok(Math.abs(t.stretches[1].to - (NOW + 3.5 * 3600)) < 1, "a's own window refills first")
  contiguous(t, NOW + DAY)
})

test("a spent week resetting inside the horizon is a refill", () => {
  const a = acct('a', [win('weekly', 60, 30)])
  const spent = acct('s', [win('weekly', 0, 30)])
  const t = project(clock({ active: 'a', accounts: [a, spent] }), NOW, 7 * DAY)
  // a's week resets too, but it never ran low: no dot for it.
  assert.deepEqual(t.events, [{ kind: 'refill', at: NOW + 30 * 3600, account: 's', group: 'weekly' }])
})

test('a window that never ran low gives no refills', () => {
  // The active account's 5-hour window keeps resetting all week without
  // ever getting near its threshold: a dot every five hours says nothing.
  const a = acct('a', [win('session', 94, 4), win('weekly', 84, 7 * 24 - 23.2)], { updated: NOW })
  const t = project(clock({ active: 'a', accounts: [a] }), NOW, 7 * DAY)
  assert.equal(t.events.some((e) => e.kind === 'refill' && e.group === 'session'), false)
})

test('a blocked account is never picked', () => {
  // a is already below its threshold, so grazr moves at once; b is blocked.
  const a = acct('a', [win('session', 10, 4)], { updated: NOW })
  const b = acct('b', [], { blocked: true })
  const c = acct('c')
  const t = project(clock({ active: 'a', accounts: [a, b, c] }), NOW, DAY)
  assert.deepEqual(ids(t), ['c'])
  assert.deepEqual(t.events[0], { kind: 'swap', at: NOW, to: 'c' })
})

test('with no active account it starts on the first with headroom', () => {
  const spent = acct('s', [win('weekly', 0, 60)])
  const b = acct('b')
  assert.deepEqual(ids(project(clock({ accounts: [spent, b] }), NOW, DAY)), ['b'])
})

test('a window with no reset time neither hangs nor drains', () => {
  const a = acct('a', [win('session', 50, 2.5), win('weekly', 40, null)], { updated: NOW })
  const b = acct('b')
  const t = project(clock({ active: 'a', accounts: [a, b] }), NOW, DAY)
  assert.deepEqual(ids(t), ['a', 'b'])
  assert.ok(Math.abs(t.stretches[0].to - (NOW + 1.75 * 3600)) < 1)
})

test('an account at exactly its threshold is not picked back', () => {
  // a crosses 15% and b has room; when b runs down, a still sits at 15%:
  // the projection must not hand back to a at the same instant.
  const a = acct('a', [win('weekly', 16, 150)], { updated: NOW })
  const b = acct('b', [win('weekly', 100, 160)])
  const t = project(clock({ active: 'a', accounts: [a, b] }), NOW, DAY)
  assert.deepEqual(ids(t), ['a', 'b', null])
  contiguous(t, NOW + DAY)
})

test("a pace from a window's first minutes is not trusted", () => {
  // Seen live right after a swap: 6% of a fresh 5-hour window gone in
  // 2.4 minutes (Claude reloading its context) read as 150% an hour, and
  // every account after it ran dry within the hour.
  const a = acct('a', [win('session', 94, 5 - 0.04), win('weekly', 84, 7 * 24 - 23.2)], { updated: NOW })
  const b = acct('b')
  const t = project(clock({ active: 'a', accounts: [a, b] }), NOW, DAY)
  assert.deepEqual(ids(t), ['a'], 'the week\'s pace alone keeps a going all day')
})

test('stretches are bounded', () => {
  // 84% gone in the first half hour of a 5-hour window (the shortest
  // sample the pace trusts): the accounts take turns every few minutes,
  // and a gap waits out each reset.
  const a = acct('a', [win('session', 16, 4.5)], { updated: NOW })
  const b = acct('b', [win('session', 100, 5)])
  const t = project(clock({ active: 'a', accounts: [a, b] }), NOW, 60 * DAY)
  assert.equal(t.stretches.length, 200)
})

test('accounts without a reading time project without pace', () => {
  const a = acct('a', [win('session', 50, 2.5), win('weekly', 90, 100)])
  const s = acct('s', [win('weekly', 0, 60)])
  const b = acct('b')
  const t = project(clock({ active: 'a', accounts: [a, s, b] }), NOW, DAY)
  assert.deepEqual(ids(t), ['a'])
  // The 5-hour window resets at 2.5 h and starts over full; the week stays at 90.
  assert.deepEqual(t.stretches, [{ account: 'a', from: NOW, to: NOW + DAY, leftAtStart: 50, leftAtEnd: 90 }])
})

test('per-model windows count only with model limits on', () => {
  const a = acct('a', [win('session', 50, 2.5), win('weekly', 5, 100, 'Fable')], { updated: NOW })
  const b = acct('b')
  const off = project(clock({ active: 'a', accounts: [a, b] }), NOW, DAY)
  assert.equal(off.stretches[0].account, 'a')
  assert.ok(Math.abs(off.stretches[0].to - (NOW + 1.75 * 3600)) < 1)
  // With model limits on, the scoped week is already below its threshold: a moves on at once.
  const on = project({ ...clock({ active: 'a', accounts: [a, b] }), modelLimits: true }, NOW, DAY)
  assert.deepEqual(ids(on), ['b'])
  assert.deepEqual(swaps(on)[0], { kind: 'swap', at: NOW, to: 'b' })
})
