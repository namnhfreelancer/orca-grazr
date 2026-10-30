import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDrainLoop } from '../lib/drain.mjs'
import { mergeSettings } from '../lib/hosts.mjs'

const INTERVAL = 120000
const dev2 = { name: 'devbox-2', ssh: 'devbox-2', python: 'python3', notifier: 'queue' }
const dev1 = { name: 'devbox', ssh: 'devbox', python: 'python3', notifier: 'queue' }
const laptop = { name: 'mac', ssh: null, python: 'python3', notifier: 'osascript' }
const ok = (lines = []) => ({ ok: true, lines })
const fail = (kind, detail = '') => ({ ok: false, lines: [], failure: { kind, detail } })
const line = (title, body = '') => JSON.stringify({ ts: 1, title, body })

// Records scheduled timers; the test fires them by hand.
function fakeTimers() {
  const pending = []
  return {
    timers: {
      setTimeout(fn, ms) {
        const timer = { fn, ms, cleared: false, fired: false }
        pending.push(timer)
        return timer
      },
      clearTimeout(timer) {
        if (timer) timer.cleared = true
      },
    },
    live: () => pending.filter((t) => !t.cleared && !t.fired),
    fire() {
      const timer = pending.find((t) => !t.cleared && !t.fired)
      timer.fired = true
      return timer.fn()
    },
  }
}

function harness({ hosts = [dev2, laptop], storageData = {}, now = 0, overrides = {}, hostThrowsFor = null, afterTick } = {}) {
  const trace = []
  const t = fakeTimers()
  const clock = { now }
  const answers = {}
  const runnerCalls = []
  const shown = []
  const logs = []
  const data = { ...storageData }
  const runner = {
    runLines: async (h, args, opts) => {
      trace.push(`run:${h.name}`)
      runnerCalls.push({ name: h.name, args, opts })
      const answer = answers[h.name]
      return typeof answer === 'function' ? answer() : answer ?? ok()
    },
  }
  const storage = {
    get: async (key) => {
      trace.push(`get:${key}`)
      return data[key]
    },
    set: async (key, value) => {
      trace.push(`set:${key}`)
      data[key] = structuredClone(value)
    },
  }
  const host = async (name, params) => {
    shown.push({ name, params })
    if (hostThrowsFor && params.title.startsWith(hostThrowsFor)) throw new Error('host down')
    return {}
  }
  const stored = { hosts, drainIntervalMs: INTERVAL, ...overrides }
  const holder = { settings: mergeSettings(stored) }
  const drain = createDrainLoop({
    loadSettings: async () => holder.settings,
    runnerFor: () => runner,
    host,
    log: (msg) => logs.push(msg),
    timers: t.timers,
    now: () => clock.now,
    storage,
    afterTick,
  })
  const setStored = (over) => { holder.settings = mergeSettings({ ...stored, ...over }) }
  return { drain, t, clock, answers, runnerCalls, shown, logs, trace, data, setStored }
}

const titles = (shown) => shown.map((s) => s.params.title)

test('start() schedules one timer at drainIntervalMs and does not run immediately', () => {
  const h = harness()
  h.drain.start()
  const live = h.t.live()
  assert.equal(live.length, 1)
  assert.equal(live[0].ms, INTERVAL)
  assert.equal(h.runnerCalls.length, 0)
  assert.equal(h.drain.isRunning(), true)
})

test('start() twice schedules a single timer', () => {
  const h = harness()
  h.drain.start()
  h.drain.start()
  assert.equal(h.t.live().length, 1)
})

test('stop() clears the timer and reports not running', () => {
  const h = harness()
  h.drain.start()
  h.drain.stop()
  assert.equal(h.t.live().length, 0)
  assert.equal(h.drain.isRunning(), false)
})

test('a fired timer ticks, drains and re-arms while still running', async () => {
  const h = harness()
  h.answers['devbox-2'] = ok([line('Swapped')])
  h.drain.start()
  await h.t.fire()
  assert.equal(h.runnerCalls.length, 1)
  assert.equal(h.t.live().length, 1)
})

test('tick() reads the heartbeat first, then drains only queue hosts', async () => {
  const h = harness({ hosts: [dev2, laptop] })
  h.answers['devbox-2'] = ok([line('Swapped', 'to acct')])
  await h.drain.tick()
  assert.equal(h.trace[0], 'get:lastDrainAt')
  assert.ok(h.trace.indexOf('get:lastDrainAt') < h.trace.indexOf('run:devbox-2'))
  assert.deepEqual(h.runnerCalls.map((c) => c.name), ['devbox-2'])
  assert.deepEqual(h.runnerCalls[0].args, ['notices-drain'])
  assert.deepEqual(h.runnerCalls[0].opts, { timeoutMs: 10000 })
  assert.deepEqual(h.shown, [
    { name: 'notifications.show', params: { title: 'devbox-2: Swapped', body: 'to acct' } },
  ])
})

test('a host whose notifier has no queue is never drained', async () => {
  const h = harness({ hosts: [laptop, dev2] })
  h.answers['devbox-2'] = ok()
  await h.drain.tick()
  await h.drain.tick({ force: true })
  assert.ok(h.runnerCalls.every((c) => c.name !== 'mac'))
  assert.deepEqual(h.runnerCalls.map((c) => c.name), ['devbox-2', 'devbox-2'])
})

test('tick() caps toasts per host and adds one "+N more" toast', async () => {
  const h = harness({ hosts: [dev2], overrides: { maxToastsPerHostPerCycle: 5 } })
  h.answers['devbox-2'] = ok(Array.from({ length: 7 }, (_, i) => line(`n${i}`)))
  await h.drain.tick()
  assert.deepEqual(titles(h.shown), [
    'devbox-2: n0', 'devbox-2: n1', 'devbox-2: n2', 'devbox-2: n3', 'devbox-2: n4',
    'devbox-2: +2 more notices',
  ])
})

test('an unparsable line is skipped and logged while the others still toast', async () => {
  const h = harness({ hosts: [dev2] })
  h.answers['devbox-2'] = ok(['not json', line('Good')])
  await h.drain.tick()
  assert.deepEqual(titles(h.shown), ['devbox-2: Good'])
  assert.ok(h.logs.some((m) => String(m).includes('unparsable')))
})

test('a failing host toasts once, honours backoff, forces through, and retries after the window', async () => {
  const h = harness({ hosts: [dev2] })
  h.answers['devbox-2'] = () => fail('unreachable', 'Connection refused')

  await h.drain.tick()
  assert.equal(h.runnerCalls.length, 1)
  assert.deepEqual(h.shown.map((s) => s.params), [{ title: 'devbox-2: drain failed', body: 'unreachable: Connection refused' }])
  assert.equal(h.drain.state().backoff['devbox-2'].until, INTERVAL * 2)

  h.clock.now = 60000
  await h.drain.tick()
  assert.equal(h.runnerCalls.length, 1, 'second tick inside the window must not call the runner')

  await h.drain.tick({ force: true })
  assert.equal(h.runnerCalls.length, 2, 'force must call the runner')
  assert.equal(h.shown.length, 1, 'the second failure must not toast')

  h.clock.now = 600000
  await h.drain.tick()
  assert.equal(h.runnerCalls.length, 3, 'after the window the host is retried')
  assert.equal(h.shown.length, 1, 'the third consecutive failure must not toast')
})

test('a force tick on a failing host increments its backoff attempts', async () => {
  const h = harness({ hosts: [dev2] })
  h.answers['devbox-2'] = () => fail('unreachable', 'down')
  await h.drain.tick()
  await h.drain.tick({ force: true })
  assert.equal(h.drain.state().backoff['devbox-2'].attempts, 2)
})

test('start() then tick() issues the lastDrainAt heartbeat before any runner call', async () => {
  const h = harness({ hosts: [dev2] })
  h.answers['devbox-2'] = ok()
  h.drain.start()
  await h.drain.tick()
  const heartbeat = h.trace.indexOf('get:lastDrainAt')
  assert.notEqual(heartbeat, -1)
  assert.ok(heartbeat < h.trace.indexOf('run:devbox-2'))
})

test('a host whose notices cannot be delivered does not stop the other host or the state save', async () => {
  const h = harness({ hosts: [dev1, dev2] })
  h.answers['devbox'] = () => ({ ok: true })
  h.answers['devbox-2'] = ok([line('B')])
  await h.drain.tick()
  assert.ok(titles(h.shown).includes('devbox-2: B'))
  assert.ok(titles(h.shown).includes('devbox: drain failed'))
  assert.equal(h.drain.state().backoff['devbox'].kind, 'error')
  assert.equal(h.trace.at(-1), 'set:drainState')
})

test('a host whose notifications.show throws does not stop the other host or the state save', async () => {
  const h = harness({ hosts: [dev1, dev2], hostThrowsFor: 'devbox:' })
  h.answers['devbox'] = ok([line('A')])
  h.answers['devbox-2'] = ok([line('B')])
  await h.drain.tick()
  assert.deepEqual(h.runnerCalls.map((c) => c.name).sort(), ['devbox', 'devbox-2'])
  assert.ok(titles(h.shown).includes('devbox-2: B'))
  assert.equal(h.trace.at(-1), 'set:drainState')
})

test('a storage.get rejecting with undefined does not abort the tick', async () => {
  const runnerCalls = []
  const drain = createDrainLoop({
    loadSettings: async () => mergeSettings({ hosts: [dev2], drainIntervalMs: INTERVAL }),
    runnerFor: () => ({ runLines: async (h) => { runnerCalls.push(h.name); return ok() } }),
    host: async () => ({}),
    log: () => {},
    timers: { setTimeout: () => ({}), clearTimeout() {} },
    now: () => 0,
    storage: { get: () => Promise.reject(undefined), set: async () => {} },
  })
  await drain.tick()
  assert.deepEqual(runnerCalls, ['devbox-2'])
})

test('a success clears the backoff so the next failure toasts again', async () => {
  const h = harness({ hosts: [dev2] })
  h.answers['devbox-2'] = () => fail('unreachable', 'down')
  await h.drain.tick()
  h.clock.now = 300000
  h.answers['devbox-2'] = ok()
  await h.drain.tick()
  assert.equal(h.drain.state().backoff['devbox-2'], undefined)
  h.clock.now = 10000000
  h.answers['devbox-2'] = () => fail('unreachable', 'down again')
  await h.drain.tick()
  assert.deepEqual(titles(h.shown), ['devbox-2: drain failed', 'devbox-2: drain failed'])
})

test('backoff is capped at one hour', async () => {
  const h = harness({
    hosts: [dev2],
    now: 1000,
    storageData: { drainState: { backoff: { 'devbox-2': { attempts: 60, until: 0, kind: 'x' } } } },
  })
  h.answers['devbox-2'] = () => fail('unreachable')
  await h.drain.tick()
  const { until } = h.drain.state().backoff['devbox-2']
  assert.ok(until - 1000 <= 3600000)
  assert.equal(until - 1000, 3600000)
})

test('no more than three hosts are drained at once', async () => {
  const hosts = [dev1, dev2, { ...dev2, name: 'h3' }, { ...dev2, name: 'h4' }, { ...dev2, name: 'h5' }]
  const h = harness({ hosts })
  let inFlight = 0
  let maxInFlight = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  for (const { name } of hosts) {
    h.answers[name] = async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await gate
      inFlight -= 1
      return ok()
    }
  }
  const done = h.drain.tick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(inFlight, 3)
  release()
  await done
  assert.equal(h.runnerCalls.length, 5)
  assert.equal(maxInFlight, 3)
})

test('state is persisted with storage.set after each tick', async () => {
  const h = harness({ hosts: [dev2] })
  h.clock.now = 555
  h.answers['devbox-2'] = ok([line('A')])
  await h.drain.tick()
  assert.equal(h.trace.at(-1), 'set:drainState')
  assert.deepEqual(h.data.drainState, { backoff: {}, lastDrainAt: 555 })
})

test('start() seeds backoff from stored state so a host in backoff is skipped on the first tick', async () => {
  const h = harness({
    hosts: [dev2],
    now: 1000,
    storageData: { drainState: { backoff: { 'devbox-2': { attempts: 1, until: 999999, kind: 'unreachable' } }, lastDrainAt: 5 } },
  })
  h.drain.start()
  await h.drain.tick()
  assert.equal(h.runnerCalls.length, 0)
  assert.equal(h.drain.state().lastDrainAt, 5)
})

test('a throwing notifications.show does not abort the tick', async () => {
  const h = harness({ hosts: [dev1, dev2] })
  h.answers['devbox'] = () => ok([line('A')])
  h.answers['devbox-2'] = () => ok([line('B')])
  const throwingHost = async () => { throw new Error('boom') }
  const drain = createDrainLoop({
    loadSettings: async () => mergeSettings({ hosts: [dev1, dev2], drainIntervalMs: INTERVAL }),
    runnerFor: () => ({ runLines: async (hh) => h.answers[hh.name]() }),
    host: throwingHost,
    log: (msg) => h.logs.push(msg),
    timers: { setTimeout: () => ({}), clearTimeout() {} },
    now: () => 0,
    storage: { get: async () => undefined, set: async () => {} },
  })
  await drain.tick()
  assert.equal(h.logs.filter((m) => String(m).includes('boom')).length, 2)
})

test('settings are re-read each tick, so a host dropped from settings is not drained', async () => {
  const h = harness({ hosts: [dev1, dev2] })
  h.answers['devbox'] = ok()
  h.answers['devbox-2'] = ok()
  await h.drain.tick()
  h.setStored({ hosts: [dev2] })
  await h.drain.tick({ force: true })
  assert.deepEqual(h.runnerCalls.map((c) => c.name), ['devbox', 'devbox-2', 'devbox-2'])
})

test('a changed drainIntervalMs is used when the loop re-arms', async () => {
  const h = harness({ hosts: [dev2] })
  h.drain.start()
  h.setStored({ drainIntervalMs: 60000 })
  await h.drain.tick()
  assert.equal(h.t.live().at(-1).ms, 60000)
})

test('an idle tick reads the heartbeat and state but saves nothing', async () => {
  const h = harness({ hosts: [laptop] })
  await h.drain.tick()
  assert.ok(h.trace.includes('get:lastDrainAt'))
  assert.ok(!h.trace.some((entry) => entry.startsWith('set:')))
})

test('a forced tick during an unforced run is queued behind it, not joined', async () => {
  const h = harness({
    hosts: [dev1, dev2],
    storageData: { drainState: { backoff: { 'devbox-2': { attempts: 1, until: 999999, kind: 'unreachable' } } } },
  })
  let release
  const gate = new Promise((resolve) => { release = resolve })
  h.answers['devbox'] = async () => { await gate; return ok() }
  const first = h.drain.tick()
  const forced = h.drain.tick({ force: true })
  await new Promise((resolve) => setImmediate(resolve))
  release()
  await Promise.all([first, forced])
  assert.deepEqual(h.runnerCalls.map((c) => c.name), ['devbox', 'devbox', 'devbox-2'])
})

test('a not-installed host is logged, never toasted, and retried with a 10 minute cap', async () => {
  const h = harness({
    hosts: [dev2],
    storageData: { drainState: { backoff: { 'devbox-2': { attempts: 9, until: 0, kind: 'not-installed' } } } },
  })
  h.answers['devbox-2'] = () => fail('not-installed', "python3: can't open file")
  await h.drain.tick()
  assert.equal(h.shown.length, 0)
  assert.ok(h.logs.some((m) => m.includes('not-installed')))
  assert.equal(h.drain.state().backoff['devbox-2'].until, 600000)
})

test('a drained notice drops the grazr prefix from its title', async () => {
  const h = harness({ hosts: [dev2] })
  h.answers['devbox-2'] = ok([line('grazr: no swap', 'nothing to do')])
  await h.drain.tick()
  assert.deepEqual(h.shown.map((s) => s.params), [{ title: 'devbox-2: no swap', body: 'nothing to do' }])
})

test('afterTick runs after every tick and its rejection is logged, not thrown', async () => {
  let calls = 0
  const h = harness({
    hosts: [dev2],
    afterTick: async () => {
      calls += 1
      h.trace.push('afterTick')
      if (calls === 2) throw new Error('panel down')
    },
  })
  h.answers['devbox-2'] = ok()
  await h.drain.tick()
  await assert.doesNotReject(h.drain.tick({ force: true }))
  await assert.doesNotReject(h.drain.tick())
  assert.equal(calls, 3)
  assert.ok(h.logs.includes('drain: afterTick failed: panel down'))
  assert.ok(h.trace.indexOf('afterTick') > h.trace.indexOf('run:devbox-2'))
})

test('a scheduled tick passes no deadline to afterTick, a forced one passes its deadline', async () => {
  const seen = []
  const h = harness({ hosts: [dev2], afterTick: async (opts) => { seen.push(opts) } })
  h.answers['devbox-2'] = ok()
  await h.drain.tick()
  await h.drain.tick({ force: true, deadline: 42000 })
  assert.equal(seen[0].deadline, undefined)
  assert.equal(seen[1].deadline, 42000)
})

test('a forced tick queued behind a run that leaves under 3 s after the kill grace drains nothing and logs it', async () => {
  const h = harness({ hosts: [dev2] })
  let release
  const gate = new Promise((resolve) => { release = resolve })
  h.answers['devbox-2'] = async () => { await gate; return ok() }
  const first = h.drain.tick()
  const forced = h.drain.tick({ force: true, deadline: 6000 })
  // The first run takes 3.5 s, so 2.5 s is left: 0.5 s once the 2 s kill grace is set aside.
  h.clock.now = 3500
  release()
  await Promise.all([first, forced])
  assert.deepEqual(h.runnerCalls.map((c) => c.name), ['devbox-2'])
  assert.equal(h.logs.filter((m) => m === 'grazr: drain skipped, no budget left').length, 1)
})

test('a forced tick queued behind a run that leaves 3 s after the kill grace still drains', async () => {
  const h = harness({ hosts: [dev2] })
  let release
  const gate = new Promise((resolve) => { release = resolve })
  h.answers['devbox-2'] = async () => { await gate; return ok() }
  const first = h.drain.tick()
  const forced = h.drain.tick({ force: true, deadline: 9000 })
  // 5.5 s left is 3.5 s usable, enough for the minimum.
  h.clock.now = 3500
  release()
  await Promise.all([first, forced])
  assert.deepEqual(h.runnerCalls.map((c) => c.name), ['devbox-2', 'devbox-2'])
  assert.equal(h.logs.some((m) => m === 'grazr: drain skipped, no budget left'), false)
  // The forced drain's host gets the usable time left, 3.5 s, not the full 10 s; the scheduled one keeps its default.
  assert.equal(h.runnerCalls[1].opts.timeoutMs, 3500)
  assert.equal(h.runnerCalls[0].opts.timeoutMs, 10000)
})
