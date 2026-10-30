import { toast, formatFailure } from './toast.mjs'
import { describe } from './errors.mjs'
import { DEFAULT_SETTINGS } from './hosts.mjs'
import { hasBudget, usableMs } from './budget.mjs'

const MAX_IN_FLIGHT = 3
const MAX_BACKOFF_MS = 3600000
// A host without the engine yet is retried sooner than a dead one, so it picks up grazr soon after install.
const NOT_INSTALLED_BACKOFF_MS = 600000
const DRAIN_TIMEOUT_MS = 10000

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

const queueHosts = (settings) =>
  settings.hosts.filter((h) => (h.notifier || '').split(',').map((s) => s.trim()).includes('queue'))

function parseNotice(text) {
  try {
    const value = JSON.parse(text)
    return isPlainObject(value) ? value : null
  } catch {
    return null
  }
}

// The engine prefixes its notice titles with "grazr: ", which the toast already names.
const noticeTitle = (title) => (title ?? '').replace(/^grazr: /, '')

// A tiny pool: `limit` lanes pull from a shared cursor until every item has been worked.
async function pool(items, limit, work) {
  let next = 0
  const lane = async () => {
    while (next < items.length) await work(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => lane()))
}

export function createDrainLoop({ loadSettings, runnerFor, host, log = () => {}, timers = { setTimeout, clearTimeout }, now = Date.now, storage, afterTick }) {
  let running = false
  let handle = null
  let state = { backoff: {}, lastDrainAt: undefined }
  let loaded = null
  let inFlight = null
  let queued = null
  // Re-read on every tick; the first arm, before any read, uses the default.
  let intervalMs = DEFAULT_SETTINGS.drainIntervalMs

  const note = (msg) => log(msg)

  function arm() {
    timers.clearTimeout(handle)
    handle = null
    if (running) handle = timers.setTimeout(() => { handle = null; return tick() }, intervalMs)
  }

  // Seeds backoff across worker restarts; a failed read leaves the in-memory state empty.
  function load() {
    loaded ??= (async () => {
      try {
        const stored = await storage.get('drainState')
        if (isPlainObject(stored)) {
          state = { backoff: isPlainObject(stored.backoff) ? stored.backoff : {}, lastDrainAt: stored.lastDrainAt }
        }
      } catch (err) {
        note(`drain: could not load state: ${describe(err)}`)
      }
    })()
    return loaded
  }

  async function show(params) {
    try {
      await host('notifications.show', params)
    } catch (err) {
      note(`drain: notification failed: ${describe(err)}`)
    }
  }

  async function deliver(h, lines, settings) {
    const notices = []
    for (const text of lines) {
      const notice = parseNotice(text)
      if (notice) notices.push(notice)
      else note(`drain ${h.name}: skipped unparsable line`)
    }
    const max = settings.maxToastsPerHostPerCycle
    for (const n of notices.slice(0, max)) await show(toast(h.name, noticeTitle(n.title), n.body))
    if (notices.length > max) await show(toast(h.name, `+${notices.length - max} more notices`, ''))
    delete state.backoff[h.name]
    state.lastDrainAt = now()
  }

  // The first failure of an outage toasts; later ones only back off further, so a dead host stays quiet.
  // A host without grazr yet is logged only, since that is expected until its install.
  async function fail(h, failure, settings) {
    const attempts = (state.backoff[h.name]?.attempts ?? 0) + 1
    const cap = failure.kind === 'not-installed' ? NOT_INSTALLED_BACKOFF_MS : MAX_BACKOFF_MS
    const delay = Math.min(settings.drainIntervalMs * 2 ** attempts, cap)
    state.backoff[h.name] = { attempts, until: now() + delay, kind: failure.kind }
    note(`drain ${h.name}: ${failure.kind} ${failure.detail}`)
    if (attempts === 1 && failure.kind !== 'not-installed') await show(formatFailure(h.name, failure, 'drain'))
  }

  // Isolated per host: one host's throw must not reject the pool and skip the other lanes or the save.
  async function drainHost(h, ctx) {
    try {
      const result = await ctx.runner.runLines(h, ['notices-drain'], { timeoutMs: ctx.drainTimeoutMs })
      if (result.ok) return await deliver(h, result.lines, ctx.settings)
      return await fail(h, result.failure ?? { kind: 'unknown', detail: '' }, ctx.settings)
    } catch (err) {
      return fail(h, { kind: 'error', detail: describe(err) }, ctx.settings)
    }
  }

  const inBackoff = (name) => {
    const until = state.backoff[name]?.until
    return until !== undefined && until > now()
  }

  async function run(force, deadline) {
    try {
      // The heartbeat keeps the worker alive; its value is irrelevant.
      try {
        await storage.get('lastDrainAt')
      } catch (err) {
        note(`drain: heartbeat failed: ${describe(err)}`)
      }
      await load()
      const settings = await loadSettings()
      intervalMs = settings.drainIntervalMs
      // A forced tick's hosts get no more than the usable time left (its deadline less the kill grace); a scheduled tick keeps the default.
      const drainTimeoutMs = deadline === undefined ? DRAIN_TIMEOUT_MS : Math.min(DRAIN_TIMEOUT_MS, usableMs(deadline - now()))
      const ctx = { settings, runner: runnerFor(settings), drainTimeoutMs }
      const before = JSON.stringify(state)
      // A forced tick can queue behind a run that spent the command's budget, so its time left is read when it starts.
      // With too little left after the kill grace, the drain is skipped; the scheduled tick has no deadline and always drains.
      const drainable = deadline === undefined || hasBudget(deadline - now())
      if (!drainable) note('grazr: drain skipped, no budget left')
      const due = drainable ? queueHosts(settings).filter((h) => force || !inBackoff(h.name)) : []
      await pool(due, MAX_IN_FLIGHT, (h) => drainHost(h, ctx))
      // Saved only when something changed, so an idle tick adds nothing to the shared audit log.
      if (JSON.stringify(state) !== before) {
        try {
          await storage.set('drainState', structuredClone(state))
        } catch (err) {
          note(`drain: could not save state: ${describe(err)}`)
        }
      }
      // A failing hook is logged; the tick it follows has already done its work.
      try {
        // A forced tick is a command, so its deadline travels with it; a scheduled tick has none.
        await afterTick?.({ deadline })
      } catch (err) {
        note(`drain: afterTick failed: ${describe(err)}`)
      }
    } catch (err) {
      note(`drain: tick failed: ${describe(err)}`)
    } finally {
      arm()
    }
  }

  // A forced tick cannot join an unforced run in flight, so it queues one run after it.
  function tick({ force = false, deadline } = {}) {
    if (!inFlight) {
      inFlight = run(force, deadline).finally(() => { inFlight = null })
      return inFlight
    }
    if (!force) return inFlight
    queued ??= inFlight.then(() => { queued = null; return tick({ force: true, deadline }) })
    return queued
  }

  return {
    start() {
      if (running) return
      running = true
      void load()
      arm()
    },
    stop() {
      running = false
      timers.clearTimeout(handle)
      handle = null
    },
    tick,
    isRunning: () => running,
    state: () => structuredClone(state),
  }
}
