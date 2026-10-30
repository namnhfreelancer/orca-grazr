import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderCard } from '../lib/panel.mjs'
import { buildPanelData } from '../lib/panel-data.mjs'

// Each button carries the worker command it runs (data-command) and the params it takes (data-params, JSON).
const NOW = new Date('2026-10-30T10:00:00Z')
const TZ = 'Europe/Zurich'
const session = (remaining) => [
  { kind: 'session', scope: null, group: 'session', remaining, resets_at: null },
  { kind: 'weekly_all', scope: null, group: 'weekly', remaining: 80, resets_at: null },
]
const report = () => ({
  active: { id: 'a', name: 'a', enrolled: true, in_order: true },
  order: ['a', 'b', 'c'],
  settings: { enabled: true, thresholds: { session: 15, weekly: 20 } },
  accounts: [
    { id: 'a', name: 'a', parked: false, blocked: null, snapshot: session(42) },
    { id: 'b', name: 'b', parked: true, blocked: null, snapshot: session(100) },
    { id: 'c', name: 'c', parked: true, blocked: 'authentication_failed', snapshot: null },
  ],
})
const CMD = { refresh: 'mac refresh', enrol: 'mac enrol', swap: 'mac swap', rotationOn: 'mac set ENABLED 1', rotationOff: 'mac set ENABLED 0', swapTo: { b: 'mac swap b', c: 'mac swap c' } }

function cardOf(value, { enabled = true, commands = { mac: CMD }, face = 'list' } = {}) {
  const settings = { hosts: [{ name: 'mac' }], target: 'mac', panelFace: face }
  const data = buildPanelData({
    settings,
    now: NOW,
    timeZone: TZ,
    hosts: [{ host: settings.hosts[0], result: { ok: true, value: { ...value, settings: { ...value.settings, enabled } } } }],
  })
  return renderCard({ ...data.hosts[0], open: true, face, view: 'session' }, commands, { timeZone: TZ })
}

// The whole button element whose class carries kind, label included.
const buttonOf = (html, kind) => html.match(new RegExp(`<button class="act act-${kind}"[^>]*>[^<]*</button>`))?.[0]
const attrsOf = (tag) => Object.fromEntries([...tag.matchAll(/(data-[\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]))
const UNESCAPE = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }
// The data-params attribute, unescaped and parsed.
const paramsOf = (tag) => JSON.parse(attrsOf(tag)['data-params'].replace(/&(amp|lt|gt|quot|#39);/g, (m) => UNESCAPE[m]))

test('the card actions carry their commands: refresh, panel refresh, add account, rotation off, swap to next', () => {
  const html = cardOf(report())
  const refresh = buttonOf(html, 'refresh')
  assert.equal(attrsOf(refresh)['data-command'], 'refresh')
  assert.deepEqual(paramsOf(refresh), { host: 'mac' })
  assert.ok(refresh.endsWith('>Refresh parked</button>'))
  const panel = buttonOf(html, 'panel-refresh')
  assert.equal(attrsOf(panel)['data-command'], 'panel-refresh')
  assert.deepEqual(paramsOf(panel), {})
  assert.ok(panel.endsWith('>Refresh panel</button>'))
  const enrol = buttonOf(html, 'enrol')
  assert.equal(attrsOf(enrol)['data-command'], 'enrol')
  assert.deepEqual(paramsOf(enrol), { host: 'mac' })
  const rotation = buttonOf(html, 'rotation')
  assert.equal(attrsOf(rotation)['data-command'], 'rotation-toggle')
  assert.deepEqual(paramsOf(rotation), { host: 'mac', enabled: false })
  const swap = buttonOf(html, 'swap')
  assert.equal(attrsOf(swap)['data-command'], 'swap')
  assert.deepEqual(paramsOf(swap), { host: 'mac' })
})

test('the rotation button asks for the on state while rotation is off', () => {
  const rotation = buttonOf(cardOf(report(), { enabled: false }), 'rotation')
  assert.ok(rotation.endsWith('>Turn rotation on</button>'))
  assert.deepEqual(paramsOf(rotation), { host: 'mac', enabled: true })
})

test('the list face carries the account in its switch and re-authenticate buttons', () => {
  const html = cardOf(report())
  const swap = buttonOf(html, 'swap-to')
  assert.equal(attrsOf(swap)['data-command'], 'swap')
  assert.deepEqual(paramsOf(swap), { host: 'mac', account: 'b' })
  const reauth = buttonOf(html, 'reauth')
  assert.equal(attrsOf(reauth)['data-command'], 'enrol')
  assert.deepEqual(paramsOf(reauth), { host: 'mac', account: 'c' })
})

test('the clock face row buttons carry the row account', () => {
  const html = cardOf(report(), { face: 'clock' })
  const reauth = buttonOf(html, 'reauth')
  assert.deepEqual(paramsOf(reauth), { host: 'mac', account: 'c' })
  const swap = buttonOf(html, 'swap-to')
  assert.deepEqual(paramsOf(swap), { host: 'mac', account: 'b' })
})

test('an account name is attribute-escaped in data-params and round-trips', () => {
  const value = report()
  value.order.push('o"brien <x> \'y\'')
  value.accounts.push({ id: 'q', name: 'o"brien <x> \'y\'', parked: true, blocked: 'bad', snapshot: null })
  const html = cardOf(value, { commands: { mac: { ...CMD, swapTo: { 'o"brien <x> \'y\'': 'mac swap x' } } } })
  assert.equal(html.includes('<x>'), false)
  const tag = [...html.matchAll(/<button class="act act-reauth"[^>]*>[^<]*<\/button>/g)].map((m) => m[0]).find((t) => t.includes('brien'))
  assert.ok(tag, 'the escaped account appears in a reauth button')
  assert.deepEqual(paramsOf(tag), { host: 'mac', account: 'o"brien <x> \'y\'' })
})

test('a button without its typed command is left out, and Refresh panel still shows with no commands', () => {
  const html = cardOf(report(), { commands: {} })
  assert.equal(html.includes('act-swap-to'), false)
  assert.equal(html.includes('act-refresh'), false)
  assert.ok(buttonOf(html, 'panel-refresh'))
})
