import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SETTINGS,
  claudeBinOf,
  environmentOf,
  mergeSettings,
  currentTarget,
  nextTarget,
  isRemote,
  engineEnv,
  enginePath,
  forceInstallFor,
  hostFor,
} from '../lib/hosts.mjs'
import { fixtureSettings } from './support/fixture-hosts.mjs'

test('mergeSettings returns the defaults when nothing is stored', () => {
  assert.deepEqual(mergeSettings(undefined), DEFAULT_SETTINGS)
})

test('mergeSettings lets stored scalars override defaults', () => {
  const s = mergeSettings({ drainIntervalMs: 60000 })
  assert.equal(s.drainIntervalMs, 60000)
  assert.equal(s.drainEnabled, true)
})

test('mergeSettings replaces the hosts array when stored hosts are non-empty', () => {
  const hosts = [{ name: 'lab', ssh: 'lab', python: 'python3', notifier: 'queue', forceInstall: null }]
  assert.deepEqual(mergeSettings({ hosts }).hosts, hosts)
})

test('mergeSettings ignores an empty hosts array', () => {
  assert.deepEqual(mergeSettings({ hosts: [] }).hosts, DEFAULT_SETTINGS.hosts)
})

test('mergeSettings fills per-host defaults for a bare user-written host', () => {
  assert.deepEqual(mergeSettings({ hosts: [{ name: 'box', ssh: 'box' }] }).hosts, [
    { name: 'box', ssh: 'box', python: 'python3', notifier: 'queue', forceInstall: null },
  ])
})

test('the Mac host notifies through osascript only, so queued notices are not shown twice', () => {
  assert.equal(DEFAULT_SETTINGS.hosts[0].notifier, 'osascript')
  assert.equal(fixtureSettings().hosts[1].notifier, 'queue')
})

test('the shipped default is the local Mac alone', () => {
  assert.deepEqual(DEFAULT_SETTINGS.hosts, [{ name: 'mac', ssh: null, python: 'python3', notifier: 'osascript' }])
})

test('forceInstallFor uses the global value when the host has no override', () => {
  const s = mergeSettings({ forceInstall: true })
  assert.equal(forceInstallFor(s, s.hosts[0]), true)
  assert.equal(forceInstallFor(mergeSettings({}), mergeSettings({}).hosts[0]), false)
})

test('forceInstallFor lets a host set true over a false global', () => {
  const s = mergeSettings({ forceInstall: false, hosts: [{ name: 'dev2', ssh: 'dev2', forceInstall: true }] })
  assert.equal(forceInstallFor(s, s.hosts[0]), true)
})

test('forceInstallFor lets a host set false over a true global', () => {
  const s = mergeSettings({ forceInstall: true, hosts: [{ name: 'mac', ssh: null, forceInstall: false }] })
  assert.equal(forceInstallFor(s, s.hosts[0]), false)
})

test('the panel opens on the clock face and the session window by default', () => {
  const s = mergeSettings(undefined)
  assert.equal(s.panelFace, 'clock')
  assert.equal(s.panelView, 'session')
})

test('panelFace and panelView keep their valid values and fall back to the default for any other', () => {
  assert.equal(mergeSettings({ panelFace: 'dial' }).panelFace, 'dial')
  assert.equal(mergeSettings({ panelFace: 'list' }).panelFace, 'list')
  assert.equal(mergeSettings({ panelFace: 'List' }).panelFace, 'clock')
  assert.equal(mergeSettings({ panelFace: 'Dial' }).panelFace, 'clock')
  assert.equal(mergeSettings({ panelFace: 3 }).panelFace, 'clock')
  assert.equal(mergeSettings({ panelView: 'weekly' }).panelView, 'weekly')
  assert.equal(mergeSettings({ panelView: 'month' }).panelView, 'session')
  assert.equal(mergeSettings({ panelView: null }).panelView, 'session')
})

test('mergeSettings replaces wrong-typed values with the defaults', () => {
  const s = mergeSettings({
    drainIntervalMs: 'soon', maxToastsPerHostPerCycle: '5', drainEnabled: 'yes', forceInstall: 'no',
    sshBin: 7, sshOptions: '-o BatchMode=yes', engineDir: null,
  })
  assert.deepEqual(
    { drainIntervalMs: s.drainIntervalMs, maxToastsPerHostPerCycle: s.maxToastsPerHostPerCycle, drainEnabled: s.drainEnabled, forceInstall: s.forceInstall, sshBin: s.sshBin, sshOptions: s.sshOptions, engineDir: s.engineDir },
    { drainIntervalMs: 120000, maxToastsPerHostPerCycle: 5, drainEnabled: true, forceInstall: false, sshBin: '/usr/bin/ssh', sshOptions: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5'], engineDir: '~/.local/share/orca-grazr/engine' },
  )
})

test('mergeSettings clamps drainIntervalMs to 30 s through 4 minutes', () => {
  assert.equal(mergeSettings({ drainIntervalMs: 300000 }).drainIntervalMs, 240000)
  assert.equal(mergeSettings({ drainIntervalMs: 0 }).drainIntervalMs, 30000)
  assert.equal(mergeSettings({ drainIntervalMs: 60000 }).drainIntervalMs, 60000)
})

test('forceInstallFor always returns a boolean', () => {
  const s = mergeSettings({ forceInstall: undefined })
  assert.equal(forceInstallFor(s, { name: 'x', ssh: null }), false)
  assert.equal(forceInstallFor({ forceInstall: 'yes' }, { name: 'x', forceInstall: null }), true)
})

test('mergeSettings drops hosts without a string name', () => {
  const s = mergeSettings({ hosts: [{ ssh: 'x' }, { name: 'ok', ssh: 'ok' }] })
  assert.deepEqual(s.hosts.map((h) => h.name), ['ok'])
})

test('mergeSettings falls back to the defaults when no host has a name', () => {
  assert.deepEqual(mergeSettings({ hosts: [{ ssh: 'x' }] }).hosts, DEFAULT_SETTINGS.hosts)
})

test('mergeSettings keeps unknown keys', () => {
  assert.equal(mergeSettings({ futureKey: 7 }).futureKey, 7)
})

test('mergeSettings does not mutate DEFAULT_SETTINGS', () => {
  mergeSettings({}).hosts.push({ name: 'extra' })
  assert.equal(DEFAULT_SETTINGS.hosts.length, 1)
})

test('currentTarget returns the host named by settings.target', () => {
  assert.equal(currentTarget(fixtureSettings({ target: 'devbox' })).name, 'devbox')
})

test('currentTarget falls back to the first host for an unknown target', () => {
  assert.equal(currentTarget(fixtureSettings({ target: 'nope' })).name, 'mac')
})

test('nextTarget reports the 1-based index and count of the following host', () => {
  const next = nextTarget(fixtureSettings({ target: 'mac' }))
  assert.equal(next.host.name, 'devbox')
  assert.deepEqual({ index: next.index, count: next.count }, { index: 2, count: 3 })
})

test('nextTarget wraps from the last host to the first', () => {
  const next = nextTarget(fixtureSettings({ target: 'devbox-2' }))
  assert.equal(next.host.name, 'mac')
  assert.deepEqual({ index: next.index, count: next.count }, { index: 1, count: 3 })
})

test('nextTarget treats an unknown target as the first host', () => {
  assert.equal(nextTarget(fixtureSettings({ target: 'nope' })).host.name, 'devbox')
})

test('engineEnv returns exactly the three GRAZR keys with raw strings', () => {
  const s = mergeSettings({})
  const env = engineEnv(s, s.hosts[0])
  assert.deepEqual(Object.keys(env).sort(), ['GRAZR_CONFIG_DIR', 'GRAZR_NOTIFIER', 'GRAZR_STATE_DIR'])
  assert.deepEqual(env, {
    GRAZR_STATE_DIR: '~/.local/state/orca-grazr',
    GRAZR_CONFIG_DIR: '~/.config/orca-grazr',
    GRAZR_NOTIFIER: 'osascript',
  })
})

test('enginePath joins engineDir and grazr.py', () => {
  assert.equal(enginePath(mergeSettings({})), '~/.local/share/orca-grazr/engine/grazr.py')
})

test('isRemote is true only for a host with a non-empty ssh alias', () => {
  assert.equal(isRemote({ name: 'mac', ssh: null }), false)
  assert.equal(isRemote({ name: 'x', ssh: '' }), false)
  assert.equal(isRemote({ name: 'x' }), false)
  assert.equal(isRemote({ name: 'devbox', ssh: 'devbox' }), true)
})

test('claudeBin is per host: an unset one runs ~/.local/bin/claude, a usable one is kept, a bad one falls back', () => {
  assert.equal(DEFAULT_SETTINGS.claudeBin, undefined, 'claudeBin is no longer a top-level setting')
  const bin = (claudeBin) => claudeBinOf(mergeSettings({ hosts: [{ name: 'box', ssh: 'box', ...(claudeBin === undefined ? {} : { claudeBin }) }] }).hosts[0])
  assert.equal(bin(undefined), '~/.local/bin/claude')
  assert.equal(bin('/opt/bin/claude'), '/opt/bin/claude')
  assert.equal(bin('~/bin/claude'), '~/bin/claude')
  assert.equal(bin(''), '~/.local/bin/claude')
  assert.equal(bin('   '), '~/.local/bin/claude')
  assert.equal(bin(4), '~/.local/bin/claude')
  assert.equal(bin('-p'), '~/.local/bin/claude')
  assert.equal(bin('  --help'), '~/.local/bin/claude')
})

test('no terminal app setting is left in the defaults', () => {
  assert.equal(DEFAULT_SETTINGS.terminalApp, undefined)
})

test('orcaBin defaults to /usr/local/bin/orca and falls back for a blank or dashed value', () => {
  assert.equal(DEFAULT_SETTINGS.orcaBin, '/usr/local/bin/orca')
  assert.equal(mergeSettings({ orcaBin: '/opt/orca' }).orcaBin, '/opt/orca')
  assert.equal(mergeSettings({ orcaBin: '' }).orcaBin, '/usr/local/bin/orca')
  assert.equal(mergeSettings({ orcaBin: '--json' }).orcaBin, '/usr/local/bin/orca')
  assert.equal(mergeSettings({ orcaBin: 3 }).orcaBin, '/usr/local/bin/orca')
})

test('environmentOf: an ssh host is its own environment unless orcaEnvironment names another; the Mac has none', () => {
  assert.equal(environmentOf({ name: 'devbox', ssh: 'devbox' }), 'devbox')
  assert.equal(environmentOf({ name: 'lab', ssh: 'lab-box', orcaEnvironment: 'devbox-2' }), 'devbox-2')
  assert.equal(environmentOf({ name: 'lab', ssh: 'lab', orcaEnvironment: '  ' }), 'lab')
  assert.equal(environmentOf({ name: 'mac', ssh: null }), null)
  assert.equal(environmentOf({ name: 'mac', ssh: null, orcaEnvironment: 'devbox' }), 'devbox')
})

test('hostFor returns the host the params name, and the target when they name none, and null for an unknown host', () => {
  const s = fixtureSettings({ target: 'mac' })
  assert.equal(hostFor(s, { host: 'devbox-2' }).name, 'devbox-2')
  assert.equal(hostFor(s, { host: 'nowhere' }), null)
  assert.equal(hostFor(s, { account: 'a@b' }).name, 'mac')
  assert.equal(hostFor(s, undefined).name, 'mac')
  assert.equal(hostFor(s, 'devbox').name, 'mac')
})

test('an ssh alias that starts with a dash is dropped, never run as an ssh option', () => {
  const s = mergeSettings({ hosts: [{ name: 'mac' }, { name: 'bad', ssh: '-oProxyCommand=evil' }, { name: 'devbox', ssh: 'devbox' }] })
  assert.deepEqual(s.hosts.map((h) => h.name), ['mac', 'devbox'])
})

test('an orcaEnvironment that starts with a dash is refused: the host name is used instead', () => {
  const s = mergeSettings({ hosts: [{ name: 'devbox', ssh: 'devbox', orcaEnvironment: '--json' }] })
  assert.equal(s.hosts[0].orcaEnvironment, null)
  assert.equal(environmentOf(s.hosts[0]), 'devbox')
  assert.equal(environmentOf({ name: 'lab', ssh: 'lab', orcaEnvironment: '-x' }), 'lab')
})
