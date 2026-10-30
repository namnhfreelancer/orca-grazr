import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRunner, ok } from '../lib/runner.mjs'
import { fixtureSettings } from './support/fixture-hosts.mjs'

const HOME = '/home/t'
const settings = fixtureSettings()
const homedir = () => HOME

// Records every exec call and answers with the scripted result for that call, in order.
function fakeExec(...scripted) {
  const calls = []
  const exec = async (argv, opts) => {
    calls.push({ argv, opts })
    const next = scripted.shift() ?? {}
    return { argv, code: 0, signal: null, stdout: '', stderr: '', timedOut: false, spawnError: null, timeoutMs: opts.timeoutMs, ...next }
  }
  return { exec, calls }
}

const mac = settings.hosts.find((h) => h.name === 'mac')
const dev2 = settings.hosts.find((h) => h.name === 'devbox-2')

test('local command runs the engine with the host python and an expanded path', () => {
  const { command } = createRunner({ settings, homedir })
  const { argv } = command(mac, ['status', '--json'])
  assert.deepEqual(argv, ['python3', '/home/t/.local/share/orca-grazr/engine/grazr.py', 'status', '--json'])
})

test('local command passes expanded GRAZR_* variables and keeps PATH from the process', () => {
  const { command } = createRunner({ settings, homedir })
  const { env } = command(mac, ['status', '--json'])
  assert.equal(env.GRAZR_STATE_DIR, '/home/t/.local/state/orca-grazr')
  assert.equal(env.GRAZR_CONFIG_DIR, '/home/t/.config/orca-grazr')
  assert.equal(env.GRAZR_NOTIFIER, 'osascript')
  assert.equal(env.PATH, process.env.PATH)
})

test('remote command runs over ssh with the engine assignments as shell prefixes', () => {
  const { command } = createRunner({ settings, homedir })
  const { argv } = command(dev2, ['swap', 'my account'])
  assert.deepEqual(argv.slice(0, 5), ['/usr/bin/ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5'])
  assert.equal(argv[5], 'devbox-2')
  assert.equal(
    argv.at(-1),
    "GRAZR_STATE_DIR=~/.local/state/orca-grazr GRAZR_CONFIG_DIR=~/.config/orca-grazr GRAZR_NOTIFIER=queue python3 ~/.local/share/orca-grazr/engine/grazr.py swap 'my account'",
  )
})

test('run forwards argv, env, timeout and input to exec and tags the result with the host', async () => {
  const { exec, calls } = fakeExec()
  const runner = createRunner({ settings, exec, homedir })
  const result = await runner.run(dev2, ['swap'], { timeoutMs: 3000, input: 'x' })
  assert.equal(calls[0].opts.timeoutMs, 3000)
  assert.equal(calls[0].opts.input, 'x')
  assert.equal(result.host, 'devbox-2')
  assert.equal(result.remote, true)
})

test('run marks a local result as not remote', async () => {
  const { exec } = fakeExec()
  const result = await createRunner({ settings, exec, homedir }).run(mac, ['status'])
  assert.equal(result.host, 'mac')
  assert.equal(result.remote, false)
})

test('ok is true only for a clean exit 0 with no timeout or spawn error', () => {
  assert.equal(ok({ code: 0, timedOut: false, spawnError: null }), true)
  assert.equal(ok({ code: 1, timedOut: false, spawnError: null }), false)
  assert.equal(ok({ code: 0, timedOut: true, spawnError: null }), false)
  assert.equal(ok({ code: null, timedOut: false, spawnError: new Error('x') }), false)
})

test('runJson parses stdout of a successful run', async () => {
  const { exec } = fakeExec({ stdout: '{"active":"a1"}' })
  const r = await createRunner({ settings, exec, homedir }).runJson(mac, ['status', '--json'])
  assert.deepEqual(r.value, { active: 'a1' })
  assert.equal(r.ok, true)
})

test('runJson reports an engine refusal using the engine line', async () => {
  const { exec } = fakeExec({ code: 1, stdout: 'grazr: Busy rotating already\n' })
  const r = await createRunner({ settings, exec, homedir }).runJson(mac, ['swap'])
  assert.equal(r.ok, false)
  assert.equal(r.failure.kind, 'engine')
  assert.equal(r.failure.detail, 'Busy rotating already')
})

test('runJson reports an unreachable remote host when ssh exits 255', async () => {
  const { exec } = fakeExec({ code: 255, stderr: 'ssh: Could not resolve hostname devbox-2\n' })
  const r = await createRunner({ settings, exec, homedir }).runJson(dev2, ['status', '--json'])
  assert.equal(r.ok, false)
  assert.equal(r.failure.kind, 'unreachable')
})

test('runJson reports unreadable stdout as an engine failure', async () => {
  const { exec } = fakeExec({ stdout: 'not json' })
  const r = await createRunner({ settings, exec, homedir }).runJson(mac, ['status', '--json'])
  assert.deepEqual(r.failure, { kind: 'engine', detail: 'unreadable JSON from engine' })
})

test('runLines splits stdout into non-empty lines', async () => {
  const { exec } = fakeExec({ stdout: 'a1\n\nb2\n' })
  const r = await createRunner({ settings, exec, homedir }).runLines(mac, ['accounts'])
  assert.deepEqual(r.lines, ['a1', 'b2'])
  assert.equal(r.ok, true)
})
