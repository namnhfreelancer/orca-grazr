import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPanelData, listOf, planLabel } from '../lib/panel-data.mjs'
import { renderCard, renderPanel } from '../lib/panel.mjs'

const NOW = new Date('2026-10-21T10:00:00Z')
const TZ = 'Europe/Zurich'

const session = (remaining, resets_at = null) => ({ kind: 'session', scope: null, group: 'session', remaining, resets_at })
const weekly = (remaining, resets_at = null) => ({ kind: 'weekly_all', scope: null, group: 'weekly', remaining, resets_at })
const scoped = (scope, remaining, resets_at = null) => ({ kind: 'weekly_scoped', scope, group: 'weekly', remaining, resets_at })

// a: active, organization set, updated; b: parked, default organization name; c: blocked; d: not parked; e: named in order, no record.
const fixture = () => ({
  active: { id: 'a', name: 'a', enrolled: true, in_order: true },
  order: ['a', 'b', 'c', 'd', 'e'],
  settings: { enabled: true, thresholds: { session: 15, weekly: 20 } },
  accounts: [
    { id: 'a', name: 'a', parked: false, blocked: null, in_order: true, updated: 1790875000, organization: 'Example Co',
      snapshot: [session(42.01, '2026-10-21T18:00:00+02:00'), weekly(70, '2026-10-27T09:00:00+02:00')] },
    { id: 'b', name: 'b', parked: true, blocked: null, in_order: true, updated: null, organization: "b's Organization",
      snapshot: [session(100), weekly(100)] },
    { id: 'c', name: 'c', parked: true, blocked: 'authentication_failed', in_order: true, updated: null, organization: null,
      snapshot: [session(50), weekly(50)] },
    { id: 'd', name: 'd', parked: false, blocked: null, in_order: true, updated: 'yesterday', organization: null,
      snapshot: [session(60), weekly(60)] },
  ],
})

// One account, active, with the given snapshot and settings; returns its list entry.
const oneWindow = (snapshot, settings = { thresholds: { session: 15, weekly: 20 } }) => {
  const report = { active: { id: 'a', name: 'a' }, order: ['a'], settings, accounts: [{ id: 'a', name: 'a', parked: false, blocked: null, in_order: true, snapshot }] }
  return listOf(report, { now: NOW, timeZone: TZ }).accounts[0].windows
}

const listed = (report) => listOf(report, { now: NOW, timeZone: TZ }).accounts
const byName = (report) => Object.fromEntries(listed(report).map((a) => [a.name, a]))

// --- windows: order and labels ---

test('windows are session, then the unscoped week, then scoped weeks by scope name, with the labels 5h, Week and "<scope> week"', () => {
  const report = {
    active: { id: 'a', name: 'a' },
    order: ['a'],
    settings: { model_limits: true, thresholds: { session: 15, weekly: 20 } },
    accounts: [{
      id: 'a', name: 'a', parked: false, blocked: null, in_order: true,
      snapshot: [scoped('Opus', 40), weekly(70), scoped('Fable', 30), session(80)],
    }],
  }
  const windows = listed(report)[0].windows
  assert.deepEqual(windows.map((w) => w.label), ['5h', 'Week', 'Fable week', 'Opus week'])
  assert.deepEqual(windows.map((w) => w.left), [80, 70, 30, 40])
})

test('scoped windows sort by scope name by code unit, not by the host locale', () => {
  const report = {
    active: { id: 'a', name: 'a' },
    order: ['a'],
    settings: { model_limits: true, thresholds: { session: 15, weekly: 20 } },
    accounts: [{ id: 'a', name: 'a', parked: false, blocked: null, in_order: true, snapshot: [scoped('a', 40), scoped('B', 30)] }],
  }
  assert.deepEqual(listed(report)[0].windows.map((w) => w.label), ['B week', 'a week'])
})

test('scoped windows are hidden when model limits are off', () => {
  const windows = oneWindow([session(80), weekly(70), scoped('Fable', 30)])
  assert.deepEqual(windows.map((w) => w.label), ['5h', 'Week'])
})

test('a window missing its numeric remaining or outside session and weekly is left out', () => {
  const windows = oneWindow([session(80), { kind: 'session', scope: null, group: 'session', remaining: 'lots' }, { kind: 'other', scope: null, group: 'opus', remaining: 5 }])
  assert.deepEqual(windows.map((w) => w.label), ['5h'])
})

// --- windows: left, tone, reset ---

test('left rounds the open window and tone is warning below the threshold, spent at 2 or less, fine otherwise', () => {
  const thirteen = oneWindow([session(13, '2026-10-24T13:00:00+02:00')])[0]
  assert.equal(thirteen.left, 13)
  assert.equal(thirteen.tone, 'warning')
  const two = oneWindow([session(2, '2026-10-24T13:00:00+02:00')])[0]
  assert.equal(two.left, 2)
  assert.equal(two.tone, 'spent', 'spent outranks the warning')
  const sixty = oneWindow([session(60)])[0]
  assert.equal(sixty.left, 60)
  assert.equal(sixty.tone, 'fine')
  assert.equal(oneWindow([session(42.6)])[0].left, 43)
})

test('the threshold for a session window is the session one and for a weekly window the weekly one', () => {
  const windows = oneWindow([session(18), weekly(18)])
  assert.equal(windows[0].tone, 'fine', '18 is above the session threshold 15')
  assert.equal(windows[1].tone, 'warning', '18 is below the weekly threshold 20')
})

test('a window exactly at its threshold is fine, not warning', () => {
  assert.equal(oneWindow([session(15)])[0].tone, 'fine')
})

test('without a threshold a window is never warning', () => {
  const windows = oneWindow([session(10), weekly(10)], {})
  assert.deepEqual(windows.map((w) => w.tone), ['fine', 'fine'])
})

test('a reset that has passed reads 100, fine, and "reset since"', () => {
  const [window] = oneWindow([session(3, '2026-10-21T09:00:00Z')])
  assert.deepEqual({ left: window.left, tone: window.tone, reset: window.reset }, { left: 100, tone: 'fine', reset: 'reset since' })
})

test('reset reads "resets <day> <time>" in the given zone, and is empty without a reset time', () => {
  const [open] = oneWindow([session(60, '2026-10-24T13:00:00+02:00')])
  assert.equal(open.reset, 'resets Sat 13:00')
  const [none] = oneWindow([session(60)])
  assert.equal(none.reset, '')
})

// --- account fields ---

test('each entry has name, 1-based index, missing, active, blocked, listed, plan, organization, updated, action and windows', () => {
  const [a] = listed(fixture())
  assert.deepEqual(Object.keys(a).sort(), ['action', 'active', 'blocked', 'index', 'listed', 'missing', 'name', 'organization', 'plan', 'updated', 'windows'])
  assert.equal(a.name, 'a')
  assert.equal(a.index, 1)
  assert.equal(a.missing, false)
  assert.equal(a.active, true)
  assert.equal(a.blocked, null)
  assert.equal(a.listed, true)
})

test('entries follow the order with placeholders included, and index counts them', () => {
  const accounts = listed(fixture())
  assert.deepEqual(accounts.map((a) => [a.name, a.index]), [['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5]])
})

test('a placeholder named in order with no record is missing, has no windows and no action', () => {
  const e = byName(fixture()).e
  assert.equal(e.missing, true)
  assert.deepEqual(e.windows, [])
  assert.equal(e.action, null)
  assert.equal(e.active, false)
  assert.equal(e.organization, null)
  assert.equal(e.updated, null)
  assert.equal(e.blocked, null)
})

test('the action is switch for a parked, unblocked, non-active account; reauth for blocked or not parked; null for the active one', () => {
  const accounts = byName(fixture())
  assert.equal(accounts.a.action, null, 'active')
  assert.equal(accounts.b.action, 'switch')
  assert.equal(accounts.c.action, 'reauth', 'blocked')
  assert.equal(accounts.d.action, 'reauth', 'not parked')
})

test('a parked account that is both blocked and not active needs a sign-in, not a switch', () => {
  const report = fixture()
  report.accounts[1].blocked = 'token_expired'
  assert.equal(byName(report).b.action, 'reauth')
})

test('blocked carries the reason and listed reflects in_order', () => {
  const report = fixture()
  report.accounts[2].in_order = false
  const accounts = byName(report)
  assert.equal(accounts.c.blocked, 'authentication_failed')
  assert.equal(accounts.c.listed, false)
  assert.equal(accounts.b.blocked, null)
})

test('organization shows the engine value and hides the "<name>\'s Organization" default', () => {
  const accounts = byName(fixture())
  assert.equal(accounts.a.organization, 'Example Co')
  assert.equal(accounts.b.organization, null, 'the default name is hidden')
  assert.equal(accounts.c.organization, null, 'an absent organization is null')
})

test('updated is the account reading time in seconds when finite, else null', () => {
  const report = fixture()
  report.accounts[2].updated = Number.NaN
  const accounts = byName(report)
  assert.equal(accounts.a.updated, 1790875000)
  assert.equal(accounts.b.updated, null)
  assert.equal(accounts.c.updated, null)
  assert.equal(accounts.d.updated, null, 'a string is not a time')
})

test('an unreadable account keeps its entry with no windows', () => {
  const report = fixture()
  report.accounts[1].snapshot = null
  assert.deepEqual(byName(report).b.windows, [])
})

test('listOf gives an empty list for a report with no accounts', () => {
  assert.deepEqual(listOf({}, { now: NOW, timeZone: TZ }), { accounts: [] })
})

// --- buildPanelData ---

test('buildPanelData gives a reachable host its list, and an unreachable host null', () => {
  const settings = { hosts: [{ name: 'mac' }, { name: 'devbox' }], target: 'mac' }
  const data = buildPanelData({
    settings,
    now: NOW,
    timeZone: TZ,
    hosts: [
      { host: settings.hosts[0], result: { ok: true, value: fixture() } },
      { host: settings.hosts[1], result: { ok: false, failure: { kind: 'unreachable', detail: 'Connection refused' } } },
    ],
  })
  const [mac, dev] = data.hosts
  assert.equal(mac.list.accounts.length, 5)
  assert.deepEqual(mac.list, listOf(fixture(), { now: NOW, timeZone: TZ }))
  assert.equal(dev.list, null)
})

// --- markup: renderCard with the list ---

// The card of a host named mac, open, rendered from the report (buildPanelData gives it the face and its list).
const cardOf = (report, { settings = {}, commands = {} } = {}) => {
  const host = { name: 'mac' }
  const data = buildPanelData({ settings: { hosts: [host], target: 'mac', ...settings }, now: NOW, timeZone: TZ, hosts: [{ host, result: { ok: true, value: report } }] })
  return renderCard({ ...data.hosts[0], open: true, face: data.face, view: data.view }, { mac: commands }, { timeZone: TZ })
}
const CMD = { enrol: 'enrol mac', swapTo: { a: 'swap a', b: 'swap b', c: 'swap c', d: 'swap d', e: 'swap e' } }
const articles = (html) => html.split('<article ').slice(1).map((a) => a.split('</article>')[0])
const acct = (html, name) => articles(html).find((a) => a.includes(`<span class="acct-name">${name}</span>`))

test('the list renders one article per account with its state class, and a List toggle after Clock', () => {
  const html = cardOf(fixture(), { commands: CMD })
  assert.ok(html.includes('<div class="list">'))
  assert.equal(articles(html).length, 5)
  assert.deepEqual(articles(html).map((a) => a.match(/^class="([^"]*)"/)[1]), ['acct acct-active', 'acct acct-ok', 'acct acct-blocked', 'acct acct-ok', 'acct acct-missing'])
  assert.ok(html.includes('<button class="face" data-face="clock">Clock</button><button class="face" data-face="list">List</button>'))
})

test('chips: Active, Blocked with its reason, Not in ACCOUNTS, and not enrolled', () => {
  const report = fixture()
  report.accounts[2].in_order = false
  const html = cardOf(report, { commands: CMD })
  assert.ok(acct(html, 'a').includes('<span class="chip chip-on">Active</span>'))
  assert.ok(acct(html, 'c').includes('<span class="chip chip-blocked">Blocked: authentication_failed</span>'))
  assert.ok(acct(html, 'c').includes('<span class="chip chip-muted">Not in ACCOUNTS</span>'))
  assert.ok(acct(html, 'e').includes('<span class="chip chip-muted">not enrolled</span>'))
  assert.equal(acct(html, 'b').includes('chip'), false)
})

test('Switch and Re-authenticate… buttons carry their commands; the active and missing accounts have none', () => {
  const html = cardOf(fixture(), { commands: CMD })
  assert.ok(acct(html, 'b').includes('<button class="act act-swap-to" data-host="mac" data-text="swap b" data-command="swap" data-params="{&quot;host&quot;:&quot;mac&quot;,&quot;account&quot;:&quot;b&quot;}">Switch</button>'))
  assert.ok(acct(html, 'c').includes('<button class="act act-reauth" data-host="mac" data-text="enrol mac" data-command="enrol" data-params="{&quot;host&quot;:&quot;mac&quot;,&quot;account&quot;:&quot;c&quot;}">Re-authenticate…</button>'))
  assert.ok(acct(html, 'd').includes('act act-reauth'))
  assert.equal(acct(html, 'a').includes('<button class="act'), false, 'active: no button')
  assert.equal(acct(html, 'e').includes('<button class="act'), false, 'missing: no button')
})

test('a button without its command is left out', () => {
  const html = cardOf(fixture(), { commands: { enrol: undefined, swapTo: {} } })
  assert.equal(acct(html, 'b').includes('act-swap-to'), false)
  assert.equal(acct(html, 'c').includes('act-reauth'), false)
})

test('the organisation line shows only a set organisation', () => {
  const html = cardOf(fixture(), { commands: CMD })
  assert.ok(acct(html, 'a').includes('<p class="acct-org">Example Co</p>'))
  assert.equal(acct(html, 'b').includes('acct-org'), false)
})

test('one win per window, with a clamped bar, the left text, and the reset text', () => {
  const html = cardOf(fixture(), { commands: CMD })
  const wins = acct(html, 'a').split('<div class="win">').slice(1)
  assert.equal(wins.length, 2)
  assert.ok(wins[0].includes('<span class="win-label">5h</span>'))
  assert.ok(wins[0].includes('<div class="bar-fill tone-fine" style="width:42%"></div>'))
  assert.ok(wins[0].includes('<span class="win-left tone-fine">42% left</span>'))
  assert.ok(wins[0].includes('<span class="win-reset">resets Wed 18:00</span>'))
  assert.ok(wins[1].includes('<span class="win-label">Week</span>'))
  // Two-line layout: label, left, reset, then the bar last.
  const at = (s) => wins[0].indexOf(s)
  assert.ok(at('win-label') < at('win-left') && at('win-left') < at('win-reset') && at('win-reset') < at('class="bar"'))
})

test('a bar is clamped to 0..100 while the text shows the value', () => {
  const html = cardOf({ active: { id: 'a', name: 'a' }, order: ['a'], settings: {}, accounts: [{ id: 'a', name: 'a', parked: false, blocked: null, in_order: true, snapshot: [session(150), weekly(-5)] }] }, { commands: CMD })
  assert.ok(html.includes('style="width:100%"'))
  assert.ok(html.includes('style="width:0%"'))
  assert.ok(html.includes('150% left'))
  assert.ok(html.includes('-5% left'))
})

test('p.reading carries the account updated time only when it is set, and is empty', () => {
  const html = cardOf(fixture(), { commands: CMD })
  assert.ok(acct(html, 'a').includes('<p class="reading" data-updated="1790875000"></p>'))
  assert.equal(acct(html, 'b').includes('reading'), false)
})

test('names, organisations and reasons are escaped', () => {
  const report = fixture()
  report.accounts[0].organization = '<script>x</script>'
  report.accounts[2].blocked = 'bad "reason" <script>'
  report.accounts[1].name = '<script>b</script>'
  report.order = ['a', '<script>b</script>', 'c', 'd', 'e']
  const html = cardOf(report, { commands: { enrol: 'enrol mac', swapTo: { '<script>b</script>': 'swap "b"' } } })
  assert.equal(html.includes('<script>x'), false)
  assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt;'))
  assert.ok(html.includes('Blocked: bad "reason" &lt;script&gt;'))
  assert.ok(html.includes('&lt;script&gt;b&lt;/script&gt;'))
  assert.ok(html.includes('data-text="swap &quot;b&quot;"'))
  assert.equal(html.includes('<script>'), false)
})

test('a card shows the list face when the settings say so, and the clock face otherwise', () => {
  assert.ok(cardOf(fixture(), { settings: { panelFace: 'list' }, commands: CMD }).includes('data-face="list"'))
  assert.ok(cardOf(fixture(), { commands: CMD }).includes('data-face="clock"'))
})

test('an unreachable host has no list block', () => {
  const host = { name: 'mac' }
  const data = buildPanelData({ settings: { hosts: [host], target: 'mac' }, now: NOW, timeZone: TZ, hosts: [{ host, result: { ok: false, failure: { kind: 'unreachable', detail: 'Connection refused' } } }] })
  const html = renderCard({ ...data.hosts[0], open: true, face: 'list', view: 'session' }, {}, { timeZone: TZ })
  assert.equal(html.includes('class="list"'), false)
})

test('a page renders the list card for the list face through renderPanel', () => {
  const data = buildPanelData({ settings: { hosts: [{ name: 'mac' }], target: 'mac', panelFace: 'list' }, now: NOW, timeZone: TZ, hosts: [{ host: { name: 'mac' }, result: { ok: true, value: fixture() } }] })
  const html = renderPanel(data, { template: '<!--__CARDS__--><script>/*__DATA__*/</script>', timeZone: TZ, clockSource: '' })
  assert.ok(html.includes('<section class="host" data-host="mac" data-view="session" data-face="list">'))
})

test('a placeholder is listed by definition: its markup has the not enrolled chip and no Not in ACCOUNTS chip', () => {
  const report = fixture()
  assert.equal(byName(report).e.listed, true)
  const html = cardOf(report, { commands: CMD })
  assert.ok(acct(html, 'e').includes('<span class="chip chip-muted">not enrolled</span>'))
  assert.equal(acct(html, 'e').includes('Not in ACCOUNTS'), false)
})

test('an active account that is blocked offers Re-authenticate… in the data and the markup, and an active unblocked one offers nothing', () => {
  const report = fixture()
  report.accounts[0].blocked = 'token_expired'
  assert.equal(byName(report).a.action, 'reauth')
  const html = cardOf(report, { commands: CMD })
  assert.ok(acct(html, 'a').includes('<button class="act act-reauth" data-host="mac" data-text="enrol mac" data-command="enrol" data-params="{&quot;host&quot;:&quot;mac&quot;,&quot;account&quot;:&quot;a&quot;}">Re-authenticate…</button>'))
  assert.equal(byName(fixture()).a.action, null, 'active, not blocked')
  assert.equal(acct(cardOf(fixture(), { commands: CMD }), 'a').includes('<button class="act'), false)
})

// --- plan chip ---

test('planLabel names the plan and appends the multiplier from seat_tier first, else tier', () => {
  assert.equal(planLabel({ type: 'claude_max', tier: 'default_claude_max_20x', seat_tier: null }), 'Ultra', 'Max 20x is now Ultra')
  assert.equal(planLabel({ type: 'claude_team', tier: 'default_claude_max_20x', seat_tier: 'default_claude_max_5x' }), 'Team 5x', 'Team keeps its multiplier')
  assert.equal(planLabel({ type: 'claude_pro' }), 'Pro')
  assert.equal(planLabel({ type: 'claude_enterprise', tier: 'enterprise' }), 'Enterprise')
  assert.equal(planLabel({ type: 'claude_free_trial' }), 'Free Trial')
  assert.equal(planLabel({ type: 'claude_max', tier: 'x' }), 'Max')
  assert.equal(planLabel({ type: 'claude_max', tier: 'box' }), 'Max', 'a multiplier needs an underscore before it')
  assert.equal(planLabel({ type: 'claude_team', tier: 'default_claude_max_20x', seat_tier: 'default' }), 'Team 20x', 'a seat_tier with no multiplier falls back to tier')
})

test('planLabel is null without a plan object or a type', () => {
  assert.equal(planLabel(null), null)
  assert.equal(planLabel(undefined), null)
  assert.equal(planLabel({}), null)
  assert.equal(planLabel('Max'), null)
  assert.equal(planLabel({ type: '' }), null)
})

test('listOf gives each account its plan label, null when the record has none', () => {
  const report = fixture()
  report.accounts[0].plan = { type: 'claude_max', tier: 'default_claude_max_20x', seat_tier: null }
  report.accounts[1].plan = { type: 'claude_team', tier: 'default_claude_max_20x', seat_tier: 'default_claude_max_5x' }
  const accounts = byName(report)
  assert.equal(accounts.a.plan, 'Ultra')
  assert.equal(accounts.b.plan, 'Team 5x')
  assert.equal(accounts.c.plan, null)
  assert.equal(accounts.e.plan, null, 'a placeholder has no plan')
})

test('the plan chip sits after the name, before Active, and is absent without a plan', () => {
  const report = fixture()
  report.accounts[0].plan = { type: 'claude_max', tier: 'default_claude_max_20x', seat_tier: null }
  const html = cardOf(report, { commands: CMD })
  const head = acct(html, 'a').split('<span class="spacer">')[0]
  assert.ok(head.includes('<span class="acct-name">a</span><span class="chip chip-muted">Ultra</span><span class="chip chip-on">Active</span>'))
  assert.equal(acct(html, 'b').includes('chip-muted">Max'), false)
})

test('the plan chip escapes its label', () => {
  const data = buildPanelData({ settings: { hosts: [{ name: 'mac' }], target: 'mac' }, now: NOW, timeZone: TZ, hosts: [{ host: { name: 'mac' }, result: { ok: true, value: fixture() } }] })
  const host = data.hosts[0]
  host.list.accounts[0].plan = '<b>Max</b>'
  const html = renderCard({ ...host, open: true, face: 'list', view: 'session' }, {}, { timeZone: TZ })
  assert.ok(acct(html, 'a').includes('<span class="chip chip-muted">&lt;b&gt;Max&lt;/b&gt;</span>'))
  assert.equal(acct(html, 'a').includes('<b>'), false)
})

test('planLabel takes the last non-empty underscore segment as the multiplier, only when it is digits then x', () => {
  assert.equal(planLabel({ type: 'claude_team', tier: 'default_claude_max_20x' }), 'Team 20x')
  assert.equal(planLabel({ type: 'claude_team', tier: '20x' }), 'Team 20x')
  assert.equal(planLabel({ type: 'claude_max', tier: 'default_claude_max_abx' }), 'Max')
  assert.equal(planLabel({ type: 'claude_max', tier: 'x' }), 'Max')
})

test('planLabel capitalises an unmapped plan type word by word, the rest of each word lower case', () => {
  assert.equal(planLabel({ type: 'claude_FREE_trial' }), 'Free Trial')
})
