import { buildPanelData } from './panel-data.mjs'
import { renderPanel, writePanel, embeddedData } from './panel.mjs'
import { describe } from './errors.mjs'
import { MIN_BUDGET_MS, usableMs } from './budget.mjs'

const STATUS_TIMEOUT_MS = 10000
// The values in the page that change without the data changing; comparisons drop them.
// generatedAt changes on every render; the header's "updated HH:MM" moves with the minute, and a page
// rewritten for that alone would reload the open panel and reset its toggles.
const GENERATED_AT = /"generatedAt":"[^"]*"/g
const UPDATED_AT = / · updated \d{2}:\d{2}/g
// The active account's reading time moves on every status-line reading; the page then reads as changed only when a value shown changes.
const UPDATED_MS = /"updated":(?:null|-?[\d.eE+-]+)/g
// The list face's reading lines carry the same time as data-updated attributes.
const DATA_UPDATED = / data-updated="[^"]*"/g
const volatile = (html) => html.replace(GENERATED_AT, '').replace(UPDATED_AT, '').replace(UPDATED_MS, '').replace(DATA_UPDATED, '')
// In a development folder every write of the page makes Orca reload the plugin: the panel flashes and the worker
// restarts. A page that differs only in its numbers (a percentage, a reset time) is therefore rewritten at most once
// per NUMBERS_REWRITE_MS; anything else (active account, next, states, chips, the selected host) is written at once.
// An open page gets its numbers in place meanwhile, through the panel-live handler (see latest()).
export const NUMBERS_REWRITE_MS = 30 * 60000
const withoutNumbers = (html) => volatile(html).replace(/\d+/g, '#')

// Builds the accounts panel from a status run on every host, then writes it only when the data changed.
// Refreshes run one after another, so a tick, a command and the activation never overlap.
// It never rejects: a refresh that fails is logged and reported as 'failed', so the command that asked still toasts.
export function createPanelRefresher({ loadSettings, toolsFor, commandText, readTemplate, readBundledVersion, root, fs, log, now }) {
  // The data a location refused, so unchanged data is neither re-rendered, logged nor retried; a change clears it.
  let skippedKey = null
  // The last successful status of each host, by name, with the time it was read. A host that a short budget
  // cut off keeps this reading and its time, so the card does not claim a stale reading is current.
  const lastGood = new Map()
  // The bundled engine version is read once; a read that fails is logged once and counts as unknown (null).
  let bundledRead = null
  // The host the panel selects when the worker, not the target setting, says which one (the focused workspace's).
  // Set by a refresh that names one, cleared by a refresh that names null; it is never written to the settings.
  let renderTarget = null
  let chain = Promise.resolve()
  // The last page rendered, written or not, with the data its script reads: what an open page updates itself from.
  let latest = null

  function bundledVersion() {
    if (!bundledRead) {
      bundledRead = Promise.resolve()
        .then(() => readBundledVersion?.())
        .then((version) => version ?? null, (err) => {
          log(`grazr: engine version unknown: ${describe(err)}`)
          return null
        })
    }
    return bundledRead
  }

  // A host that throws becomes a failed result, so one bad host never blanks the rest of the panel.
  async function statusOf(runner, h, timeoutMs) {
    try {
      return { host: h, result: await runner.runJson(h, ['status', '--json'], { timeoutMs }) }
    } catch (err) {
      return { host: h, result: { ok: false, failure: { kind: 'error', detail: describe(err) } } }
    }
  }

  // Each button types the command its host would run, so the swap to an account is built from the same settings.
  function commandsFor(settings, h, result) {
    const cmd = {
      refresh: commandText(settings, h, ['refresh']),
      enrol: commandText(settings, h, ['enrol']),
      swap: commandText(settings, h, ['swap']),
      rotationOn: commandText(settings, h, ['set', 'ENABLED', '1']),
      rotationOff: commandText(settings, h, ['set', 'ENABLED', '0']),
      swapTo: {},
    }
    if (result.ok && Array.isArray(result.value?.accounts)) {
      for (const account of result.value.accounts) {
        if (typeof account?.name === 'string') cmd.swapTo[account.name] = commandText(settings, h, ['swap', account.name])
      }
    }
    return cmd
  }

  // A host that timed out under a budget shorter than the normal 10 s was cut off, not down, so it keeps its last reading.
  // A timeout at the full 10 s is a real one, and so is a timeout with no earlier reading.
  function keepOnTimeout(hosts, timeoutMs) {
    if (timeoutMs >= STATUS_TIMEOUT_MS) return hosts
    return hosts.map((entry) => {
      const timedOut = !entry.result.ok && entry.result.failure?.kind === 'timeout'
      return timedOut && lastGood.has(entry.host.name) ? { host: entry.host, ...lastGood.get(entry.host.name) } : entry
    })
  }

  // The panel data and buttons minus the timestamps, so only a change in what the page shows counts.
  function keyOf(data, commands, template) {
    const hosts = data.hosts.map(({ updatedAt, clock, list, ...host }) => ({
      ...host,
      clock: clock && { ...clock, accounts: clock.accounts.map(({ updated, ...account }) => account) },
      list: list && { ...list, accounts: list.accounts.map(({ updated, ...account }) => account) },
    }))
    return JSON.stringify({ target: data.target, face: data.face, view: data.view, hosts, commands, template })
  }

  // The page on disk decides whether a write is needed, on every refresh: a page edited or reset by hand is rewritten.
  async function sameAsOnDisk(html) {
    try {
      const current = await fs.readFile(`${root}/panel/accounts.html`, 'utf8')
      return volatile(current) === volatile(html)
    } catch {
      return false
    }
  }

  // Whether the page on disk differs from html only in numbers and was written less than NUMBERS_REWRITE_MS ago.
  // Read from the file itself, since each write restarts the worker and any memory of the last write with it.
  async function onlyNumbersMovedRecently(html) {
    try {
      const file = `${root}/panel/accounts.html`
      const current = await fs.readFile(file, 'utf8')
      if (withoutNumbers(current) !== withoutNumbers(html)) return false
      return now() - (await fs.stat(file)).mtimeMs < NUMBERS_REWRITE_MS
    } catch {
      return false
    }
  }

  // results: the [{ host, result }] a status command already collected; without them every host is asked.
  // deadline: epoch ms by which the command must finish; the status runs are cut to the time left.
  // target: the host name to select in the page, or null to go back to the target setting; left out, the last one holds.
  // fresh: a person asked (a palette command), so new numbers are written at once too.
  async function refreshOnce({ results, deadline, target, fresh = false } = {}) {
    if (target !== undefined) renderTarget = target
    try {
      const template = await readTemplate()
      const loaded = await loadSettings()
      const settings = renderTarget ? { ...loaded, target: renderTarget } : loaded
      let hosts = results
      if (!hosts) {
        // The kill grace comes off the time left, so a run cut to that time is killed before the deadline.
        const budget = deadline === undefined ? STATUS_TIMEOUT_MS : usableMs(deadline - now())
        if (budget < MIN_BUDGET_MS) {
          log('grazr: panel refresh skipped, no budget left')
          return 'no-budget'
        }
        const { runner } = toolsFor(settings)
        const timeoutMs = Math.min(STATUS_TIMEOUT_MS, budget)
        hosts = keepOnTimeout(await Promise.all(settings.hosts.map((h) => statusOf(runner, h, timeoutMs))), timeoutMs)
      }
      // A reading without a time was taken just now; a kept one already carries the time it was read.
      hosts = hosts.map((entry) => (entry.readAt ? entry : { ...entry, readAt: new Date(now()) }))
      for (const { host, result, readAt } of hosts) {
        if (result.ok) lastGood.set(host.name, { result, readAt })
      }
      const commands = Object.fromEntries(hosts.map(({ host, result }) => [host.name, commandsFor(settings, host, result)]))
      const data = buildPanelData({ settings, hosts, now: new Date(now()), bundledVersion: await bundledVersion() })
      const key = keyOf(data, commands, template)
      if (key === skippedKey) return 'skipped'
      const html = renderPanel(data, { template, commands })
      latest = { html, data: embeddedData(data) }
      if (await sameAsOnDisk(html)) return 'unchanged'
      if (!fresh && (await onlyNumbersMovedRecently(html))) return 'unchanged'
      let outcome
      try {
        outcome = await writePanel({ root, html, fs })
      } catch (err) {
        log(`grazr: panel write failed: ${describe(err)}`)
        return 'failed'
      }
      if (outcome === 'skipped') {
        skippedKey = key
        log('grazr: panel skipped, the plugin folder is not a development checkout or is not writable')
        return 'skipped'
      }
      skippedKey = null
      log(`grazr: panel ${outcome}`)
      return outcome
    } catch (err) {
      log(`grazr: panel refresh failed: ${describe(err)}`)
      return 'failed'
    }
  }

  // Each call waits for the one before it; refreshOnce never rejects, so the chain never breaks.
  function refresh(options) {
    const run = chain.then(() => refreshOnce(options))
    chain = run.catch(() => {})
    return run
  }

  return { refresh, latest: () => latest }
}
