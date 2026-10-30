import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { buildPanelData } from '../lib/panel-data.mjs'
import { renderPanel } from '../lib/panel.mjs'
import { mergeSettings } from '../lib/hosts.mjs'

const NOW = new Date('2026-10-22T10:00:00Z')
const TZ = 'Europe/Zurich'
// The fixture is a ceiling (300 accounts across 10 hosts, two model rings each, every button wired); a real panel is a few accounts.
const LIMIT = 1572864
const HOSTS = 10
const ACCOUNTS = 30

// Four windows per account: session, the unscoped week, and two scoped weeks, with model limits on.
const snapshot = (i) => [
  { kind: 'session', scope: null, group: 'session', remaining: (i * 7) % 100, resets_at: '2026-10-22T15:00:00+02:00' },
  { kind: 'weekly_all', scope: null, group: 'weekly', remaining: (i * 11) % 100, resets_at: '2026-10-28T09:00:00+01:00' },
  { kind: 'weekly_scoped', scope: 'Opus', group: 'weekly', remaining: (i * 13) % 100, resets_at: '2026-10-28T09:00:00+01:00' },
  { kind: 'weekly_scoped', scope: 'Fable', group: 'weekly', remaining: (i * 17) % 100, resets_at: null },
]

const reportFor = (h) => {
  const accounts = Array.from({ length: ACCOUNTS }, (_, i) => ({
    id: `h${h}a${i}`,
    name: `account-${h}-${i}`,
    parked: i !== 0,
    blocked: null,
    in_order: true,
    updated: 1790000000 + i,
    organization: `Org ${h}`,
    snapshot: snapshot(i),
  }))
  return {
    active: { id: accounts[0].id, name: accounts[0].name },
    order: accounts.map((a) => a.name),
    settings: { enabled: true, model_limits: true, thresholds: { session: 15, weekly: 20 } },
    accounts,
  }
}

// The commands the refresher builds for a host: each button's typed text, and one per account for Switch.
const commandsFor = (hostName, accounts) => ({
  refresh: `${hostName} refresh`,
  enrol: `${hostName} enrol`,
  swap: `${hostName} swap`,
  rotationOn: `${hostName} set ENABLED 1`,
  rotationOff: `${hostName} set ENABLED 0`,
  swapTo: Object.fromEntries(accounts.map((a) => [a.name, `${hostName} swap ${a.name}`])),
})

test('a page of 10 hosts with 30 accounts and 4 windows each, every button wired, on the list face, is under 1.5 MiB', async (t) => {
  const hosts = Array.from({ length: HOSTS }, (_, h) => ({ name: `host-${h}`, ssh: `host-${h}.example` }))
  const settings = mergeSettings({ panelFace: 'list', hosts, target: hosts[0].name })
  const data = buildPanelData({
    settings,
    now: NOW,
    timeZone: TZ,
    hosts: hosts.map((host, h) => ({ host, result: { ok: true, value: reportFor(h) } })),
  })
  const template = await readFile(fileURLToPath(new URL('../panel/template.html', import.meta.url)), 'utf8')
  const commands = Object.fromEntries(hosts.map((host, h) => [host.name, commandsFor(host.name, reportFor(h).accounts)]))
  const html = renderPanel(data, { template, timeZone: TZ, commands })
  const bytes = Buffer.byteLength(html, 'utf8')
  t.diagnostic(`page is ${bytes} bytes (limit ${LIMIT})`)
  assert.equal(data.face, 'list')
  assert.ok(html.includes('data-params='), 'the buttons carry their params')
  assert.ok(bytes < LIMIT, `page is ${bytes} bytes, limit ${LIMIT}`)
})
