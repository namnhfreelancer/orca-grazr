import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createSigninJobs, LOGIN_TIMEOUT_MS, URL_TIMEOUT_MS } from '../../lib/signin.mjs'
import { fixtureSettings } from './fixture-hosts.mjs'

export const SETTINGS = fixtureSettings({})
export const MAC = SETTINGS.hosts.find((h) => h.name === 'mac')
export const DEV = SETTINGS.hosts.find((h) => h.name === 'devbox')
export const SSH = SETTINGS.sshBin
export const ORCA = SETTINGS.orcaBin
export const URL = 'https://claude.com/cai/oauth/authorize?code=1&state=s'
export const VISIT = `Opening browser to sign in…\nIf the browser didn't open, visit: ${URL}\n`
// The printed output of claude's manual flow, exactly as it arrives without a tty: the prompt has no newline.
export const CALLBACK = 'https://platform.claude.com/oauth/code/callback?code=abc123&state=s'
export const PROMPT = 'Paste code here if prompted > '
export const MANUAL_OUTPUT = `${VISIT}${PROMPT}`
export const EXPORT = { identity: { emailAddress: 'a@example.com' }, blob: { claudeAiOauth: { accessToken: 'sk-secret-blob' } } }
export const EXPORT_LINE = `${JSON.stringify(EXPORT)}\n`
export const OK_ENROL = '{"ok":true,"email":"a@example.com","unblocked":true}\n'
export const NOW = new Date(2026, 9, 31, 14, 5)
export const STAMP = '2026-10-31 14:05'
export const D1 = '/var/folders/t/tmp.1'
export const D2 = '/var/folders/t/tmp.2'
export const NO_WORKSPACE = 'Sign-in needs a local project in Orca: add any folder on this Mac as a project (Orca › Add project), then click again'
export const PID = 4242
// The one local worktree of these tests, as `orca worktree list --json` lists it on this Mac.
export const LOCAL_WORKTREE = { id: 'fc5fe73b-5b54-4ddc-bb50-4c3384c16071::/home/t/grazr', path: '/home/t/grazr', displayName: 'main', repo: { displayName: 'account-autoswitch' } }
export const WORKSPACE = `id:${LOCAL_WORKTREE.id}`

// Orca prints pretty-printed JSON, so the fakes do too; singleLine() is the one-line form the engine uses.
export const json = (value) => JSON.stringify(value, null, 2)
export const singleLine = (value) => JSON.stringify(value)
// The suffix every fresh label gets in these tests, so their labels are known.
export const SUFFIX = 'ab12'
export const LABEL = `grazr · new account ${STAMP} ${SUFFIX}`

// What an argv runs: the remote shell line over ssh, the engine or Orca arguments locally.
export function describeArgv(argv, settings) {
  if (argv[0] === settings.sshBin) return { bin: argv[0], where: argv.at(-2), line: argv.at(-1), args: null }
  if (argv[0] === settings.orcaBin) return { bin: argv[0], where: 'orca', line: argv.slice(1).join(' '), args: argv.slice(1) }
  return { bin: argv[0], where: 'local', line: argv.slice(1).join(' '), args: argv.slice(1) }
}

export const argAfter = (call, flag) => call.args[call.args.indexOf(flag) + 1]

// A fake world: exec answers by what a call runs, spawn makes children the test drives, Orca keeps profiles.
export function harness({ settings = SETTINGS, overrides = {}, spawnThrows = null, loginTimeoutMs, urlTimeoutMs, suffix = () => SUFFIX, nowMs = null, pluginRoot = null } = {}) {
  // The clock the jobs read: fixed unless a test moves nowMs.
  const clockNow = { ms: nowMs }
  const calls = []
  // The sign-in tab: open until a test closes it. A second click only switches to an open tab.
  const tab = { open: true }
  // The sign-in tab's accessibility snapshot, as `orca snapshot` prints it. A test sets screen.snapshot for each page.
  const screen = { snapshot: '' }
  const spawns = []
  const published = []
  const logs = []
  const profiles = []
  const clock = fakeClock()
  let refreshes = 0
  let dirs = 0
  let pages = 0
  let made = 0
  const routes = {
    'mktemp -d': () => ({ stdout: `/var/folders/t/tmp.${++dirs}\n` }),
    'login-export': () => ({ stdout: EXPORT_LINE }),
    'enrol --from': () => ({ stdout: OK_ENROL }),
    'enrol --stdin': () => ({ stdout: OK_ENROL }),
    'login-discard': () => ({}),
    'tab profile list': () => ({ stdout: json({ ok: true, result: { profiles } }) }),
    'tab profile create': (c) => {
      profiles.push({ id: `p${++made}`, label: argAfter(c, '--label') })
      return { stdout: json({ ok: true, result: {} }) }
    },
    'tab profile delete': (c) => {
      const i = profiles.findIndex((p) => p.id === argAfter(c, '--profile'))
      if (i >= 0) profiles.splice(i, 1)
      return { stdout: json({ ok: true, result: {} }) }
    },
    'tab create': () => ({ stdout: json({ ok: true, result: { browserPageId: `page-${++pages}` } }) }),
    'tab close': () => ({ stdout: json({ ok: true, result: {} }) }),
    'tab list': () => ({ stdout: json({ ok: true, result: { tabs: [] } }) }),
    'kill -KILL': () => ({}),
    // The local Orca worktrees: one project, the plugin's own folder.
    'worktree list': () => ({ stdout: json({ ok: true, result: { worktrees: [LOCAL_WORKTREE] } }) }),
    // The tab's address; a test answers with the callback once the user has approved.
    'tab show': () => (tab.open ? { stdout: json({ ok: true, result: { tab: { url: URL } } }) } : { code: 1, stdout: json({ ok: false, error: { message: 'no such tab' } }) }),
    // Focusing the tab and steering it back to the authorize page both succeed unless a test says otherwise.
    'tab switch': () => ({ stdout: json({ ok: true, result: {} }) }),
    'goto': () => ({ stdout: json({ ok: true, result: {} }) }),
    // The sign-in steps: the snapshot the page shows, and fill or click answers ok unless a test says otherwise.
    'snapshot': () => ({ stdout: json({ ok: true, result: { snapshot: screen.snapshot } }) }),
    'fill': () => ({ stdout: json({ ok: true, result: {} }) }),
    'click': () => ({ stdout: json({ ok: true, result: {} }) }),
  }
  const exec = async (argv, opts = {}) => {
    const call = { ...describeArgv(argv, settings), timeoutMs: opts.timeoutMs, input: opts.input }
    calls.push(call)
    const key = Object.keys(routes).find((k) => call.line.includes(k))
    const answer = key === undefined ? {} : await (overrides[key] ? overrides[key](call) : routes[key](call))
    return { argv, code: 0, signal: null, stdout: '', stderr: '', timedOut: false, spawnError: null, timeoutMs: opts.timeoutMs, ...answer }
  }
  const spawn = (file, args) => {
    if (spawnThrows) throw spawnThrows
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = new EventEmitter()
    child.stdin.destroy = () => { child.stdin.destroyed = true }
    // What the login was sent on its stdin: the relayed code, never anything else in these tests.
    child.stdin.written = []
    child.stdin.write = (value) => { child.stdin.written.push(value) }
    child.signals = []
    child.kill = (signal) => { child.signals.push(signal) }
    child.emitUrl = () => child.stdout.emit('data', Buffer.from(VISIT))
    // The remote shell's first line: its pid, with a CRLF as a pty gives it.
    child.emitPid = (pid = PID) => child.stdout.emit('data', Buffer.from(`grazr-pid:${pid}\r\n`))
    // The same address printed without its newline, on stdout or stderr.
    child.emitUrlBare = (where = 'stdout') => child[where].emit('data', Buffer.from(VISIT.trimEnd()))
    child.exit = (code, stderr = '', signal = null) => {
      if (stderr) child.stderr.emit('data', Buffer.from(stderr))
      child.emit('close', code, signal)
    }
    spawns.push({ file, args, child })
    return child
  }
  const jobs = createSigninJobs({
    exec,
    spawn,
    homedir: () => '/home/t',
    timers: clock,
    log: (m) => logs.push(m),
    publish: async (t) => { published.push(t) },
    refreshPanel: async () => { refreshes++ },
    now: () => (clockNow.ms === null ? NOW : new Date(clockNow.ms)),
    suffix,
    pluginRoot,
    loginTimeoutMs: loginTimeoutMs ?? LOGIN_TIMEOUT_MS,
    urlTimeoutMs: urlTimeoutMs ?? URL_TIMEOUT_MS,
  })
  return { jobs, calls, spawns, published, logs, profiles, clock, clockNow, screen, closeTab: () => { tab.open = false }, get refreshes() { return refreshes } }
}

// Timers are recorded, never fired by themselves; a test fires the one it means.
export function fakeClock() {
  const armed = []
  return {
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false, fired: false }; armed.push(t); return t },
    clearTimeout: (t) => { if (t) t.cleared = true },
    count: (ms) => armed.filter((a) => a.ms === ms).length,
    hasTimer: (ms) => armed.some((a) => a.ms === ms && !a.cleared && !a.fired),
    fire: (ms) => {
      const t = armed.find((a) => a.ms === ms && !a.cleared && !a.fired)
      assert.ok(t, `no live timer of ${ms} ms`)
      t.fired = true
      t.fn()
    },
  }
}

export async function until(pred) {
  for (let i = 0; i < 400; i++) {
    if (pred()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('condition not met')
}

export const callsWith = (h, text) => h.calls.filter((c) => c.line.includes(text))
export const discardsOf = (h, dir) => callsWith(h, `login-discard --from ${dir}`)
// Every tab and profile call on this Mac: none may name an environment, since they run on the local runtime.
export const tabCallsOf = (h) => h.calls.filter((c) => c.bin === ORCA && (c.args[0] === 'tab' || c.args[0] === 'worktree'))
// The remote stops: `kill -KILL -- -<pid>` over ssh, the whole process group.
export const killsOf = (h) => callsWith(h, 'kill -KILL')
export const deletesOf = (h) => callsWith(h, 'tab profile delete')
export const closesOf = (h, page) => callsWith(h, 'tab close').filter((c) => argAfter(c, '--page') === page)

// Every path leaves the login discarded (when one was made) and the tab closed (when one was opened).
export function assertCleaned(h, { dir = null, page = null }) {
  assert.equal(h.calls.filter((c) => c.line.includes('login-discard')).length, dir ? 1 : 0, 'login-discard calls')
  if (dir) assert.equal(discardsOf(h, dir).length, 1)
  assert.equal(callsWith(h, 'tab close').length, page ? 1 : 0, 'tab close calls')
  if (page) assert.equal(closesOf(h, page).length, 1)
  assert.equal(h.jobs.running.size, 0, 'the host is released')
}

// Starts a remote sign-in and gets it to the point where the browser tab is open.
export async function openRemoteTab(h, account = null, host = DEV, settings = SETTINGS) {
  const spawned = h.spawns.length
  const tabs = callsWith(h, 'tab create').length
  h.jobs.start({ host, settings, account })
  await until(() => h.spawns.length === spawned + 1)
  const login = h.spawns.at(-1).child
  login.emitPid()
  login.emitUrl()
  await until(() => callsWith(h, 'tab create').length === tabs + 1)
  return login
}
