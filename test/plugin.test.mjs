import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DEFAULT_SETTINGS, mergeSettings } from '../lib/hosts.mjs'
import { createRunner } from '../lib/runner.mjs'
import { FIXTURE_HOSTS, fixtureSettings } from './support/fixture-hosts.mjs'
import { quote } from '../lib/shell-quote.mjs'
import { ROOT, fakeFs, fakeTimers, engine, label, start, statusRoute, statusExecs, commandLabels, toasts, hostCalls, report, PANEL } from './support/plugin-harness.mjs'

const manifest = JSON.parse(await readFile(resolve(ROOT, 'orca-plugin.json'), 'utf8'))

test('registers exactly the fourteen manifest command ids and the two events', async () => {
  const { commands, handlers, plugin } = await start()
  const ids = manifest.contributes.commands.map((c) => c.id).sort()
  assert.deepEqual([...commands.keys()].sort(), ids)
  assert.equal(Object.keys(plugin.commands).length, 14)
  assert.deepEqual([...handlers.keys()].sort(), manifest.contributes.events.map((e) => e.on).sort())
})

test('every command is also a panel request handler on a host with orca.panels.handle, answering as the command does', async () => {
  const { commands, panelHandlers } = await start()
  assert.deepEqual([...panelHandlers.keys()].sort(), [...commands.keys()].sort())
  const viaPanel = await panelHandlers.get('status')({})
  const viaCommand = await commands.get('status')({})
  assert.deepEqual(viaPanel, viaCommand)
  assert.equal(typeof viaPanel.ok, 'boolean')
  // A panel's plugin.request with no input reaches the handler as null, which the commands take as no params.
  const bare = await panelHandlers.get('active-host')(null)
  assert.equal(typeof bare.ok, 'boolean')
})

test('an older host without orca.panels still activates and registers every command', async () => {
  const { commands, panelHandlers } = await start({ noPanels: true })
  assert.equal(commands.size, 14)
  assert.equal(panelHandlers.size, 0)
})

test('a fresh install seeds all seventeen keys and records that it seeded', async () => {
  const { calls } = await start({ stored: {} })
  assert.equal(hostCalls({ calls }, 'settings.set').length, Object.keys(DEFAULT_SETTINGS).length)
  assert.equal(Object.keys(DEFAULT_SETTINGS).length, 17)
  assert.deepEqual(hostCalls({ calls }, 'storage.set').at(-1), { key: 'seeded', value: true })
})

test('an empty settings file after seeding is never overwritten and the user is told', async () => {
  const fake = await start({ stored: {}, storage: { seeded: true } })
  assert.equal(hostCalls(fake, 'settings.set').length, 0)
  assert.equal(toasts(fake).at(0).title, 'grazr: settings.json is empty or unreadable; using defaults until it is fixed')
})

test('seeds only the settings keys that are missing on activation', async () => {
  const { state, calls } = await start({ stored: { target: 'devbox' } })
  const sets = hostCalls({ calls }, 'settings.set').map((p) => p.key).sort()
  // The stored file names a target and so gets the three-host fixture; every other key but hosts is seeded.
  const missing = Object.keys(DEFAULT_SETTINGS).filter((k) => k !== 'target' && k !== 'hosts').sort()
  assert.deepEqual(sets, missing)
  assert.equal(state.settings.target, 'devbox')
  assert.deepEqual(state.settings.hosts, FIXTURE_HOSTS)
})

test('target-next cycles mac to devbox and says so', async () => {
  const fake = await start({ route: engine({}) })
  await fake.run('target-next')
  assert.deepEqual(hostCalls(fake, 'settings.set').at(-1), { key: 'target', value: 'devbox' })
  assert.equal(toasts(fake).at(-1).title, 'grazr: Target: devbox (2/3)')
})

test('status runs on all three hosts and toasts each one', async () => {
  const fake = await start({
    route: engine({ 'status --json': (argv) => (argv.includes('devbox-2')
      ? { code: 255, stderr: 'ssh: connect to host devbox-2 port 22: Operation timed out\n' }
      : { stdout: JSON.stringify(report()) }) }),
  })
  await fake.run('status')
  assert.equal(statusExecs(fake), 3)
  const titles = toasts(fake).map((t) => t.title)
  assert.equal(titles.length, 3)
  assert.ok(titles.includes('mac: work'))
  assert.ok(titles.includes('devbox-2: status failed'))
  const stored = hostCalls(fake, 'storage.set').find((p) => p.key === 'lastStatus').value
  assert.equal(stored.mac.ok, true)
  assert.equal(stored['devbox-2'].ok, false)
  assert.equal(stored.mac.at, 1000)
})

test('status keeps the other hosts when one host throws', async () => {
  const fake = await start({
    route: engine({ 'status --json': (argv) => {
      if (argv.includes('devbox-2')) throw new Error('exec exploded')
      return { stdout: JSON.stringify(report()) }
    } }),
  })
  await fake.run('status')
  const titles = toasts(fake).map((t) => t.title)
  assert.ok(titles.includes('mac: work'))
  assert.ok(titles.includes('grazr: exec exploded'))
  const stored = hostCalls(fake, 'storage.set').find((p) => p.key === 'lastStatus').value
  assert.equal(stored.mac.ok, true)
  assert.equal(stored['devbox-2'].ok, false)
})

test('install on mac runs mkdir, rsync and install in that order', async () => {
  const fake = await start({ route: engine({ install: { stdout: 'installed\n' } }) })
  await fake.run('install')
  assert.deepEqual(commandLabels(fake), ['mkdir', 'rsync', 'install'])
  assert.equal(toasts(fake).at(-1).body, 'installed')
})

test('a foreign owner refusal keeps the state dir in the body and gets the forceInstall hint', async () => {
  const dir = '/home/other/.local/state/grazr2'
  const line = `grazr: Claude's status line or StopFailure hook already belongs to another grazr (state in ${dir}); disconnect it there, or take it over with install --force`
  const fake = await start({ route: engine({ install: { code: 1, stdout: `${line}\n` } }) })
  await fake.run('install')
  const refusal = toasts(fake).at(-1)
  assert.equal(refusal.title, 'mac: install failed')
  assert.ok(refusal.body.includes(`(state in ${dir})`))
  assert.ok(refusal.body.endsWith('\nSet forceInstall: true for this host to take it over.'))
})

test('a user bar refusal is shown as the engine wrote it, with no forceInstall hint', async () => {
  const bar = "Claude's status line is your own bar running another grazr (state in /x); edit the bar by hand, --force leaves it alone"
  const fake = await start({ route: engine({ install: { code: 1, stdout: `grazr: ${bar}\n` } }) })
  await fake.run('install')
  assert.deepEqual(toasts(fake).at(-1), { title: 'mac: install failed', body: bar })
})

test('install with forceInstall runs the engine with --force', async () => {
  const fake = await start({
    stored: { forceInstall: true },
    route: engine({ 'install --force': { stdout: 'took over\n' } }),
  })
  await fake.run('install')
  assert.deepEqual(commandLabels(fake), ['mkdir', 'rsync', 'install --force'])
  assert.equal(toasts(fake).at(-1).body, 'took over')
})

test('a host-level forceInstall true forces only that host', async () => {
  const hosts = [
    { name: 'mac', ssh: null, python: 'python3', notifier: 'osascript' },
    { name: 'devbox-2', ssh: 'devbox-2', python: 'python3', notifier: 'queue', forceInstall: true },
  ]
  const owned = engine({
    'install --force': { stdout: 'took over\n' },
    install: { stdout: 'plain\n' },
  })
  const remote = await start({ stored: { target: 'devbox-2', forceInstall: false, hosts }, route: owned })
  await remote.run('install')
  assert.ok(remote.execs.some((a) => label(a) === 'install --force'))
  assert.equal(toasts(remote).at(-1).body, 'took over')

  const local = await start({ stored: { target: 'mac', forceInstall: false, hosts }, route: owned })
  await local.run('install')
  assert.ok(!local.execs.some((a) => label(a) === 'install --force'))
  assert.ok(local.execs.some((a) => label(a) === 'install'))
})

test('a host-level forceInstall false keeps --force off even when the global value is true', async () => {
  const hosts = [{ name: 'mac', ssh: null, python: 'python3', notifier: 'osascript', forceInstall: false }]
  const fake = await start({
    stored: { forceInstall: true, hosts },
    route: engine({ install: { stdout: 'plain\n' } }),
  })
  await fake.run('install')
  assert.deepEqual(commandLabels(fake), ['mkdir', 'rsync', 'install'])
  assert.equal(toasts(fake).at(-1).body, 'plain')
})

test('a host with forceInstall passes --force, and the engine refusal for a user bar is toasted verbatim', async () => {
  const bar = "Claude's status line is your own bar running another grazr (state in /home/t/.local/state/grazr2); edit the bar by hand, --force leaves it alone"
  const hosts = [{ name: 'mac', ssh: null, python: 'python3', notifier: 'osascript', forceInstall: true }]
  const fake = await start({
    stored: { hosts },
    route: engine({ 'install --force': { code: 1, stdout: `grazr: ${bar}\n` } }),
  })
  await fake.run('install')
  assert.ok(fake.execs.some((a) => label(a) === 'install --force'))
  assert.deepEqual(toasts(fake).at(-1), { title: 'mac: install failed', body: bar })
})

test('rotation-toggle turns an enabled rotation off', async () => {
  const fake = await start({ route: engine({ 'status --json': { stdout: JSON.stringify(report()) }, 'set ENABLED 0': {} }) })
  await fake.run('rotation-toggle')
  assert.ok(fake.execs.some((a) => label(a) === 'set ENABLED 0'))
  assert.equal(toasts(fake).at(-1).title, 'mac: rotation off')
})

test('enrol without a terminal asks for one and types nothing', async () => {
  const fake = await start({ context: null })
  await fake.run('enrol')
  assert.equal(toasts(fake).at(-1).title, 'grazr: Open a shell terminal in this worktree first')
  assert.equal(hostCalls(fake, 'terminal.sendText').length, 0)
})

test('enrol on mac types the exact local command without pressing Return', async () => {
  const fake = await start({ context: { branch: 'main', displayName: 'x', terminals: [{ id: 't1' }] } })
  await fake.run('enrol')
  assert.deepEqual(hostCalls(fake, 'terminal.sendText'), [{
    terminalId: 't1',
    enter: false,
    text: 'GRAZR_STATE_DIR=/home/t/.local/state/orca-grazr GRAZR_CONFIG_DIR=/home/t/.config/orca-grazr GRAZR_NOTIFIER=osascript python3 /home/t/.local/share/orca-grazr/engine/grazr.py enrol',
  }])
})

test('enrol on a remote target types an ssh command that runs the engine', async () => {
  const fake = await start({
    stored: { target: 'devbox-2' },
    context: { branch: 'main', displayName: 'x', terminals: [{ id: 't1' }] },
  })
  await fake.run('enrol')
  const [sent] = hostCalls(fake, 'terminal.sendText')
  const settings = fixtureSettings()
  const remote = settings.hosts.find((h) => h.name === 'devbox-2')
  const inner = createRunner({ settings, exec: async () => ({}), homedir: () => '/home/t' }).command(remote, ['enrol']).argv.at(-1)
  assert.equal(sent.text, `ssh -t devbox-2 ${quote(inner)}`)
  assert.ok(sent.text.includes('grazr.py enrol'))
  assert.equal(sent.enter, false)
})

test('enrol types into the newest terminal of the worktree and says so', async () => {
  const fake = await start({ context: { branch: 'main', displayName: 'x', terminals: [{ id: 'agent' }, { id: 'shell' }] } })
  await fake.run('enrol')
  assert.equal(hostCalls(fake, 'terminal.sendText')[0].terminalId, 'shell')
  assert.ok(toasts(fake).at(-1).title.startsWith('grazr: Typed into the newest terminal of this worktree'))
})

test('status-terminal types the status command into the worktree terminal', async () => {
  const fake = await start({ context: { branch: 'main', displayName: 'x', terminals: [{ id: 't9' }] } })
  await fake.run('status-terminal')
  const [sent] = hostCalls(fake, 'terminal.sendText')
  assert.equal(sent.terminalId, 't9')
  assert.ok(sent.text.endsWith('grazr.py status'))
  assert.equal(sent.enter, false)
})

test('a budget expiry during deploy stops the sequence and says install may still be finishing', async () => {
  const timers = fakeTimers()
  let fired = false
  const route = (argv, opts) => {
    // The budget expires while rsync is in flight; the engine install must then never start.
    if (argv[0] === '/usr/bin/rsync' && !fired) {
      fired = true
      timers.armed.find((t) => t.ms === 25000).fn()
    }
    return engine({ install: { stdout: 'installed\n' } })(argv, opts)
  }
  const fake = await start({ timers, route })
  await fake.run('install')
  assert.ok(!fake.execs.some((a) => label(a) === 'install'))
  assert.deepEqual(toasts(fake).at(-1), {
    title: 'mac: install timed out',
    body: 'install may still be finishing; run Grazr: Status (all hosts) to check',
  })
})

test('activation still registers all fourteen commands when settings.get rejects', async () => {
  const fake = await start({ rejectSettingsGet: true })
  assert.equal(fake.commands.size, 14)
  assert.equal(fake.handlers.size, 2)
  assert.ok(fake.logs.some((m) => m.includes('settings host unavailable')))
})

test('a command falls back to defaults with a log line when settings.get fails later', async () => {
  const fake = await start({})
  fake.flags.rejectSettingsGet = true
  await assert.doesNotReject(fake.run('target-next'))
  assert.equal(toasts(fake).at(-1).title, 'grazr: Target: mac (1/1)')
  assert.ok(fake.logs.some((m) => m.includes('using defaults')))
})

test('drain-now drains only the hosts in the current settings', async () => {
  const hosts = [
    { name: 'devbox', ssh: 'devbox', python: 'python3', notifier: 'queue' },
    { name: 'devbox-2', ssh: 'devbox-2', python: 'python3', notifier: 'queue' },
  ]
  const fake = await start({ stored: { hosts }, route: engine({ 'notices-drain': { stdout: '' } }) })
  fake.state.settings.hosts = [hosts[0]]
  await fake.run('drain-now')
  const drained = fake.execs.filter((a) => label(a) === 'notices-drain')
  assert.equal(drained.length, 1)
  assert.ok(drained[0].includes('devbox'))
  assert.ok(!drained[0].includes('devbox-2'))
})

test('drain-now forces a drain and reports drained', async () => {
  const fake = await start({ route: engine({ 'notices-drain': { stdout: '' } }) })
  await fake.run('drain-now')
  assert.ok(fake.execs.some((a) => label(a) === 'notices-drain'))
  assert.equal(toasts(fake).at(-1).title, 'grazr: drained')
})

test('events start the drain loop once and a second event leaves it running', async () => {
  const timers = fakeTimers()
  const fake = await start({ stored: { drainEnabled: true }, timers })
  await fake.handlers.get('agent.status.changed')({ state: 'idle' })
  assert.equal(fake.plugin.drain.isRunning(), true)
  const armedAfterFirst = timers.armed.length
  await fake.handlers.get('workspace.created')({ workspaceId: 'w', kind: 'worktree', path: '/p', branch: 'main' })
  assert.equal(timers.armed.length, armedAfterFirst)
})

test('events leave the drain loop stopped when drainEnabled is false', async () => {
  const fake = await start({ stored: { drainEnabled: false } })
  await fake.handlers.get('agent.status.changed')({ state: 'idle' })
  assert.equal(fake.plugin.drain.isRunning(), false)
  assert.ok(fake.logs.some((m) => m.includes('drainEnabled is false')))
})

test('activation starts the drain loop when drainEnabled', async () => {
  const fake = await start({ stored: { drainEnabled: true } })
  assert.equal(fake.plugin.drain.isRunning(), true)
})

test('a command that throws becomes a grazr toast and never rejects', async () => {
  const fake = await start({
    route: engine({ swap: () => { throw new Error('boom') } }),
  })
  await assert.doesNotReject(fake.run('swap'))
  assert.ok(toasts(fake).at(-1).title.startsWith('grazr: '))
  assert.ok(fake.logs.some((m) => m.includes('boom')))
})

test('activation regenerates the panel from every host and writes it once', async () => {
  const fake = await start({ route: statusRoute() })
  assert.equal(fake.activation.filter((a) => label(a) === 'status --json').length, 3)
  assert.deepEqual(fake.fs.renames, [PANEL])
  assert.ok(fake.fs.files.get(PANEL).includes('work'))
})

test('panel-refresh writes nothing when the report is unchanged and toasts panel unchanged', async () => {
  const fake = await start({ route: statusRoute() })
  await fake.run('panel-refresh')
  assert.deepEqual(fake.fs.renames, [PANEL])
  assert.equal(toasts(fake).at(-1).title, 'grazr: panel unchanged')
})

test('status writes the panel from the results it just collected', async () => {
  let current = report()
  const fake = await start({ route: engine({ 'status --json': () => ({ stdout: JSON.stringify(current) }) }) })
  current = report({ accounts: [{ name: 'work', id: 'a1', snapshot: [{ kind: 'session', scope: null, group: 'session', remaining: 10 }] }] })
  await fake.run('status')
  assert.equal(statusExecs(fake), 3)
  assert.equal(fake.fs.renames.length, 2)
  assert.ok(fake.fs.files.get(PANEL).includes('10% left'))
})

test('swap and target-next regenerate the panel afterwards', async () => {
  const fake = await start({ route: statusRoute({ swap: { stdout: 'swapped\n' } }) })
  await fake.run('swap')
  assert.equal(statusExecs(fake), 3)
  await fake.run('target-next')
  assert.equal(statusExecs(fake), 6)
})

test("commandText builds swap <name> with the name quoted", async () => {
  const account = "o'brien $x"
  const extra = {
    ...report(),
    order: ['work', account],
    accounts: [
      ...report().accounts,
      { id: 'a2', name: account, parked: true, blocked: null, snapshot: [{ kind: 'session', scope: null, group: 'session', remaining: 80 }] },
    ],
  }
  const fake = await start({ route: engine({ 'status --json': { stdout: JSON.stringify(extra) } }) })
  await fake.run('panel-refresh')
  assert.ok(fake.fs.files.get(PANEL).includes("grazr.py swap &#39;o&#39;\\&#39;&#39;brien $x&#39;"))
})

test('a panel write failure is logged and the command still toasts', async () => {
  const fake = await start({ route: statusRoute(), fs: fakeFs({ write: 'ENOSPC' }) })
  await fake.run('target-next')
  assert.equal(toasts(fake).at(-1).title, 'grazr: Target: devbox (2/3)')
  assert.ok(fake.logs.includes('grazr: panel write failed: ENOSPC'))
})

test('panel-refresh in an installed plugin toasts that the panel is not writable', async () => {
  const fake = await start({ route: statusRoute(), fs: fakeFs({ write: 'EROFS' }) })
  await fake.run('panel-refresh')
  assert.equal(toasts(fake).at(-1).title, 'grazr: panel not writable (installed plugin)')
})

test('an installed plugin never writes its panel, even when the location would take a write', async () => {
  const fake = await start({ route: statusRoute(), fs: fakeFs({ dev: false }) })
  await fake.run('panel-refresh')
  assert.deepEqual(fake.fs.renames, [])
  assert.equal(toasts(fake).at(-1).title, 'grazr: panel not writable (installed plugin)')
})

test('a panel refresh that cannot read the template logs it and the command still toasts', async () => {
  const fake = await start({ route: statusRoute(), fs: fakeFs({ noTemplate: true }) })
  await assert.doesNotReject(fake.run('panel-refresh'))
  assert.equal(toasts(fake).at(-1).title, 'grazr: panel refresh failed')
  assert.ok(fake.logs.some((m) => m.startsWith('grazr: panel refresh failed: ')))
})

test('status still refreshes the panel when the lastStatus save fails, and the failure is logged', async () => {
  let current = report()
  const fake = await start({
    rejectStorageSet: true,
    route: engine({ 'status --json': () => ({ stdout: JSON.stringify(current) }) }),
  })
  current = report({ accounts: [{ name: 'work', id: 'a1', snapshot: [{ kind: 'session', scope: null, group: 'session', remaining: 10 }] }] })
  await assert.doesNotReject(fake.run('status'))
  assert.ok(fake.logs.includes('grazr: lastStatus not saved: storage full'))
  assert.equal(fake.fs.renames.length, 2)
  assert.ok(fake.fs.files.get(PANEL).includes('10% left'))
})

test('drain-now with the command budget spent skips the panel refresh and logs it', async () => {
  const clock = { t: 1000 }
  const route = engine({
    'notices-drain': () => {
      clock.t += 26000
      return { stdout: '' }
    },
  })
  const fake = await start({ route, now: () => clock.t })
  const before = statusExecs(fake)
  await fake.run('drain-now')
  assert.equal(statusExecs(fake), before)
  assert.ok(fake.logs.includes('grazr: panel refresh skipped, no budget left'))
  assert.equal(toasts(fake).at(-1).title, 'grazr: drained')
})
