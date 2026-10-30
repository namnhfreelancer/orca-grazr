import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { pluginRoot } from '../lib/plugin-root.mjs'

test('pluginRoot is the directory above the lib directory of the given module', () => {
  assert.equal(pluginRoot(pathToFileURL('/a/b/lib/plugin-root.mjs').href), '/a/b')
})

test('pluginRoot defaults to the repository root', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  assert.equal(pluginRoot(), repoRoot)
})
