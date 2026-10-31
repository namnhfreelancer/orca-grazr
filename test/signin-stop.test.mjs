import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'
import { remoteLoginCommand, LOGIN_TIMEOUT_MS, URL_TIMEOUT_MS } from '../lib/signin.mjs'
import { D1, D2, DEV, PID, SETTINGS, assertCleaned, callsWith, discardsOf, harness, killsOf, openRemoteTab, until } from './support/signin-harness.mjs'

// The kill goes to the login host by the pid that shell printed first, and only before the discard.
const killOrder = (h) => h.calls.findIndex((c) => c.line.includes('kill -KILL')) < h.calls.findIndex((c) => c.line.includes('login-discard'))

test('the remote login command echoes the pid, execs timeout around claude, and the pid is the one claude runs as', () => {
  const root = mkdtempSync(join(tmpdir(), 'grazr-stop-'))
  try {
    const home = join(root, 'home')
    const bin = join(root, 'bin')
    const config = join(root, 'config dir')
    mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    mkdirSync(bin)
    mkdirSync(config)
    // Stand-ins only: setsid and a timeout that drop their own arguments and exec the rest, and a claude that prints what
    // it was given. The real setsid and GNU timeout are not on every host the test runs on.
    writeFileSync(join(bin, 'setsid'), '#!/bin/sh\nexec "$@"\n')
    writeFileSync(join(bin, 'timeout'), '#!/bin/sh\nshift 3\nexec "$@"\n')
    writeFileSync(join(home, '.local', 'bin', 'claude'), '#!/bin/sh\nprintf \'%s\\n\' "$CLAUDE_CONFIG_DIR" "$$" "$@"\n')
    chmodSync(join(bin, 'setsid'), 0o755)
    chmodSync(join(bin, 'timeout'), 0o755)
    chmodSync(join(home, '.local', 'bin', 'claude'), 0o755)
    const command = remoteLoginCommand({ dir: config, claudeBin: '~/.local/bin/claude', args: ['auth', 'login', '--email', 'a b@c.io'] })
    const out = execFileSync('/bin/sh', ['-c', command], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, encoding: 'utf8' }).replace(/\n$/, '').split('\n')
    const [echoed, dir, claudePid, ...args] = out
    assert.match(echoed, /^grazr-pid:\d+$/)
    assert.equal(echoed, `grazr-pid:${claudePid}`, 'the echoed pid is the process claude runs as')
    assert.equal(dir, config, 'the config directory is set, spaces and all')
    assert.deepEqual(args, ['auth', 'login', '--email', 'a b@c.io'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the remote login line: the pid is echoed before timeout, the claude path keeps its ~ and the args are quoted', () => {
  assert.equal(
    remoteLoginCommand({ dir: D1, claudeBin: '~/.local/bin/claude', args: ['auth', 'login'] }),
    `CLAUDE_CONFIG_DIR=${D1} setsid sh -c 'echo grazr-pid:$$; exec timeout -k 5 1830 ~/.local/bin/claude auth login'`,
  )
  assert.equal(
    remoteLoginCommand({ dir: D1, claudeBin: '/opt/my bin/claude', args: ['auth', 'login', '--email', 'a;b@c.io'] }),
    `CLAUDE_CONFIG_DIR=${D1} setsid sh -c 'echo grazr-pid:$$; exec timeout -k 5 1830 '\\''/opt/my bin/claude'\\'' auth login --email '\\''a;b@c.io'\\'''`,
  )
})

test('a cancel stops the local ssh, kills the remote pid on the login host, then discards the login', async () => {
  const h = harness()
  const first = await openRemoteTab(h, null)
  h.closeTab() // the sign-in tab is gone: a new start restarts
  assert.equal((await h.jobs.start({ host: DEV, settings: SETTINGS, account: null })).ok, true)
  assert.deepEqual(first.signals, ['SIGTERM'])
  first.exit(null, '', 'SIGTERM')
  await until(() => h.spawns.length === 2)
  const kills = killsOf(h)
  assert.equal(kills.length, 1)
  assert.equal(kills[0].where, 'devbox', 'the kill runs on the login host')
  assert.equal(kills[0].line, `kill -KILL -- -${PID}`)
  assert.ok(kills[0].timeoutMs <= 5000, 'the kill is short')
  assert.equal(killOrder(h), true, 'the pid is killed before the login is discarded')
  assert.equal(discardsOf(h, D1).length, 1)
  assert.equal(callsWith(h, 'kill -KILL').length, 1, 'the new sign-in does not kill anything yet')
  h.spawns[1].child.exit(0)
  await until(() => h.refreshes === 2)
  assert.equal(killsOf(h).length, 1, 'a successful login is never killed')
  assert.equal(discardsOf(h, D2).length, 1)
})

test('a tab that does not open stops the remote pid before the login is discarded', async () => {
  const h = harness({ overrides: { 'tab create': () => ({ code: 1, stdout: JSON.stringify({ ok: false, error: { message: 'no browser' } }) }) } })
  await h.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  await until(() => h.spawns.length === 1)
  const { child } = h.spawns[0]
  child.emitPid()
  child.emitUrl()
  await until(() => child.signals.length === 1)
  child.exit(null, '', 'SIGTERM')
  await until(() => h.refreshes === 1)
  assert.equal(killsOf(h).length, 1)
  assert.equal(killsOf(h)[0].line, `kill -KILL -- -${PID}`)
  assert.equal(killOrder(h), true)
  assertCleaned(h, { dir: D1 })
})

test('the URL that never comes stops the remote pid when one was read, and kills nothing when none was', async () => {
  const withPid = harness()
  await withPid.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  await until(() => withPid.spawns.length === 1)
  withPid.spawns[0].child.emitPid()
  withPid.clock.fire(URL_TIMEOUT_MS)
  withPid.spawns[0].child.exit(null, '', 'SIGTERM')
  await until(() => withPid.refreshes === 1)
  assert.equal(killsOf(withPid).length, 1)
  assert.equal(killsOf(withPid)[0].line, `kill -KILL -- -${PID}`)

  const withoutPid = harness()
  await withoutPid.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  await until(() => withoutPid.spawns.length === 1)
  withoutPid.clock.fire(URL_TIMEOUT_MS)
  withoutPid.spawns[0].child.exit(null, '', 'SIGTERM')
  await until(() => withoutPid.refreshes === 1)
  assert.equal(killsOf(withoutPid).length, 0, 'no parsed pid, no kill')
  assert.equal(withoutPid.published[0].title, 'devbox: sign-in failed')
})

test('the 10-minute limit stops the remote pid', async () => {
  const h = harness()
  const login = await openRemoteTab(h, null)
  h.clock.fire(LOGIN_TIMEOUT_MS)
  login.exit(null, '', 'SIGTERM')
  await until(() => h.refreshes === 1)
  assert.equal(killsOf(h).length, 1)
  assert.equal(h.published[0].title, 'devbox: sign-in timed out')
  assertCleaned(h, { dir: D1, page: 'page-1' })
})

test('a login that exits 0 is enrolled and never killed', async () => {
  const h = harness()
  const login = await openRemoteTab(h, null)
  login.exit(0)
  await until(() => h.refreshes === 1)
  assert.equal(h.published[0].title, 'devbox: signed in')
  assert.equal(killsOf(h).length, 0)
})

test('a login that exits with an error is stopped by its pid, which is harmless once it has ended', async () => {
  const h = harness()
  const login = await openRemoteTab(h, null)
  login.exit(1, 'Login failed\n')
  await until(() => h.refreshes === 1)
  assert.equal(killsOf(h).length, 1)
  assertCleaned(h, { dir: D1, page: 'page-1' })
})

test('a pid split across output is read once its line is whole; a pid that is not a number is never used', async () => {
  const split = harness()
  await split.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  await until(() => split.spawns.length === 1)
  const { child } = split.spawns[0]
  child.stdout.emit('data', Buffer.from('grazr-pid:42'))
  child.stdout.emit('data', Buffer.from('43\r\n'))
  split.clock.fire(URL_TIMEOUT_MS)
  child.exit(null, '', 'SIGTERM')
  await until(() => split.refreshes === 1)
  assert.equal(killsOf(split)[0].line, 'kill -KILL -- -4243')

  const junk = harness()
  await junk.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  await until(() => junk.spawns.length === 1)
  junk.spawns[0].child.stdout.emit('data', Buffer.from('grazr-pid:abc\r\ngrazr-pid:\r\n'))
  junk.clock.fire(URL_TIMEOUT_MS)
  junk.spawns[0].child.exit(null, '', 'SIGTERM')
  await until(() => junk.refreshes === 1)
  assert.equal(killsOf(junk).length, 0)
})

test('a failed kill is logged, and the login is still discarded and the card still told', async () => {
  const h = harness({ overrides: { 'kill -KILL': () => ({ code: 255, stderr: 'ssh: Could not resolve hostname devbox\n' }) } })
  const login = await openRemoteTab(h, null)
  h.clock.fire(LOGIN_TIMEOUT_MS)
  login.exit(null, '', 'SIGTERM')
  await until(() => h.refreshes === 1)
  assert.ok(h.logs.some((m) => m.includes('the remote login on devbox was not stopped')))
  assert.equal(h.published[0].title, 'devbox: sign-in timed out')
  assertCleaned(h, { dir: D1, page: 'page-1' })
})

test('a stop before the pid line was read is logged: the remote login is not killed and says it ends by itself', async () => {
  const h = harness()
  await h.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  await until(() => h.spawns.length === 1)
  const first = h.spawns[0].child
  first.emitUrl()
  await until(() => callsWith(h, 'tab create').length === 1)
  // No pid line: the output never carried one.
  await h.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  first.exit(null, '', 'SIGTERM')
  await until(() => h.refreshes === 1)
  assert.ok(h.logs.includes('grazr sign-in: remote login pid unknown; it ends by itself within 30 minutes'), h.logs.join(' | '))
  assert.equal(killsOf(h).length, 0, 'no pid, no kill')
  assert.equal(discardsOf(h, D1).length, 1, 'the login is still discarded')
})
