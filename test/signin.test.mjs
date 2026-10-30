import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createSigninJobs, loginEnv, clip, LOGIN_TIMEOUT_MS, HARD_DEADLINE_MS, KILL_GRACE_MS, LINE_MAX } from '../lib/signin.mjs'
import { fixtureSettings } from './support/fixture-hosts.mjs'

const settings = fixtureSettings()
const mac = settings.hosts.find((h) => h.name === 'mac')
const dev = settings.hosts.find((h) => h.name === 'devbox')
const DIR = '/tmp/T/grazr-login-abc123'
const EXPORT = { identity: { emailAddress: 'a@b.io' }, blob: { claudeAiOauth: { accessToken: 'sk-secret-blob' } } }
const EXPORT_LINE = `${JSON.stringify(EXPORT)}\n`

// The engine subcommand an argv runs, locally (python3 engine ...) or over ssh (the remote command is the last argv).
const labelOf = (argv) => (argv[0] === 'python3' ? argv.slice(2).join(' ') : argv.at(-1))

// Answers engine subcommands by a substring of their label; a value may be a function of (argv).
function answers(table) {
  return (argv) => {
    const cmd = labelOf(argv)
    const key = Object.keys(table).find((k) => cmd.includes(k))
    if (key === undefined) return {}
    return typeof table[key] === 'function' ? table[key](argv) : table[key]
  }
}

function fakeExec(route) {
  const calls = []
  const exec = async (argv, opts = {}) => {
    calls.push({ argv, opts })
    const next = (await route(argv, opts)) ?? {}
    return { argv, code: 0, signal: null, stdout: '', stderr: '', timedOut: false, spawnError: null, timeoutMs: opts.timeoutMs, ...next }
  }
  return { exec, calls }
}

// Timers are recorded, never fired by themselves; a test fires the one it means.
function fakeClock() {
  const armed = []
  return {
    armed,
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; armed.push(t); return t },
    clearTimeout: (t) => { if (t) t.cleared = true },
    fire: (ms) => armed.find((t) => t.ms === ms && !t.cleared).fn(),
  }
}

// A fake claude child: its close is emitted by the test; kill is recorded.
function fakeSpawn({ throwWith = null } = {}) {
  const spawns = []
  const spawn = (file, args, opts) => {
    if (throwWith) throw throwWith
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = new EventEmitter()
    child.stdin.destroyed = false
    child.stdin.destroy = () => { child.stdin.destroyed = true }
    child.signals = []
    child.kill = (signal) => { child.signals.push(signal) }
    spawns.push({ file, args, opts, child })
    return child
  }
  return { spawn, spawns }
}

const fakeFs = () => {
  const removed = []
  return {
    removed,
    mkdtemp: async (prefix) => `${prefix}abc123`,
    rm: async (path) => { removed.push(path) },
  }
}

async function until(pred) {
  for (let i = 0; i < 300; i++) {
    if (pred()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('condition not met')
}

function setup({ route, spawned = fakeSpawn(), clock = fakeClock(), timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
  const ex = fakeExec(route ?? answers({}))
  const fs = fakeFs()
  const published = []
  const counts = { refresh: 0 }
  const jobs = createSigninJobs({
    exec: ex.exec,
    spawn: spawned.spawn,
    homedir: () => '/home/t',
    tmpdir: '/tmp/T',
    fs,
    baseEnv: { PATH: '/usr/bin:/bin', HOME: '/home/t', ANTHROPIC_API_KEY: 'sk-ant-leak', LANG: 'en_GB.UTF-8' },
    timers: clock,
    publish: async (t) => { published.push(t) },
    refreshPanel: async () => { counts.refresh++ },
    loginTimeoutMs: timeoutMs,
  })
  // The job's outcome is one toast and one refresh; the wait is for both.
  const done = () => until(() => counts.refresh === 1)
  const exitLogin = async (code, stderr = '', signal = null) => {
    await until(() => spawned.spawns.length === 1)
    const { child } = spawned.spawns[0]
    if (stderr) child.stderr.emit('data', Buffer.from(stderr))
    child.emit('close', code, signal)
  }
  return { jobs, ex, fs, published, counts, spawned, clock, done, exitLogin }
}

const discards = (ex) => ex.calls.filter((c) => labelOf(c.argv) === `login-discard --from ${DIR}`)

test('Mac sign-in with no account: browser login, enrol by the signed-in e-mail, discard, toast and refresh', async () => {
  const s = setup({ route: answers({ 'login-export': { stdout: EXPORT_LINE }, 'enrol --from': { stdout: '{"ok":true,"id":"x","name":"a@b.io","email":"a@b.io","unblocked":true}\n' }, 'login-discard': {} }) })
  const started = s.jobs.start({ host: mac, settings, account: null })
  assert.deepEqual(started, { ok: true, message: 'Sign in to a new account in your browser' })
  await s.exitLogin(0)
  await s.done()
  const [login] = s.spawned.spawns
  assert.equal(login.file, 'claude')
  assert.deepEqual(login.args, ['auth', 'login'])
  assert.equal(login.opts.env.CLAUDE_CONFIG_DIR, DIR)
  assert.equal(login.opts.env.ANTHROPIC_API_KEY, undefined)
  assert.equal(login.opts.env.PATH, '/usr/bin:/bin')
  const enrol = s.ex.calls.find((c) => labelOf(c.argv).startsWith('enrol --from'))
  assert.equal(labelOf(enrol.argv), `enrol --from ${DIR} --name a@b.io --json`)
  assert.equal(discards(s.ex).length, 1)
  assert.deepEqual(s.fs.removed, [DIR])
  assert.equal(s.published.length, 1)
  assert.equal(s.published[0].title, 'mac: signed in')
  assert.equal(s.published[0].body, 'Enrolled a@b.io on mac')
})

test('re-authentication passes the account as --email, --name and --expect-email', async () => {
  const s = setup({ route: answers({ 'login-export': { stdout: EXPORT_LINE }, 'enrol --from': { stdout: '{"ok":true,"email":"a@b.io","unblocked":true}\n' }, 'login-discard': {} }) })
  s.jobs.start({ host: mac, settings, account: 'a@b.io' })
  await s.exitLogin(0)
  await s.done()
  assert.deepEqual(s.spawned.spawns[0].args, ['auth', 'login', '--email', 'a@b.io'])
  const enrol = s.ex.calls.find((c) => labelOf(c.argv).startsWith('enrol --from'))
  assert.equal(labelOf(enrol.argv), `enrol --from ${DIR} --name a@b.io --expect-email a@b.io --json`)
})

test('remote host: the export goes to the remote engine over ssh stdin, never in argv, and the credential is in no toast', async () => {
  const s = setup({ route: answers({
    'login-export': { stdout: EXPORT_LINE },
    'enrol --stdin': { stdout: '{"ok":true,"email":"a@b.io","unblocked":true}\n' },
    'login-discard': {},
  }) })
  s.jobs.start({ host: dev, settings, account: 'a@b.io' })
  await s.exitLogin(0)
  await s.done()
  const remote = s.ex.calls.find((c) => c.argv[0] === settings.sshBin)
  assert.equal(remote.argv[settings.sshOptions.length + 1], 'devbox')
  assert.match(labelOf(remote.argv), /enrol --stdin --name a@b\.io --expect-email a@b\.io --json$/)
  assert.equal(remote.opts.input, EXPORT_LINE)
  assert.equal(JSON.stringify(s.ex.calls.map((c) => c.argv)).includes('sk-secret-blob'), false)
  assert.equal(JSON.stringify(s.published).includes('sk-secret-blob'), false)
  assert.equal(s.published[0].title, 'devbox: signed in')
  assert.equal(discards(s.ex).length, 1, 'the throwaway login is discarded on the Mac')
})

test('wrong account signed in: nothing is enrolled, the engine reason is the toast, the login is discarded', async () => {
  const s = setup({ route: answers({
    'login-export': { stdout: EXPORT_LINE },
    'enrol --from': { code: 1, stdout: '{"ok":false,"error":"signed in as b@y.io, expected x@y.io"}\n' },
    'login-discard': {},
  }) })
  s.jobs.start({ host: mac, settings, account: 'x@y.io' })
  await s.exitLogin(0)
  await s.done()
  assert.equal(s.published[0].title, 'mac: sign-in failed')
  assert.match(s.published[0].body, /signed in as b@y\.io, expected x@y\.io/)
  assert.match(s.published[0].body, /Nothing was enrolled/)
  assert.equal(discards(s.ex).length, 1)
})

test('sign-in abandoned: after the timeout claude is killed, the login discarded and the toast says timed out', async () => {
  const s = setup({ route: answers({ 'login-export': { stdout: EXPORT_LINE }, 'login-discard': {} }) })
  s.jobs.start({ host: mac, settings, account: null })
  await until(() => s.spawned.spawns.length === 1)
  s.clock.fire(LOGIN_TIMEOUT_MS)
  assert.deepEqual(s.spawned.spawns[0].child.signals, ['SIGTERM'])
  s.spawned.spawns[0].child.emit('close', null, 'SIGTERM')
  await s.done()
  assert.equal(s.published[0].title, 'mac: sign-in timed out')
  assert.equal(s.ex.calls.some((c) => labelOf(c.argv).startsWith('enrol')), false)
  assert.equal(discards(s.ex).length, 1)
})

test('a second start for the same host is refused while the first runs; another host is not blocked', async () => {
  const s = setup({ route: answers({ 'login-export': { stdout: EXPORT_LINE }, 'enrol --from': { stdout: '{"ok":true,"email":"a@b.io","unblocked":true}\n' }, 'login-discard': {} }) })
  assert.equal(s.jobs.start({ host: mac, settings }).ok, true)
  assert.deepEqual(s.jobs.start({ host: mac, settings }), { ok: false, message: 'A sign-in for mac is already running' })
  assert.equal(s.jobs.start({ host: dev, settings, account: 'x@y.io' }).ok, true)
  await until(() => s.spawned.spawns.length === 2)
  assert.equal(s.spawned.spawns.length, 2)
})

test('remote host unreachable after a good login: nothing enrolled there, discarded, the toast says the host could not be reached', async () => {
  const s = setup({ route: answers({
    'login-export': { stdout: EXPORT_LINE },
    'enrol --stdin': { code: 255, stderr: 'ssh: Could not resolve hostname devbox\n' },
    'login-discard': {},
  }) })
  s.jobs.start({ host: dev, settings, account: null })
  await s.exitLogin(0)
  await s.done()
  assert.equal(s.published[0].title, 'devbox: sign-in failed')
  assert.equal(s.published[0].body, 'devbox could not be reached; nothing was enrolled there.')
  assert.equal(discards(s.ex).length, 1)
  assert.deepEqual(s.fs.removed, [DIR])
})

test('claude exits non-zero: its login line is the toast, no export is read, the login is discarded', async () => {
  const s = setup({ route: answers({ 'login-discard': {} }) })
  s.jobs.start({ host: mac, settings, account: null })
  await s.exitLogin(1, 'Opening browser to sign in…\nLogin failed: access denied\n')
  await s.done()
  assert.equal(s.published[0].title, 'mac: sign-in failed')
  assert.equal(s.published[0].body, 'Login failed: access denied\nNothing was enrolled.')
  assert.equal(s.ex.calls.some((c) => labelOf(c.argv).startsWith('login-export')), false)
  assert.equal(discards(s.ex).length, 1)
})

test('claude cannot be run: the toast names the claudeBin and nothing else runs', async () => {
  const enoent = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })
  const s = setup({ spawned: fakeSpawn({ throwWith: enoent }), route: answers({ 'login-discard': {} }) })
  s.jobs.start({ host: mac, settings, account: null })
  await s.done()
  assert.equal(s.published[0].body, 'Could not run claude: spawn claude ENOENT')
})

test('a login with no e-mail on the Mac is not enrolled', async () => {
  const s = setup({ route: answers({ 'login-export': { stdout: '{"identity":{},"blob":{"claudeAiOauth":{}}}\n' }, 'login-discard': {} }) })
  s.jobs.start({ host: mac, settings, account: null })
  await s.exitLogin(0)
  await s.done()
  assert.match(s.published[0].body, /did not finish on this Mac/)
  assert.equal(s.ex.calls.some((c) => labelOf(c.argv).startsWith('enrol')), false)
})

test('an engine busy refusal is shown as the engine says it', async () => {
  const s = setup({ route: answers({
    'login-export': { stdout: EXPORT_LINE },
    'enrol --from': { code: 1, stdout: '{"ok":false,"error":"Busy rotating, try again in a moment"}\n' },
    'login-discard': {},
  }) })
  s.jobs.start({ host: mac, settings, account: null })
  await s.exitLogin(0)
  await s.done()
  assert.match(s.published[0].body, /Busy rotating, try again in a moment/)
})

test('a discard that throws is logged and does not stop the outcome toast', async () => {
  const logs = []
  const ex = fakeExec(answers({ 'login-export': { stdout: EXPORT_LINE }, 'enrol --from': { stdout: '{"ok":true,"email":"a@b.io","unblocked":true}\n' }, 'login-discard': () => { throw new Error('disk gone') } }))
  const spawned = fakeSpawn()
  let refreshes = 0
  const published = []
  const jobs = createSigninJobs({ exec: ex.exec, spawn: spawned.spawn, homedir: () => '/home/t', tmpdir: '/tmp/T', fs: fakeFs(), baseEnv: {}, timers: fakeClock(), log: (m) => logs.push(m), publish: async (t) => published.push(t), refreshPanel: async () => { refreshes++ } })
  jobs.start({ host: mac, settings })
  await until(() => spawned.spawns.length === 1)
  spawned.spawns[0].child.emit('close', 0, null)
  await until(() => refreshes === 1)
  assert.equal(published[0].title, 'mac: signed in')
  assert.ok(logs.some((m) => m.includes('discard failed: disk gone')))
})

test('loginEnv passes only the allowlist and sets the throwaway config dir', () => {
  const env = loginEnv({ PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'x', AWS_SECRET: 'y' }, DIR)
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CONFIG_DIR', 'HOME', 'PATH'])
  assert.equal(env.CLAUDE_CONFIG_DIR, DIR)
})

test('stdin is destroyed once the login has ended', async () => {
  const s = setup({ route: answers({ 'login-export': { stdout: EXPORT_LINE }, 'enrol --from': { stdout: '{"ok":true,"email":"a@b.io","unblocked":true}\n' }, 'login-discard': {} }) })
  s.jobs.start({ host: mac, settings, account: null })
  await s.exitLogin(0)
  await s.done()
  assert.equal(s.spawned.spawns[0].child.stdin.destroyed, true)
})

test('a child that never emits close is given up on after SIGKILL and its host is released', async () => {
  const s = setup({ route: answers({ 'login-discard': {} }) })
  s.jobs.start({ host: mac, settings, account: null })
  await until(() => s.spawned.spawns.length === 1)
  const { child } = s.spawned.spawns[0]
  s.clock.fire(LOGIN_TIMEOUT_MS)
  assert.deepEqual(child.signals, ['SIGTERM'])
  s.clock.fire(KILL_GRACE_MS)
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(s.jobs.running.has('mac'), true, 'still held until the hard deadline')
  s.clock.fire(HARD_DEADLINE_MS)
  await s.done()
  assert.equal(s.published[0].title, 'mac: sign-in timed out')
  assert.equal(child.stdin.destroyed, true)
  assert.equal(s.jobs.running.has('mac'), false)
  assert.equal(s.jobs.start({ host: mac, settings, account: null }).ok, true, 'a new sign-in can start for the host')
})

test('clip cuts a line to LINE_MAX characters with an ellipsis and leaves short text alone', () => {
  assert.equal(clip('short'), 'short')
  assert.equal(clip('x'.repeat(LINE_MAX)).length, LINE_MAX)
  const cut = clip('y'.repeat(900))
  assert.equal(cut.length, LINE_MAX)
  assert.ok(cut.endsWith('…'))
  assert.equal(clip(undefined), '')
})

test('a long claude stderr line reaches the toast clipped to LINE_MAX characters', async () => {
  const s = setup({ route: answers({ 'login-discard': {} }) })
  s.jobs.start({ host: mac, settings, account: null })
  await s.exitLogin(1, `Login failed: ${'z'.repeat(600)}\n`)
  await s.done()
  const [first, second] = s.published[0].body.split('\n')
  assert.equal(first.length, LINE_MAX)
  assert.equal(second, 'Nothing was enrolled.')
})

test('a long engine error line reaches the toast clipped to LINE_MAX characters', async () => {
  const s = setup({ route: answers({
    'login-export': { stdout: EXPORT_LINE },
    'enrol --from': { code: 1, stdout: `${JSON.stringify({ ok: false, error: 'e'.repeat(700) })}\n` },
    'login-discard': {},
  }) })
  s.jobs.start({ host: mac, settings, account: null })
  await s.exitLogin(0)
  await s.done()
  const [first] = s.published[0].body.split('\n')
  assert.equal(first.length, LINE_MAX)
})
