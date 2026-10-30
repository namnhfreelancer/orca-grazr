import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDeploy } from '../lib/deploy.mjs'
import { fixtureSettings } from './support/fixture-hosts.mjs'

const settings = fixtureSettings()
const homedir = () => '/home/t'
const root = '/plug'
const mac = settings.hosts.find((h) => h.name === 'mac')
const dev2 = settings.hosts.find((h) => h.name === 'devbox-2')

// Each call answers with the next scripted result, or a clean exit 0 once the script runs out.
function fakeExec(...scripted) {
  const calls = []
  const exec = async (argv, opts) => {
    calls.push(argv)
    const next = scripted.shift() ?? {}
    return { argv, code: 0, signal: null, stdout: '', stderr: '', timedOut: false, spawnError: null, timeoutMs: opts.timeoutMs, ...next }
  }
  return { exec, calls }
}

test('local commands create the engine dir and rsync the plugin engine into it', () => {
  const { commands } = createDeploy({ settings, homedir, root, exec: fakeExec().exec })
  assert.deepEqual(commands(mac), [
    ['/bin/mkdir', '-p', '/home/t/.local/share/orca-grazr/engine'],
    ['/usr/bin/rsync', '-a', '--delete', '--exclude', '__pycache__', '--exclude', 'test_*',
      '/plug/engine/', '/home/t/.local/share/orca-grazr/engine/'],
  ])
})

test('remote commands mkdir over ssh then rsync relative to the remote home', () => {
  const { commands } = createDeploy({ settings, homedir, root, exec: fakeExec().exec })
  assert.deepEqual(commands(dev2), [
    ['/usr/bin/ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'devbox-2',
      'mkdir -p ~/.local/share/orca-grazr/engine'],
    ['/usr/bin/rsync', '-a', '--delete', '--exclude', '__pycache__', '--exclude', 'test_*',
      '-e', '/usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=5',
      '/plug/engine/', 'devbox-2:.local/share/orca-grazr/engine/'],
  ])
})

test('deploy runs every step in order and reports ok on success', async () => {
  const { exec, calls } = fakeExec()
  const d = createDeploy({ settings, homedir, root, exec })
  const result = await d.deploy(dev2)
  assert.equal(result.ok, true)
  assert.equal(calls.length, 2)
})

test('deploy stops at the first failing step and reports its index', async () => {
  const { exec, calls } = fakeExec({ code: 255, stderr: 'ssh: connect to host devbox-2 port 22: Operation timed out\n' })
  const d = createDeploy({ settings, homedir, root, exec })
  const result = await d.deploy(dev2)
  assert.equal(result.ok, false)
  assert.equal(result.step, 0)
  assert.equal(result.failure.kind, 'unreachable')
  assert.equal(calls.length, 1, 'the rsync step must never run after mkdir fails')
})
