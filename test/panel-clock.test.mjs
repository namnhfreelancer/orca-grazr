import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderCard, renderPanel, placeholderPanel } from '../lib/panel.mjs'
import { buildPanelData, clockData } from '../lib/panel-data.mjs'
import { project } from '../lib/clock.mjs'

const NOW = new Date('2026-10-21T10:00:00Z')
const PAGE = readFileSync(new URL('../panel/template.html', import.meta.url), 'utf8')
const CLOCK_SOURCE = readFileSync(new URL('../lib/clock.mjs', import.meta.url), 'utf8')
const TEMPLATE = '<main><!--__CARDS__--></main><script>const D = /*__DATA__*/;</script><script type="module">/*__CLOCK__*/</script>'

const session = (remaining, resets_at = null) => ({ kind: 'session', scope: null, group: 'session', remaining, resets_at })
const weekly = (remaining, resets_at = null) => ({ kind: 'weekly_all', scope: null, group: 'weekly', remaining, resets_at })

// a: active, 42.01 session and 70 weekly; b: parked and full; c: parked and spent on session; d: blocked, never read.
const fixture = () => ({
  active: { id: 'a', name: 'a', enrolled: true, in_order: true },
  order: ['a', 'b', 'c', 'd'],
  settings: { enabled: true, thresholds: { session: 15, weekly: 20 } },
  accounts: [
    { id: 'a', name: 'a', parked: false, blocked: null, snapshot: [session(42.01, '2026-10-21T18:00:00+02:00'), weekly(70, '2026-10-27T09:00:00+02:00')] },
    { id: 'b', name: 'b', parked: true, blocked: null, snapshot: [session(100), weekly(100)] },
    { id: 'c', name: 'c', parked: true, blocked: null, snapshot: [session(5, '2026-10-24T13:00:00+02:00'), weekly(50, '2026-10-27T09:00:00+02:00')] },
    { id: 'd', name: 'd', parked: true, blocked: 'authentication_failed', snapshot: null },
  ],
})

const clockOf = (report, now = NOW) => buildPanelData({
  settings: { hosts: [{ name: 'mac' }], target: 'mac' },
  now,
  hosts: [{ host: { name: 'mac' }, result: { ok: true, value: report } }],
}).hosts[0].clock

const panelOf = (value, extraHost = false) => {
  const settings = { hosts: [{ name: 'mac' }, { name: 'devbox' }], target: 'mac' }
  return buildPanelData({
    settings,
    now: NOW,
    timeZone: 'Europe/Zurich',
    hosts: [
      { host: settings.hosts[0], result: { ok: true, value } },
      ...(extraHost ? [{ host: settings.hosts[1], result: { ok: false, failure: { kind: 'unreachable', detail: 'Connection refused' } } }] : []),
    ],
  })
}

// --- clock data ---

test('clock data lists the rotation in order with row indexes, unrounded remaining and reset seconds', () => {
  const clock = clockOf(fixture())
  assert.deepEqual(clock.accounts.map((a) => [a.id, a.index]), [['a', 1], ['b', 2], ['c', 3], ['d', 4]])
  assert.deepEqual(clock.accounts[0].windows, [
    { group: 'session', scope: null, remaining: 42.01, resetsAt: Date.parse('2026-10-21T18:00:00+02:00') / 1000 },
    { group: 'weekly', scope: null, remaining: 70, resetsAt: Date.parse('2026-10-27T09:00:00+02:00') / 1000 },
  ])
  assert.equal(clock.accounts[3].blocked, true)
  assert.deepEqual(clock.accounts[3].windows, [])
  assert.equal(clock.active, 'a')
  assert.deepEqual(clock.thresholds, { session: 15, weekly: 20 })
  assert.equal(clock.modelLimits, false)
})

test('clock data carries updated when the report gives a finite number and null otherwise', () => {
  const report = fixture()
  report.accounts[0].updated = 1790875000
  report.accounts[1].updated = 'yesterday'
  report.accounts[2].updated = Number.NaN
  const clock = clockOf(report)
  assert.equal(clock.accounts[0].updated, 1790875000)
  assert.equal(clock.accounts[1].updated, null)
  assert.equal(clock.accounts[2].updated, null)
  assert.equal(clock.accounts[3].updated, null)
})

test('clock data gives updated for the active account only', () => {
  const report = fixture()
  report.accounts[0].updated = 1790875000
  report.accounts[1].updated = 1790875100
  const clock = clockOf(report)
  assert.equal(clock.accounts[0].updated, 1790875000)
  assert.equal(clock.accounts[1].updated, null)
  assert.equal(clock.accounts[2].updated, null)
})

test('a non-active account with no parked credential is blocked in the clock data, so the projection never picks it', () => {
  const report = fixture()
  report.accounts[1].parked = false
  const clock = clockOf(report)
  assert.equal(clock.accounts[1].blocked, true)
  assert.equal(clock.accounts[0].blocked, false, 'the active account is not judged by its parked flag')
  const projection = project(clock, NOW.getTime() / 1000, 7 * 86400)
  assert.equal(projection.stretches.some((s) => s.account === 'b'), false)
})

test('the panel fills the clock source before the data and the cards, so a host named as the marker keeps the module whole', () => {
  const settings = { hosts: [{ name: '/*__CLOCK__*/' }], target: '/*__CLOCK__*/' }
  const data = buildPanelData({ settings, now: NOW, timeZone: 'Europe/Zurich', hosts: [{ host: settings.hosts[0], result: { ok: true, value: fixture() } }] })
  const html = renderPanel(data, { template: TEMPLATE, timeZone: 'Europe/Zurich' })
  assert.equal(html.split('export function project(').length - 1, 1)
  assert.ok(html.includes('<h2>/*__CLOCK__*/</h2>'))
})

test('clock data keeps per-model windows only with model limits on', () => {
  const report = fixture()
  report.accounts[0].snapshot.push({ kind: 'weekly_scoped', scope: 'Fable', group: 'weekly', remaining: 3, resets_at: null })
  assert.equal(clockOf(report).accounts[0].windows.length, 2)
  report.settings.model_limits = true
  const scoped = clockOf(report).accounts[0].windows
  assert.equal(scoped.length, 3)
  assert.deepEqual(scoped[2], { group: 'weekly', scope: 'Fable', remaining: 3, resetsAt: null })
  assert.equal(clockOf(report).modelLimits, true)
})

test('an active account that is not in the order is appended to the rotation; placeholders are left out', () => {
  const report = fixture()
  report.order = ['b', 'ghost', 'c']
  const clock = clockOf(report)
  assert.deepEqual(clock.accounts.map((a) => [a.id, a.index]), [['b', 1], ['c', 3], ['a', 4]])
  assert.equal(clock.active, 'a')
  const unordered = fixture()
  unordered.order = []
  assert.deepEqual(clockOf(unordered).accounts.map((a) => a.id), ['a', 'b', 'c', 'd'])
})

test('clockData takes the index of each name from the map it is given', () => {
  const report = fixture()
  const clock = clockData(report, new Map([['a', 7], ['b', 8], ['c', 9], ['d', 10]]))
  assert.deepEqual(clock.accounts.map((a) => a.index), [7, 8, 9, 10])
})

test('an unreachable host has clock null; a reachable one has it', () => {
  const data = panelOf(fixture(), true)
  const [mac, dev] = data.hosts
  assert.equal(dev.clock, null)
  assert.equal(mac.clock.accounts.length, 4)
})

// --- markup ---

test('viewBlock wraps the dial and adds a clock div per view with data-span, and a clock note', () => {
  const [mac] = panelOf(fixture()).hosts
  const html = renderCard({ ...mac, open: true }, {})
  assert.ok(html.includes('<div class="dial"><svg'))
  assert.ok(html.includes('<div class="clock" data-span="session"></div>'))
  assert.ok(html.includes('<div class="clock" data-span="weekly"></div>'))
  assert.ok(html.includes('<p class="clock-note">Projected at the current pace</p>'))
})

test('the toggles row has 5h, Week, a spacer, Dial, Clock and List, and a card with no choice given opens on the default clock face', () => {
  const [mac] = panelOf(fixture()).hosts
  const html = renderCard({ ...mac, open: true }, {})
  assert.ok(html.includes('<div class="views"><button class="view" data-view="session">5h</button><button class="view" data-view="weekly">Week</button>'
    + '<span class="spacer"></span><button class="face" data-face="dial">Dial</button><button class="face" data-face="clock">Clock</button><button class="face" data-face="list">List</button></div>'))
  assert.ok(html.startsWith('<section class="host" data-host="mac" data-view="session" data-face="clock">'))
})

// The panel's face and window come from the settings, through buildPanelData and renderPanel into each card.
const chosen = (panelFace, panelView) => buildPanelData({
  settings: { hosts: [{ name: 'mac' }], target: 'mac', panelFace, panelView },
  now: NOW,
  timeZone: 'Europe/Zurich',
  hosts: [{ host: { name: 'mac' }, result: { ok: true, value: fixture() } }],
})

test('buildPanelData passes the settings face and window through as data.face and data.view', () => {
  const data = chosen('dial', 'weekly')
  assert.equal(data.face, 'dial')
  assert.equal(data.view, 'weekly')
})

test('renderCard opens the card on the face and window it is given', () => {
  const [mac] = chosen('dial', 'weekly').hosts
  const html = renderCard({ ...mac, open: true, face: 'dial', view: 'weekly' }, {})
  assert.ok(html.startsWith('<section class="host" data-host="mac" data-view="weekly" data-face="dial">'))
})

test('renderPanel gives every card the settings face and window', () => {
  const data = chosen('dial', 'weekly')
  const html = renderPanel(data, { template: TEMPLATE, timeZone: 'Europe/Zurich' })
  assert.ok(html.includes('<section class="host" data-host="mac" data-view="weekly" data-face="dial">'))
})

test('each row index carries acct-N with N from the row index modulo 5', () => {
  const report = fixture()
  for (let i = 0; i < 2; i += 1) {
    report.accounts.push({ id: `x${i}`, name: `x${i}`, parked: true, blocked: null, snapshot: null })
    report.order.push(`x${i}`)
  }
  const [mac] = panelOf(report).hosts
  const html = renderCard({ ...mac, open: true }, {})
  assert.ok(html.includes('<span class="row-index acct-1">1</span>'))
  assert.ok(html.includes('<span class="row-index acct-5">5</span>'))
  assert.ok(html.includes('<span class="row-index acct-1">6</span>'))
})

test('renderPanel embeds clock data per reachable host and inlines lib/clock.mjs once', () => {
  const html = renderPanel(panelOf(fixture(), true), { template: PAGE })
  assert.ok(html.includes('"hosts":{"mac":{"clock":{'))
  assert.equal(html.includes('"devbox":'), false)
  assert.equal(html.split('export function project(').length - 1, 1)
  assert.equal(html.includes('/*__CLOCK__*/'), false)
})

test('renderPanel inserts the clock source with a function replacer, so $ patterns stay literal', () => {
  const html = renderPanel(panelOf(fixture()), { template: TEMPLATE, clockSource: 'const cost = "$&$1$$";' })
  assert.ok(html.includes('const cost = "$&$1$$";'))
})

test('the clock source carries no closing script tag, so the inline module cannot end early', () => {
  assert.equal(CLOCK_SOURCE.includes('</script'), false)
})

test('placeholderPanel also inlines the module', () => {
  const html = placeholderPanel(PAGE)
  assert.equal(html.split('export function project(').length - 1, 1)
  assert.equal(html.includes('/*__CLOCK__*/'), false)
  assert.equal(html.includes('/*__DATA__*/'), false)
})
