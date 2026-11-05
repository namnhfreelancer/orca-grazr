import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPanelRefresher, NUMBERS_REWRITE_MS } from '../lib/panel-refresh.mjs'
import { fixtureSettings } from './support/fixture-hosts.mjs'
import { clockOf } from '../lib/panel.mjs'

const PLUGIN_ROOT = '/plug'
const PANEL = `${PLUGIN_ROOT}/panel/accounts.html`
const TEMPLATE = '<main><!--__CARDS__--></main><script>const D = /*__DATA__*/;</script>'

const report = (remaining = 40) => ({
  active: { name: 'work', id: 'a1' },
  settings: { enabled: true },
  accounts: [{ name: 'work', id: 'a1', snapshot: [{ kind: 'session', scope: null, group: 'session', remaining, resets_at: null }] }],
  connection: { foreign: {} },
})

// An in-memory fs that counts renames, the last step of every write, and logs it into events.
// dev: whether the root is a development checkout (holds a .git entry); stats counts every check of it.
function fakeFs(events = [], { dev = true } = {}) {
  const files = new Map([[`${PLUGIN_ROOT}/panel/template.html`, TEMPLATE]])
  const renames = []
  const stats = []
  return {
    files,
    renames,
    stats,
    async stat(path) {
      stats.push(path)
      if (dev && path === `${PLUGIN_ROOT}/.git`) return { isFile: () => false }
      const error = new Error('ENOENT')
      error.code = 'ENOENT'
      throw error
    },
    async readFile(path) {
      if (files.has(path)) return files.get(path)
      const error = new Error('ENOENT')
      error.code = 'ENOENT'
      throw error
    },
    async mkdir() {},
    async writeFile(path, data) { files.set(path, data) },
    async rename(from, to) {
      files.set(to, files.get(from))
      files.delete(from)
      renames.push(to)
      events.push('rename')
    },
    async unlink(path) { files.delete(path) },
  }
}

// Each harness answers status from a mutable report and records every status run with its timeout.
function harness({ settings = fixtureSettings(undefined), fs = fakeFs(), clock = { now: 1000 }, state = { report: report() }, events = [], bundled = async () => '0.4.7+fork.6' } = {}) {
  const calls = []
  const logs = []
  const bundledCalls = []
  const toolsFor = () => ({
    runner: {
      runJson: async (h, args, opts) => {
        calls.push({ name: h.name, args, timeoutMs: opts.timeoutMs })
        events.push(`status ${h.name}`)
        await new Promise((resolve) => setImmediate(resolve))
        // state.timeout names the hosts that hang; the failure carries the budget it was cut to, as the runner's does.
        if (state.timeout?.[h.name]) return { ok: false, failure: { kind: 'timeout', detail: `timed out after ${opts.timeoutMs / 1000}s` } }
        return { ok: true, value: state.report }
      },
    },
  })
  const refresher = createPanelRefresher({
    loadSettings: async () => settings,
    toolsFor,
    commandText: (s, h, args) => `${h.name} ${args.join(' ')}`,
    readTemplate: () => fs.readFile(`${PLUGIN_ROOT}/panel/template.html`, 'utf8'),
    readBundledVersion: () => {
      bundledCalls.push(true)
      return bundled()
    },
    root: PLUGIN_ROOT,
    fs,
    log: (msg) => logs.push(msg),
    now: () => clock.now,
  })
  return { refresher, clock, state, calls, logs, fs, events, bundledCalls }
}

test('two refreshes with identical reports and different times write once', async () => {
  const h = harness()
  assert.equal(await h.refresher.refresh(), 'written')
  h.clock.now = 5000
  assert.equal(await h.refresher.refresh(), 'unchanged')
  assert.equal(h.fs.renames.length, 1)
})

test('two refreshes with identical reports and different times write once, with clock data embedded', async () => {
  const h = harness()
  assert.equal(await h.refresher.refresh(), 'written')
  assert.ok(h.fs.files.get(PANEL).includes('"clock":'))
  h.clock.now = 5000
  assert.equal(await h.refresher.refresh(), 'unchanged')
  assert.equal(h.fs.renames.length, 1)
})

test('a changed remaining is written again', async () => {
  const h = harness()
  await h.refresher.refresh()
  h.state.report = report(10)
  assert.equal(await h.refresher.refresh(), 'written')
  assert.equal(h.fs.renames.length, 2)
  assert.ok(h.fs.files.get(PANEL).includes('10% left'))
})

// The active account's reading time, as the engine stamps it on every status-line reading.
const withUpdated = (updated, remaining = 40) => {
  const r = report(remaining)
  r.accounts[0].updated = updated
  return r
}

test('a refresh whose only change is the active account\'s updated time writes nothing', async () => {
  const h = harness({ state: { report: withUpdated(1000) } })
  assert.equal(await h.refresher.refresh(), 'written')
  h.state.report = withUpdated(1060)
  h.clock.now = 5000
  assert.equal(await h.refresher.refresh(), 'unchanged')
  assert.equal(h.fs.renames.length, 1)
})

test('with the list face, a refresh whose only change is the reading time writes nothing', async () => {
  const h = harness({ settings: fixtureSettings({ panelFace: 'list' }), state: { report: withUpdated(1000) } })
  assert.equal(await h.refresher.refresh(), 'written')
  assert.ok(h.fs.files.get(PANEL).includes('data-updated="1000"'))
  h.state.report = withUpdated(1060)
  h.clock.now = 5000
  assert.equal(await h.refresher.refresh(), 'unchanged')
  assert.equal(h.fs.renames.length, 1)
})

test('a changed remaining is written again when updated is present', async () => {
  const h = harness({ state: { report: withUpdated(1000) } })
  await h.refresher.refresh()
  h.state.report = withUpdated(1060, 10)
  assert.equal(await h.refresher.refresh(), 'written')
  assert.equal(h.fs.renames.length, 2)
  assert.ok(h.fs.files.get(PANEL).includes('10% left'))
})

test('changing the panelFace setting rewrites the page, so the next card opens on the new face', async () => {
  const settings = fixtureSettings(undefined)
  const h = harness({ settings })
  await h.refresher.refresh()
  assert.ok(h.fs.files.get(PANEL).includes('data-face="clock"'))
  settings.panelFace = 'dial'
  assert.equal(await h.refresher.refresh(), 'written')
  assert.ok(h.fs.files.get(PANEL).includes('data-face="dial"'))
})

test('a page reset by hand is rewritten on the next refresh, even though the data is unchanged', async () => {
  const h = harness()
  await h.refresher.refresh()
  h.fs.files.set(PANEL, '<p>placeholder</p>')
  assert.equal(await h.refresher.refresh(), 'written')
  assert.equal(h.fs.renames.length, 2)
  assert.notEqual(h.fs.files.get(PANEL), '<p>placeholder</p>')
})

test('an installed copy is skipped and logged once; unchanged data is not retried, changed data is', async () => {
  const fs = fakeFs([], { dev: false })
  const h = harness({ fs })
  assert.equal(await h.refresher.refresh(), 'skipped')
  assert.equal(await h.refresher.refresh(), 'skipped')
  assert.equal(fs.stats.length, 1)
  assert.equal(h.logs.filter((m) => m.startsWith('grazr: panel skipped')).length, 1)
  assert.equal(fs.renames.length, 0)
  h.state.report = report(10)
  assert.equal(await h.refresher.refresh(), 'skipped')
  assert.equal(fs.stats.length, 2)
  assert.equal(h.logs.filter((m) => m.startsWith('grazr: panel skipped')).length, 2)
  assert.equal(fs.renames.length, 0)
})

test('a deadline 2 s away skips every status run and logs it', async () => {
  const h = harness()
  assert.equal(await h.refresher.refresh({ deadline: h.clock.now + 2000 }), 'no-budget')
  assert.equal(h.calls.length, 0)
  assert.ok(h.logs.includes('grazr: panel refresh skipped, no budget left'))
  assert.equal(h.fs.renames.length, 0)
})

test('a deadline 6 s away runs each status with a 4 s timeout, the 2 s kill grace set aside', async () => {
  const h = harness()
  assert.equal(await h.refresher.refresh({ deadline: h.clock.now + 6000 }), 'written')
  assert.equal(h.calls.length, 3)
  assert.ok(h.calls.every((c) => c.timeoutMs === 4000))
})

test('the 3 s minimum is measured after the kill grace: 4.9 s away is too little, 5 s away runs a 3 s timeout', async () => {
  const short = harness()
  assert.equal(await short.refresher.refresh({ deadline: short.clock.now + 4900 }), 'no-budget')
  assert.equal(short.calls.length, 0)
  const enough = harness()
  assert.equal(await enough.refresher.refresh({ deadline: enough.clock.now + 5000 }), 'written')
  assert.ok(enough.calls.every((c) => c.timeoutMs === 3000))
})

test('without a deadline each status run keeps the 10 s timeout', async () => {
  const h = harness()
  await h.refresher.refresh()
  assert.ok(h.calls.every((c) => c.timeoutMs === 10000))
})

test('results passed in are used and no status run is made', async () => {
  const h = harness()
  const settings = fixtureSettings(undefined)
  const results = settings.hosts.map((host) => ({ host, result: { ok: true, value: report() } }))
  assert.equal(await h.refresher.refresh({ results, deadline: h.clock.now + 1000 }), 'written')
  assert.equal(h.calls.length, 0)
})

test('a refresh after a restart writes nothing when the page on disk already shows this data', async () => {
  const first = harness()
  assert.equal(await first.refresher.refresh(), 'written')
  const restarted = harness({ fs: first.fs, clock: { now: 9000 } })
  assert.equal(await restarted.refresher.refresh(), 'unchanged')
  assert.equal(first.fs.renames.length, 1)
})

test('a host that times out under a short budget keeps its last reading', async () => {
  const h = harness()
  assert.equal(await h.refresher.refresh(), 'written')
  h.state.timeout = { 'devbox': true }
  assert.equal(await h.refresher.refresh({ deadline: h.clock.now + 6000 }), 'unchanged')
  assert.equal(h.fs.renames.length, 1)
  assert.ok(h.calls.slice(-3).every((c) => c.timeoutMs < 10000))
})

test('a host with no earlier reading that times out under a short budget is unreachable', async () => {
  const h = harness()
  h.state.timeout = { 'devbox': true }
  assert.equal(await h.refresher.refresh({ deadline: h.clock.now + 6000 }), 'written')
  assert.ok(h.fs.files.get(PANEL).includes('chip-unreachable'))
})

test('a timeout at the full 10 s is unreachable even when the host had an earlier reading', async () => {
  const h = harness()
  await h.refresher.refresh()
  h.state.timeout = { 'devbox': true }
  assert.equal(await h.refresher.refresh(), 'written')
  assert.ok(h.fs.files.get(PANEL).includes('chip-unreachable'))
})

test('a hanging host writes the same page whatever budget it timed out under', async () => {
  const h = harness()
  h.state.timeout = { 'devbox': true }
  assert.equal(await h.refresher.refresh({ deadline: h.clock.now + 6000 }), 'written')
  assert.equal(await h.refresher.refresh({ deadline: h.clock.now + 5000 }), 'unchanged')
  assert.equal(h.fs.renames.length, 1)
})

test('a host whose accounts is not a list does not stop the other hosts refreshing', async () => {
  for (const accounts of [7, 'x', {}]) {
    const h = harness()
    const results = [
      { host: { name: 'mac' }, result: { ok: true, value: { ...report(), accounts } } },
      { host: { name: 'devbox' }, result: { ok: true, value: report() } },
    ]
    assert.equal(await h.refresher.refresh({ results }), 'written')
    assert.ok(h.fs.files.get(PANEL).includes('devbox'))
  }
})

test('two concurrent refreshes run one after another, the second asking after the first has written', async () => {
  const events = []
  const h = harness({ events, fs: fakeFs(events) })
  await Promise.all([h.refresher.refresh(), h.refresher.refresh()])
  assert.equal(events.indexOf('rename'), 3)
  assert.deepEqual(events.slice(0, 3).map((e) => e.split(' ')[0]), ['status', 'status', 'status'])
  assert.ok(events.slice(4).every((e) => e.startsWith('status ')))
})

test('the rotation button types set ENABLED 0 while rotation is on, and set ENABLED 1 while it is off', async () => {
  const h = harness()
  await h.refresher.refresh()
  const page = h.fs.files.get(PANEL)
  assert.ok(page.includes('data-text="mac set ENABLED 0"'))
  assert.ok(page.includes('>Turn rotation off<'))
  h.state.report = { ...report(), settings: { enabled: false } }
  await h.refresher.refresh()
  const off = h.fs.files.get(PANEL)
  assert.ok(off.includes('data-text="mac set ENABLED 1"'))
  assert.ok(off.includes('>Turn rotation on<'))
})

test('the bundled engine version is read once, however many refreshes run', async () => {
  const h = harness()
  await h.refresher.refresh()
  h.state.report = report(10)
  await h.refresher.refresh()
  assert.equal(h.bundledCalls.length, 1)
})

test('a bundled version that cannot be read is logged once and the refresh still writes the page', async () => {
  const h = harness({ bundled: async () => { throw new Error('no VERSION line in /plug/engine/grazr.py') } })
  assert.equal(await h.refresher.refresh(), 'written')
  h.state.report = report(10)
  assert.equal(await h.refresher.refresh(), 'written')
  assert.equal(h.logs.filter((m) => m.includes('engine version unknown')).length, 1)
  assert.equal(h.bundledCalls.length, 1)
  assert.ok(!h.fs.files.get(PANEL).includes('engine update available'))
})

test('the header time is not part of the change key: a skipped page stays skipped when only the time moves', async () => {
  const fs = fakeFs([], { dev: false })
  const h = harness({ fs })
  assert.equal(await h.refresher.refresh(), 'skipped')
  h.clock.now = 600000
  assert.equal(await h.refresher.refresh(), 'skipped')
  assert.equal(fs.stats.length, 1)
})

test('an unchanged page is not rewritten when only the header time moves a minute', async () => {
  const withThresholds = { ...report(), settings: { enabled: true, thresholds: { session: 15, weekly: 20 } } }
  const h = harness({ state: { report: withThresholds } })
  const start = Date.parse('2026-10-22T00:24:30Z')
  h.clock.now = start
  assert.equal(await h.refresher.refresh(), 'written')
  assert.match(h.fs.files.get(PANEL), / · updated \d{2}:\d{2}</)
  h.clock.now = start + 60000
  assert.notEqual(clockOf(new Date(start).toISOString()), clockOf(new Date(start + 60000).toISOString()))
  assert.equal(await h.refresher.refresh(), 'unchanged')
  assert.equal(h.fs.renames.length, 1)
})

test('a host cut off under a short budget keeps the time of its last good reading in its header', async () => {
  const withThresholds = (remaining) => ({ ...report(remaining), settings: { enabled: true, thresholds: { session: 15, weekly: 20 } } })
  const h = harness({ state: { report: withThresholds(40) } })
  const first = Date.parse('2026-10-22T00:24:30Z')
  const later = first + 5 * 60000
  assert.notEqual(clockOf(new Date(first).toISOString()), clockOf(new Date(later).toISOString()))
  h.clock.now = first
  assert.equal(await h.refresher.refresh(), 'written')
  h.clock.now = later
  h.state.timeout = { 'devbox': true }
  assert.equal(await h.refresher.refresh({ deadline: h.clock.now + 6000 }), 'unchanged')
  // The data changes, so the page is rendered: the target reads now, the cut-off host keeps its first time.
  h.state.report = withThresholds(10)
  assert.equal(await h.refresher.refresh({ deadline: h.clock.now + 6000 }), 'written')
  const page = h.fs.files.get(PANEL)
  const mac = page.slice(page.indexOf('<section role="tabpanel" class="host" data-host="mac"'), page.indexOf('<section role="tabpanel" class="host" data-host="devbox"'))
  const cloudDev = page.slice(page.indexOf('<section role="tabpanel" class="host" data-host="devbox"'))
  assert.ok(mac.includes(`updated ${clockOf(new Date(later).toISOString())}`))
  assert.ok(cloudDev.includes(`updated ${clockOf(new Date(first).toISOString())}`))
})

// The active account with its reading time, and a parked spare whose reading time the test moves.
const withSpare = (spareUpdated, workUpdated = 1000) => {
  const r = withUpdated(workUpdated)
  r.order = ['work', 'spare']
  r.accounts.push({ name: 'spare', id: 'b2', parked: true, blocked: null, in_order: true, updated: spareUpdated, snapshot: [{ kind: 'session', scope: null, group: 'session', remaining: 60, resets_at: null }] })
  return r
}

test('with the list face, a refresh whose only change is a parked account\'s reading time writes nothing', async () => {
  const h = harness({ settings: fixtureSettings({ panelFace: 'list' }), state: { report: withSpare(1000) } })
  assert.equal(await h.refresher.refresh(), 'written')
  assert.ok(h.fs.files.get(PANEL).includes('data-updated="1000"'))
  h.state.report = withSpare(1060)
  h.clock.now = 5000
  assert.equal(await h.refresher.refresh(), 'unchanged')
  assert.equal(h.fs.renames.length, 1)
})

test('after an installed copy is skipped, a refresh whose only change is list.accounts updated is skipped too, without a new log line or check', async () => {
  const fs = fakeFs([], { dev: false })
  const h = harness({ fs, settings: fixtureSettings({ panelFace: 'list' }), state: { report: withSpare(1000) } })
  assert.equal(await h.refresher.refresh(), 'skipped')
  assert.equal(fs.stats.length, 1)
  h.state.report = withSpare(1060)
  h.clock.now = 5000
  assert.equal(await h.refresher.refresh(), 'skipped')
  assert.equal(fs.stats.length, 1, 'the key matched, so no write was attempted')
  assert.equal(h.logs.filter((m) => m.startsWith('grazr: panel skipped')).length, 1)
  assert.equal(fs.renames.length, 0)
})

// A file system that knows when the page was last written, as a real one does.
function timedFs(clock) {
  const fs = fakeFs()
  let writtenAt = null
  const rename = fs.rename
  const stat = fs.stat
  fs.rename = async (from, to) => { await rename(from, to); if (to === PANEL) writtenAt = clock.now }
  fs.stat = async (path) => (path === PANEL && writtenAt !== null ? { mtimeMs: writtenAt } : stat(path))
  return fs
}

test('a page whose numbers alone moved is rewritten at most once per NUMBERS_REWRITE_MS, so a dev panel does not keep reloading', async () => {
  const withThresholds = (remaining) => ({ ...report(remaining), settings: { enabled: true, thresholds: { session: 15, weekly: 20 } } })
  const clock = { now: Date.parse('2026-10-22T00:24:30Z') }
  const h = harness({ fs: timedFs(clock), clock, state: { report: withThresholds(47) } })
  assert.equal(await h.refresher.refresh(), 'written')
  h.state.report = withThresholds(46)
  clock.now += 60000
  assert.equal(await h.refresher.refresh(), 'unchanged')
  // A person asking writes the new numbers at once.
  assert.equal(await h.refresher.refresh({ fresh: true }), 'written')
  h.state.report = withThresholds(45)
  clock.now += NUMBERS_REWRITE_MS
  assert.equal(await h.refresher.refresh(), 'written')
  assert.equal(h.fs.renames.length, 3)
})

test('a change beyond the numbers is written at once, however recent the last write', async () => {
  const withThresholds = (remaining) => ({ ...report(remaining), settings: { enabled: true, thresholds: { session: 15, weekly: 20 } } })
  const clock = { now: Date.parse('2026-10-22T00:24:30Z') }
  const h = harness({ fs: timedFs(clock), clock, state: { report: withThresholds(47) } })
  assert.equal(await h.refresher.refresh(), 'written')
  clock.now += 1000
  // Below the 15% threshold the account's state and tone change, not only its number.
  h.state.report = withThresholds(10)
  assert.equal(await h.refresher.refresh(), 'written')
})
