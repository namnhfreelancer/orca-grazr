import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const engine = resolve(root, 'engine')

const VENDORED_FILES = [
  'grazr.py',
  'claude.py',
  'core.py',
  'accounts.py',
  'stores.py',
  'atomic.py',
  'pins.py',
  'shim.py',
  'LICENSE',
  'VENDORED.md',
]

test('every vendored engine file is present', async () => {
  for (const file of VENDORED_FILES) {
    await access(resolve(engine, file))
  }
})

test('the vendored engine is version 0.4.7+fork.10', async () => {
  const source = await readFile(resolve(engine, 'grazr.py'), 'utf8')
  assert.ok(source.includes('VERSION = "0.4.7+fork.10"'))
})
