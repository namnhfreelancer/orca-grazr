import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createGrazrPlugin } from '../../lib/plugin.mjs'
import { FIXTURE_HOSTS } from './fixture-hosts.mjs'

// Shared fakes for the plugin worker tests: a host recorder, an in-memory fs, a scripted exec and a plugin factory.
export const ROOT = resolve(import.meta.dirname, '../..')
export const PLUGIN_ROOT = '/plug'
export const PANEL = `${PLUGIN_ROOT}/panel/accounts.html`
export const TEMPLATE = '<main><!--__CARDS__--></main><script>const D = /*__DATA__*/;</script>'

// Records host calls and answers them from a small table; the settings object is live so set() sticks.
// flags.rejectSettingsGet makes settings.get reject, and can be flipped after activation.
export function fakeOrca({ stored = {}, context = null, flags = {}, storage = {} } = {}) {
  const state = { settings: structuredClone(stored), storage: structuredClone(storage) }
  const commands = new Map()
  const handlers = new Map()
  const panelHandlers = new Map()
  const calls = []
  const logs = []
  const orca = {
    commands: { register: (id, fn) => commands.set(id, fn) },
    events: { on: (name, fn) => handlers.set(name, fn) },
    // Orca 1.4.246+ offers panels.handle; flags.noPanels is an older host without it.
    ...(flags.noPanels ? {} : { panels: { handle: (name, fn) => panelHandlers.set(name, fn) } }),
    host: {
      call: async (name, params) => {
        calls.push({ name, params })
        switch (name) {
          case 'settings.get':
            if (flags.rejectSettingsGet) throw new Error('settings host unavailable')
            return { settings: state.settings }
          case 'settings.set': state.settings[params.key] = params.value; return { ok: true }
          case 'storage.get': return { value: state.storage[params.key] }
          case 'storage.set':
            if (flags.rejectStorageSet && params.key === 'lastStatus') throw new Error('storage full')
            state.storage[params.key] = params.value
            return { ok: true }
          case 'workspace.readContext': return context
          case 'terminal.sendText': return { delivered: true }
          default: return { ok: true }
        }
      },
    },
    log: (msg) => logs.push(msg),
  }
  return { orca, commands, handlers, panelHandlers, calls, logs, state, flags }
}

// Timers are inert: a scheduled callback is recorded but never fires on its own.
export function fakeTimers() {
  const armed = []
  return {
    armed,
    setTimeout: (fn, ms) => { const t = { fn, ms }; armed.push(t); return t },
    clearTimeout: () => {},
  }
}

// An in-memory fs: the template is present unless noTemplate, writes go through a temp file, and write or rename can name a code to throw.
// dev: whether the plugin root is a development checkout, which holds a .git entry; an installed copy does not.
export function fakeFs({ write = null, rename = null, noTemplate = false, dev = true } = {}) {
  const files = new Map(noTemplate ? [] : [[`${PLUGIN_ROOT}/panel/template.html`, TEMPLATE]])
  const renames = []
  const fail = (code) => {
    const error = new Error(code)
    error.code = code
    throw error
  }
  return {
    files,
    renames,
    async stat(path) {
      if (dev && path === `${PLUGIN_ROOT}/.git`) return { isFile: () => false }
      fail('ENOENT')
    },
    async readFile(path) {
      if (files.has(path)) return files.get(path)
      fail('ENOENT')
    },
    async mkdir() {},
    async mkdtemp(prefix) { return `${prefix}abc123` },
    async rm() {},
    async writeFile(path, data) {
      if (write) fail(write)
      files.set(path, data)
    },
    async rename(from, to) {
      if (rename) fail(rename)
      files.set(to, files.get(from))
      files.delete(from)
      renames.push(to)
    },
    async unlink(path) {
      files.delete(path)
    },
  }
}

// Every exec call is recorded; the route decides the result and may throw.
export function fakeExec(route = () => ({})) {
  const execs = []
  const exec = async (argv, opts = {}) => {
    execs.push(argv)
    const next = (await route(argv, opts)) ?? {}
    return { argv, code: 0, signal: null, stdout: '', stderr: '', timedOut: false, spawnError: null, timeoutMs: opts.timeoutMs, ...next }
  }
  return { exec, execs }
}

// The engine subcommand an argv runs, locally or over ssh; null for deploy steps.
export function engineCommand(argv) {
  if (argv[0] === 'python3') return argv.slice(2).join(' ')
  const remote = argv.at(-1)
  const marker = 'grazr.py '
  return remote.includes(marker) ? remote.slice(remote.indexOf(marker) + marker.length) : null
}

export const label = (argv) => {
  if (argv[0] === '/bin/mkdir') return 'mkdir'
  if (argv[0] === '/usr/bin/rsync') return 'rsync'
  return engineCommand(argv)
}

// Answers engine subcommands from a table; anything unlisted succeeds silently.
export const engine = (table) => (argv) => {
  const cmd = engineCommand(argv)
  if (cmd === null) return {}
  const answer = table[cmd]
  return typeof answer === 'function' ? answer(argv) : answer ?? {}
}

export const report = (extra = {}) => ({
  active: { name: 'work', id: 'a1' },
  settings: { enabled: true },
  accounts: [{ name: 'work', id: 'a1', snapshot: [{ kind: 'session', scope: null, group: 'session', remaining: 40 }] }],
  connection: { foreign: {} },
  ...extra,
})

export const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

// Activation starts a panel refresh; it is settled here and its execs moved to fake.activation,
// so each test counts only the execs of the command it runs.
// Login children: a fake claude that never exits on its own, so a background sign-in stays pending unless a test ends it.
export function fakeSpawn() {
  const spawns = []
  const spawn = (file, args, opts) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = new EventEmitter()
    child.killed = []
    child.kill = (signal) => { child.killed.push(signal) }
    spawns.push({ file, args, opts, child })
    return child
  }
  return { spawn, spawns }
}

export async function start({ stored = null, storage = {}, context = null, route = () => ({}), timers = fakeTimers(), now = () => 1000, rejectSettingsGet = false, rejectStorageSet = false, noPanels = false, fs = fakeFs(), tmpdir = "/tmpdir", spawned = fakeSpawn() } = {}) {
  // No stored settings gets the three-host fixture; a settings file that names keys keeps them and gets the fixture hosts
  // unless it names its own; an explicit empty file ({}) stays empty, so the defaults apply.
  // These tests drive the engine mode; the Orca accounts mode has its own tests.
  const withHosts = stored === null ? { mode: 'engine', hosts: FIXTURE_HOSTS } : Object.keys(stored).length ? { mode: 'engine', hosts: FIXTURE_HOSTS, ...stored } : stored
  const fake = fakeOrca({ stored: withHosts, context, storage, flags: { rejectSettingsGet, rejectStorageSet, noPanels } })
  const ex = fakeExec(route)
  const plugin = await createGrazrPlugin({
    orca: fake.orca,
    exec: ex.exec,
    homedir: () => '/home/t',
    root: PLUGIN_ROOT,
    tmpdir,
    fs,
    timers,
    now,
    spawn: spawned.spawn,
    log: (msg) => fake.logs.push(msg),
  })
  await settle()
  const activation = ex.execs.splice(0)
  const run = (id) => plugin.commands[id]()
  return { ...fake, ...ex, plugin, timers, run, fs, activation, spawns: spawned.spawns }
}

export const statusRoute = (extra = {}) => engine({ 'status --json': { stdout: JSON.stringify(report()) }, ...extra })
export const statusExecs = (fake) => fake.execs.filter((a) => label(a) === 'status --json').length
// The engine commands a test ran, without the panel refresh that the command's trigger adds after it.
export const commandLabels = (fake) => fake.execs.map(label).filter((l) => l !== null && l !== 'status --json')

export const toasts = (fake) => fake.calls.filter((c) => c.name === 'notifications.show').map((c) => c.params)
export const hostCalls = (fake, name) => fake.calls.filter((c) => c.name === name).map((c) => c.params)
