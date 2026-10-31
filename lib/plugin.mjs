import os from 'node:os'
import * as nodeFs from 'node:fs/promises'
import { spawn as nodeSpawn } from 'node:child_process'
import { execCapture } from './exec.mjs'
import { expandTilde } from './paths.mjs'
import { createRunner } from './runner.mjs'
import { createDeploy } from './deploy.mjs'
import { createDrainLoop } from './drain.mjs'
import { createPanelRefresher } from './panel-refresh.mjs'
import { DEFAULT_SETTINGS, mergeSettings, currentTarget, hostFor, nextTarget, engineEnv, enginePath, isRemote, forceInstallFor } from './hosts.mjs'
import { toast, formatStatus, formatFailure, failureBody } from './toast.mjs'
import { join, quote } from './shell-quote.mjs'
import { describe } from './errors.mjs'
import { readBundledVersion as readBundledEngineVersion } from './engine-version.mjs'
import { createSigninJobs } from './signin.mjs'
import { createFocus } from './focus.mjs'

// Orca kills a command at 30 s; the rest of the budget covers loading settings before and publishing after.
const INSTALL_BUDGET_MS = 25000

// The engine's stable refusal for a foreign owner; its text ends with a how-to that does not name forceInstall.
const FOREIGN_OWNER_PREFIX = "Claude's status line or StopFailure hook already belongs"
const TAKEOVER_HINT = 'Set forceInstall: true for this host to take it over.'

const isObject = (v) => v !== null && typeof v === 'object'

// The account a panel's swap or enrol names, or null when the params name none.
const accountOf = (params) => (isObject(params) && typeof params.account === 'string' && params.account !== '' ? params.account : null)

// The text a toast shows, which is also the message the panel shows for the command.
const messageOf = (t) => (t.body ? `${t.title}\n${t.body}` : t.title)

// A toast for an engine line command: its lines on success, the classified failure otherwise.
const linesToast = (h, title, result) =>
  result.ok ? toast(h.name, title, result.lines.join('\n')) : formatFailure(h.name, result.failure, title)

export async function createGrazrPlugin({
  orca,
  exec = execCapture,
  spawn = nodeSpawn,
  homedir = os.homedir,
  root,
  timers = { setTimeout, clearTimeout },
  now = Date.now,
  log = (msg) => orca.log(msg),
  fs = nodeFs,
  readTemplate = () => fs.readFile(`${root}/panel/template.html`, 'utf8'),
  readBundledVersion = () => readBundledEngineVersion({ root, fs }),
}) {
  const host = (name, params) => orca.host.call(name, params)

  // A toast that cannot be shown must not fail the command that produced it.
  async function publish(t) {
    try {
      await host('notifications.show', t)
    } catch (err) {
      log(`grazr: notification failed: ${describe(err)}`)
    }
  }
  // Shows the toast and returns the command's outcome for the panel: ok, and the same text as its message.
  const say = async (ok, t) => {
    await publish(t)
    return { ok, message: messageOf(t) }
  }
  // The host a panel names must be configured; the message says so, and the command runs nowhere.
  const unknownHost = (params) => say(false, { title: `unknown host ${params.host}; refresh the panel`, body: '' })

  const storage = {
    get: async (key) => (await host('storage.get', { key }))?.value,
    set: (key, value) => host('storage.set', { key, value }),
  }

  const readSettings = async () => (await host('settings.get', {}))?.settings

  // A failed read must not fail the command: the defaults still let it run, and the log says why.
  async function loadSettings() {
    try {
      return mergeSettings(await readSettings())
    } catch (err) {
      log(`grazr: settings unavailable, using defaults: ${describe(err)}`)
      return mergeSettings(undefined)
    }
  }

  async function seedSettings(stored) {
    const object = isObject(stored) ? stored : {}
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (!(key in object)) await host('settings.set', { key, value: structuredClone(DEFAULT_SETTINGS[key]) })
    }
  }

  // Runner and deploy take settings at construction, so each command builds them from fresh settings.
  const toolsFor = (settings) => ({
    runner: createRunner({ settings, exec, homedir }),
    deploy: createDeploy({ settings, exec, homedir, root }),
  })

  // Races the work against a clock; onExpire runs first so the work can stop itself at its next step.
  function withBudget(promise, ms, onExpire) {
    let handle
    const expired = new Promise((resolve) => {
      handle = timers.setTimeout(() => {
        onExpire()
        resolve({ ok: false, failure: { kind: 'timeout', detail: `exceeded ${ms / 1000}s` } })
      }, ms)
    })
    return Promise.race([promise, expired]).finally(() => timers.clearTimeout(handle))
  }

  // Each command shows one toast, or a grazr: toast with the error message if anything throws.
  // It resolves to { ok, message } either way, so the panel can show the result and nothing rejects.
  const guard = (id, fn) => async (params) => {
    try {
      return await fn(params)
    } catch (err) {
      log(`grazr ${id}: ${describe(err)}`)
      return say(false, toast('grazr', describe(err)))
    }
  }

  async function targetNext() {
    const settings = await loadSettings()
    const { host: next, index, count } = nextTarget(settings)
    await host('settings.set', { key: 'target', value: next.name })
    return say(true, toast('grazr', `Target: ${next.name} (${index}/${count})`))
  }

  // Returns the per-host [{ host, result }] it collected, so the panel refresh that follows need not ask again,
  // and { ok, message } for the panel: the same per-host texts the toasts show.
  async function status() {
    const settings = await loadSettings()
    const { runner } = toolsFor(settings)
    // One host throwing must not lose the other hosts' toasts or the stored record.
    const statusOf = async (h) => {
      try {
        const result = await runner.runJson(h, ['status', '--json'], { timeoutMs: 10000 })
        const t = result.ok ? formatStatus(h.name, result.value) : formatFailure(h.name, result.failure, 'status')
        await publish(t)
        return { host: h, result, text: messageOf(t) }
      } catch (err) {
        const t = toast('grazr', describe(err))
        await publish(t)
        return { host: h, result: { ok: false, failure: { kind: 'error', detail: describe(err) } }, text: messageOf(t) }
      }
    }
    const collected = await Promise.all(settings.hosts.map(statusOf))
    const at = now()
    const record = Object.fromEntries(collected.map(({ host, result }) => [
      host.name,
      result.ok ? { at, ok: true, report: result.value } : { at, ok: false, failure: result.failure },
    ]))
    // The record is for the status view; a failed save must not stop the panel from the same results.
    try {
      await storage.set('lastStatus', record)
    } catch (err) {
      log(`grazr: lastStatus not saved: ${describe(err)}`)
    }
    const results = collected.map(({ host, result }) => ({ host, result }))
    return {
      results,
      outcome: { ok: results.every(({ result }) => result.ok), message: collected.map((c) => c.text).join('\n') },
    }
  }

  // The engine runs on the host the params name, or on the target when they name none.
  async function runOn(params, args, timeoutMs, title) {
    const settings = await loadSettings()
    const h = hostFor(settings, params)
    if (!h) return unknownHost(params)
    const result = await toolsFor(settings).runner.runLines(h, args, { timeoutMs })
    return say(result.ok, linesToast(h, title, result))
  }

  // With params.enabled a boolean, the rotation is set to it; otherwise it is flipped from its current state.
  async function rotationToggle(params) {
    const settings = await loadSettings()
    const h = hostFor(settings, params)
    if (!h) return unknownHost(params)
    const { runner } = toolsFor(settings)
    const wanted = isObject(params) ? params.enabled : undefined
    if (typeof wanted === 'boolean') {
      const set = await runner.runLines(h, ['set', 'ENABLED', wanted ? '1' : '0'], { timeoutMs: 10000 })
      if (!set.ok) return say(false, formatFailure(h.name, set.failure, 'rotation'))
      return say(true, toast(h.name, `rotation ${wanted ? 'on' : 'off'}`))
    }
    const current = await runner.runJson(h, ['status', '--json'], { timeoutMs: 10000 })
    if (!current.ok) return say(false, formatFailure(h.name, current.failure, 'rotation'))
    const enabled = Boolean(current.value.settings?.enabled)
    const set = await runner.runLines(h, ['set', 'ENABLED', enabled ? '0' : '1'], { timeoutMs: 10000 })
    if (!set.ok) return say(false, formatFailure(h.name, set.failure, 'rotation'))
    return say(true, toast(h.name, `rotation ${enabled ? 'off' : 'on'}`))
  }

  // The engine decides about a foreign owner or a user's own bar; the plugin only passes --force through.
  // Once the budget has expired its toast is already out, so a cancelled sequence stops before its next step.
  // Resolves to { ok, t }: whether the install worked, and the toast that says so.
  async function installSteps(settings, h, budget) {
    const { runner, deploy } = toolsFor(settings)
    const deployed = await deploy.deploy(h, { timeoutMs: 15000 })
    if (budget.cancelled) return null
    if (!deployed.ok) return { ok: false, t: formatFailure(h.name, deployed.failure, 'deploy') }
    const install = await runner.runLines(h, ['install', ...(forceInstallFor(settings, h) ? ['--force'] : [])], { timeoutMs: 8000 })
    return { ok: install.ok, t: installToast(h, install) }
  }

  // A refused install shows the engine's line in the body; a foreign owner also gets the hint to set forceInstall.
  function installToast(h, result) {
    if (result.ok || result.failure.kind !== 'engine' || !result.failure.detail.startsWith(FOREIGN_OWNER_PREFIX)) {
      return linesToast(h, 'install', result)
    }
    return toast(h.name, 'install failed', `${failureBody(result.failure)}\n${TAKEOVER_HINT}`)
  }

  async function install(params) {
    const settings = await loadSettings()
    const h = hostFor(settings, params)
    if (!h) return unknownHost(params)
    const budget = { cancelled: false }
    const outcome = await withBudget(installSteps(settings, h, budget), INSTALL_BUDGET_MS, () => { budget.cancelled = true })
    if (outcome.failure?.kind === 'timeout') {
      return say(false, toast(h.name, 'install timed out', 'install may still be finishing; run Grazr: Status (all hosts) to check'))
    }
    return say(outcome.ok, outcome.t)
  }

  async function drainNow() {
    await drain.tick({ force: true, deadline: now() + COMMAND_BUDGET_MS })
    return say(true, toast('grazr', 'drained'))
  }

  // The text is typed, not run, so the user reads it and presses Return themselves.
  function commandText(settings, h, args) {
    if (isRemote(h)) {
      const inner = toolsFor(settings).runner.command(h, args).argv.at(-1)
      return `ssh -t ${quote(h.ssh)} ${quote(inner)}`
    }
    const assignments = Object.entries(engineEnv(settings, h)).map(([k, v]) => `${k}=${quote(expandTilde(v, homedir))}`)
    const argv = [expandTilde(h.python, homedir), expandTilde(enginePath(settings), homedir), ...args]
    return [...assignments, join(argv)].join(' ')
  }

  // The panel is a view of the same hosts, so every command that changes a host ends by regenerating it.
  // The sign-in job runs after the command has returned, so it refreshes the panel itself with its own budget.
  const signin = createSigninJobs({
    exec,
    spawn,
    homedir,
    timers,
    log,
    publish,
    refreshPanel: () => refreshPanel({ deadline: now() + COMMAND_BUDGET_MS }),
    pluginRoot: root,
  })
  // The focused workspace's host: the panel polls it, and the palette shows it.
  const focus = createFocus({ exec, homedir, now, log })
  async function activeHost(params) {
    const settings = await loadSettings()
    const { ok, host } = await focus.current(settings)
    if (params !== undefined) return { ok, message: '', host }
    const t = ok
      ? toast('grazr', `Focused workspace: ${host ?? 'no configured host'}`)
      : toast('grazr', 'Focused workspace: unknown', "Orca's session could not be read; see the log")
    return { ...(await say(ok, t)), host }
  }

  const panel = createPanelRefresher({ loadSettings, toolsFor, commandText, readTemplate, readBundledVersion, root, fs, log, now })
  const refreshPanel = (options) => panel.refresh(options)
  // Orca kills a command at 30 s; the panel refresh gets what a 28 s budget leaves after the command's own work.
  const COMMAND_BUDGET_MS = 28000
  const thenPanel = (fn) => async (params) => {
    const deadline = now() + COMMAND_BUDGET_MS
    const outcome = await fn(params)
    await refreshPanel({ deadline })
    return outcome
  }
  // The status command hands its own results to the panel, so the hosts are asked once per press.
  const statusThenPanel = async () => {
    const deadline = now() + COMMAND_BUDGET_MS
    const { results, outcome } = await status()
    await refreshPanel({ results, deadline })
    return outcome
  }

  async function typeIntoTerminal(subcommand) {
    const context = await host('workspace.readContext', {})
    // The newest terminal is the last one listed; the user opens a shell right before running the command.
    const terminal = context?.terminals?.at(-1)
    if (!terminal) return say(false, toast('grazr', 'Open a shell terminal in this worktree first'))
    const settings = await loadSettings()
    const text = commandText(settings, currentTarget(settings), [subcommand])
    await host('terminal.sendText', { terminalId: terminal.id, text, enter: false })
    return say(true, toast('grazr', 'Typed into the newest terminal of this worktree', 'Open a shell right before running this if it landed in an agent pane.'))
  }

  // The panel's enrol starts a sign-in on the card's host: the browser opens now, the outcome comes later as a toast.
  async function startSignin(params) {
    const settings = await loadSettings()
    const h = hostFor(settings, params)
    if (!h) return unknownHost(params)
    return signin.start({ host: h, settings, account: accountOf(params) })
  }

  const titles = {
    written: 'panel updated',
    unchanged: 'panel unchanged',
    skipped: 'panel not writable (installed plugin)',
    failed: 'panel refresh failed',
    'no-budget': 'panel refresh skipped, no budget left',
  }
  // From the palette the outcome is a notification; from the panel it is only the card's message, so the page's
  // wake-up on an old page raises no notification.
  async function panelRefresh(params) {
    const outcome = await refreshPanel({ deadline: now() + COMMAND_BUDGET_MS })
    const ok = outcome === 'written' || outcome === 'unchanged'
    if (params === undefined) return say(ok, toast('grazr', titles[outcome]))
    return { ok, message: messageOf(toast('grazr', titles[outcome])) }
  }

  // Each handler takes the panel's params (or undefined from the palette) and resolves to { ok, message }.
  const commands = {
    'target-next': thenPanel(targetNext),
    status: statusThenPanel,
    swap: thenPanel((params) => {
      const account = accountOf(params)
      return runOn(params, account ? ['swap', account] : ['swap'], 15000, 'swap')
    }),
    refresh: thenPanel((params) => runOn(params, ['refresh'], 20000, 'refresh')),
    'rotation-toggle': thenPanel(rotationToggle),
    install: thenPanel(install),
    uninstall: thenPanel((params) => runOn(params, ['uninstall'], 8000, 'uninstall')),
    'drain-now': drainNow,
    // Only the palette calls enrol with no params (undefined); a panel call, even an empty object, starts a sign-in on its host.
    enrol: (params) => (params === undefined ? typeIntoTerminal('enrol') : startSignin(params)),
    'status-terminal': () => typeIntoTerminal('status'),
    'panel-refresh': panelRefresh,
    'active-host': activeHost,
  }

  // Events only wake the drain loop; the first one of each kind is logged so the trigger is visible.
  const logged = new Set()
  const onEvent = (name) => async () => {
    const settings = await loadSettings()
    if (!settings.drainEnabled) {
      if (!logged.has(`${name}:off`)) {
        logged.add(`${name}:off`)
        log(`grazr: ${name} does not start the drain loop, drainEnabled is false`)
      }
      return
    }
    drain.start()
    if (!logged.has(name)) {
      logged.add(name)
      log(`grazr: ${name} starts the drain loop`)
    }
  }

  // Activation must survive a failed settings read or seed: a rejection here means no command ever registers.
  let stored
  try {
    stored = await readSettings()
    const empty = !isObject(stored) || Object.keys(stored).length === 0
    if (empty && (await storage.get('seeded'))) {
      // A file emptied after seeding is a broken edit, so the defaults stand in and nothing is written over it.
      const message = 'settings.json is empty or unreadable; using defaults until it is fixed'
      log(`grazr: ${message}`)
      await publish(toast('grazr', message))
      stored = undefined
    } else {
      await seedSettings(stored)
      await storage.set('seeded', true)
    }
  } catch (err) {
    log(`grazr: settings unavailable at activation, using defaults: ${describe(err)}`)
  }
  const settings = mergeSettings(stored)

  // The drain loop re-reads settings on every tick, so edits take effect without a restart.
  const drain = createDrainLoop({
    loadSettings,
    runnerFor: (fresh) => createRunner({ settings: fresh, exec, homedir }),
    host,
    log,
    timers,
    now,
    storage,
    afterTick: refreshPanel,
  })

  const guarded = Object.fromEntries(Object.entries(commands).map(([id, fn]) => [id, guard(id, fn)]))
  for (const [id, handler] of Object.entries(guarded)) {
    orca.commands.register(id, (args) => handler(args))
  }
  orca.events.on('agent.status.changed', onEvent('agent.status.changed'))
  orca.events.on('workspace.created', onEvent('workspace.created'))

  if (settings.drainEnabled) drain.start()
  // The panel is regenerated at activation too; the promise never rejects, so nothing waits on it.
  void refreshPanel()

  return {
    commands: guarded,
    drain,
    loadSettings,
    deactivate: () => drain.stop(),
  }
}
