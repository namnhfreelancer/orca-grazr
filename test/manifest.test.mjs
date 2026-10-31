import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(resolve(root, 'orca-plugin.json'), 'utf8'))

test('manifest identifies the grazr plugin', () => {
  assert.equal(manifest.id, 'grazr')
  assert.equal(manifest.publisher, 'senadaruc')
})

test('manifest declares exactly twelve commands with unique ids', () => {
  const ids = manifest.contributes.commands.map((c) => c.id)
  assert.equal(ids.length, 12)
  assert.equal(new Set(ids).size, 12)
})

test('only enrol and status-terminal are worktree-scoped', () => {
  const scoped = manifest.contributes.commands
    .filter((c) => c.when === 'workspace')
    .map((c) => c.id)
    .sort()
  assert.deepEqual(scoped, ['enrol', 'status-terminal'])
})

test('manifest is format 2, trusted-worker, MIT, and needs Orca 1.4.245 or later', () => {
  assert.equal(manifest.manifestVersion, 2)
  assert.equal(manifest.execution, 'trusted-worker')
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.engines.orca, '>=1.4.245')
})

test('manifest requests the six v2 capabilities; commands:execute is not requested', () => {
  const kinds = manifest.capabilities.map((c) => c.kind)
  assert.deepEqual(
    [...kinds].sort(),
    ['agent:read', 'notifications:show', 'settings:own', 'storage:own', 'terminal:send', 'workspace:read'],
  )
})

test('manifest subscribes to agent status and workspace creation, each covered by a capability', () => {
  const events = manifest.contributes.events.map((e) => e.on).sort()
  assert.deepEqual(events, ['agent.status.changed', 'workspace.created'])
  assert.ok(manifest.capabilities.some((c) => c.kind === 'agent:read'))
  assert.ok(manifest.capabilities.some((c) => c.kind === 'workspace:read'))
})

test('manifest declares the accounts panel and the panel-refresh command', () => {
  assert.deepEqual(manifest.contributes.panels, [
    { id: 'accounts', title: 'Claude Accounts', icon: 'gauge', entry: 'panel/accounts.html' },
  ])
  assert.ok(manifest.contributes.commands.some((c) => c.id === 'panel-refresh' && c.title === 'Grazr: Refresh panel'))
})

test('manifest and package declare version 0.6.9', async () => {
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  assert.equal(manifest.version, '0.6.9')
  assert.equal(pkg.version, '0.6.9')
})

