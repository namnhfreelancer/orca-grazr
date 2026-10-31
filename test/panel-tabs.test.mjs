import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderCard, renderPanel } from '../lib/panel.mjs'
import { buildPanelData } from '../lib/panel-data.mjs'

// The host tabs: one tab per host, one card shown at a time. Hosts: mac (rotation on), lab (rotation off),
// devbox (unreachable) and old (no engine installed).
const PAGE = readFileSync(new URL('../panel/template.html', import.meta.url), 'utf8')
const TEMPLATE = '<main><!--__CARDS__--></main><script>const D = /*__DATA__*/;</script>'
const NOW = new Date('2026-10-22T10:00:00Z')

const session = (remaining) => [
  { kind: 'session', scope: null, group: 'session', remaining, resets_at: null },
  { kind: 'weekly_all', scope: null, group: 'weekly', remaining: 80, resets_at: null },
]
const report = (enabled) => ({
  active: { id: 'a', name: 'a', enrolled: true, in_order: true },
  order: ['a', 'b'],
  settings: { enabled, thresholds: { session: 15, weekly: 20 } },
  accounts: [
    { id: 'a', name: 'a', parked: false, blocked: null, snapshot: session(42) },
    { id: 'b', name: 'b', parked: true, blocked: null, snapshot: session(100) },
  ],
})
const HOSTS = [{ name: 'mac' }, { name: 'lab' }, { name: 'devbox' }, { name: 'old' }]
const fixture = (target = 'mac') => buildPanelData({
  settings: { hosts: HOSTS, target },
  now: NOW,
  timeZone: 'Europe/Zurich',
  hosts: [
    { host: HOSTS[0], result: { ok: true, value: report(true) } },
    { host: HOSTS[1], result: { ok: true, value: report(false) } },
    { host: HOSTS[2], result: { ok: false, failure: { kind: 'unreachable', detail: 'Connection refused' } } },
    { host: HOSTS[3], result: { ok: false, failure: { kind: 'not-installed', detail: 'no engine' } } },
  ],
})

const tabsOf = (html) => [...html.matchAll(/<button role="tab"[^>]*>[\s\S]*?<\/button>/g)].map((m) => m[0])
const attr = (tag, name) => tag.match(new RegExp(` ${name}="([^"]*)"`))?.[1]
const sectionsOf = (html) => [...html.matchAll(/<section role="tabpanel"[^>]*>/g)].map((m) => m[0])

test('renderPanel gives one tab per host, in the hosts order, inside a tablist nav', () => {
  const html = renderPanel(fixture(), { template: TEMPLATE, commands: {} })
  assert.ok(html.startsWith('<main><nav class="host-tabs" role="tablist"'))
  const tabs = tabsOf(html)
  assert.deepEqual(tabs.map((t) => attr(t, 'data-host')), ['mac', 'lab', 'devbox', 'old'])
  assert.ok(tabs.every((t) => /class="host-tab"/.test(t)))
})

test('the target tab is selected, the others are not, and only the selected tab takes the tab stop', () => {
  const tabs = tabsOf(renderPanel(fixture(), { template: TEMPLATE, commands: {} }))
  assert.deepEqual(tabs.map((t) => attr(t, 'aria-selected')), ['true', 'false', 'false', 'false'])
  assert.deepEqual(tabs.map((t) => attr(t, 'tabindex')), ['0', '-1', '-1', '-1'])
})

test('a target that names no host selects the first host, so one card always shows', () => {
  const html = renderPanel(fixture('nowhere'), { template: TEMPLATE, commands: {} })
  assert.deepEqual(tabsOf(html).map((t) => attr(t, 'aria-selected')), ['true', 'false', 'false', 'false'])
  assert.deepEqual(sectionsOf(html).map((s) => s.includes(' hidden')), [false, true, true, true])
})

test('each host has one tabpanel, and only the selected one is not hidden', () => {
  const html = renderPanel(fixture(), { template: TEMPLATE, commands: {} })
  const sections = sectionsOf(html)
  assert.deepEqual(sections.map((s) => attr(s, 'data-host')), ['mac', 'lab', 'devbox', 'old'])
  assert.ok(sections.every((s) => /class="host"/.test(s)))
  assert.deepEqual(sections.map((s) => s.includes(' hidden')), [false, true, true, true])
})

test('each tab names the tabpanel it controls, and the panel is labelled by its tab', () => {
  const html = renderPanel(fixture(), { template: TEMPLATE, commands: {} })
  const tabs = tabsOf(html)
  const sections = sectionsOf(html)
  tabs.forEach((tab, i) => {
    assert.equal(attr(tab, 'aria-controls'), `host-panel-${i}`)
    assert.equal(attr(sections[i], 'id'), `host-panel-${i}`)
    assert.equal(attr(sections[i], 'aria-labelledby'), `host-tab-${i}`)
    assert.equal(attr(tab, 'id'), `host-tab-${i}`)
  })
})

test('a tab shows the host name and a status dot: on when rotation runs, off when it does not, down when unreachable or not installed', () => {
  const tabs = tabsOf(renderPanel(fixture(), { template: TEMPLATE, commands: {} }))
  const dots = tabs.map((t) => t.match(/<span class="host-dot dot-([a-z]+)"/)?.[1])
  assert.deepEqual(dots, ['on', 'off', 'down', 'down'])
  assert.ok(tabs[0].includes('>mac<span class="host-dot'))
  assert.ok(tabs.every((t) => t.includes('aria-hidden="true"')))
})

test('the panel head keeps its chips and no longer repeats the host name', () => {
  const html = renderPanel(fixture(), { template: TEMPLATE, commands: {} })
  assert.equal(html.includes('<h2>'), false)
  const [mac, lab, dev, old] = html.split('<section role="tabpanel"').slice(1)
  const head = (section) => section.match(/<header class="host-head">[\s\S]*?<\/header>/)[0]
  assert.ok(head(mac).includes('<span class="chip chip-on">rotation on</span>'))
  assert.ok(head(lab).includes('<span class="chip chip-off">rotation off</span>'))
  assert.equal(head(mac).includes('>mac<'), false)
  assert.equal(head(lab).includes('>lab<'), false)
  assert.ok(dev.includes('chip-unreachable'), 'the unreachable chip stays in its card')
  assert.ok(old.includes('chip-not-installed'), 'the not-installed chip stays in its card')
})

test('the panel has no details or summary elements', () => {
  const html = renderPanel(fixture(), { template: TEMPLATE, commands: {} })
  assert.equal(/<details|<summary/.test(html), false)
})

test('renderCard puts the hidden attribute on a card that is not selected, and nothing on the selected one', () => {
  const [mac, lab] = fixture().hosts
  assert.ok(renderCard({ ...mac, open: true }, {}).startsWith('<section role="tabpanel" class="host" data-host="mac" id="host-panel-0" aria-labelledby="host-tab-0" data-view="session" data-face="clock">'))
  assert.ok(renderCard({ ...lab, open: false }, {}, { slot: 1 }).startsWith('<section role="tabpanel" class="host" data-host="lab" id="host-panel-1" aria-labelledby="host-tab-1" data-view="session" data-face="clock" hidden>'))
})

test('a panel with no hosts has no tab strip', () => {
  const html = renderPanel({ generatedAt: null, target: null, hosts: [], face: 'clock', view: 'session' }, { template: TEMPLATE, commands: {} })
  assert.equal(html.includes('role="tablist"'), false)
})

test('the page template has the tab strip and no details wrapper', () => {
  assert.ok(PAGE.includes('.host-tabs {'))
  assert.ok(PAGE.includes('.host-tab[aria-selected="true"]'))
  assert.ok(PAGE.includes('[hidden] { display: none !important; }'))
  assert.equal(PAGE.includes('.host-details'), false)
  assert.equal(PAGE.includes('.host-head h2'), false)
})
