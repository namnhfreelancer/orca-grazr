import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readBundledVersion, isNewerEngine } from '../lib/engine-version.mjs'

const ROOT = '/plug'
const ENGINE = `${ROOT}/engine/grazr.py`

// An fs that serves one file, or fails with ENOENT for any other path.
function fsWith(files) {
  return {
    async readFile(path) {
      if (files.has(path)) return files.get(path)
      const error = new Error(`ENOENT: no such file or directory, open '${path}'`)
      error.code = 'ENOENT'
      throw error
    },
  }
}

test('readBundledVersion parses the VERSION line of the bundled engine', async () => {
  const fs = fsWith(new Map([[ENGINE, '#!/usr/bin/env python3\n"""Grazr."""\nVERSION = "0.4.7+fork.10"\nprint(VERSION)\n']]))
  assert.equal(await readBundledVersion({ root: ROOT, fs }), '0.4.7+fork.10')
})

test('readBundledVersion rejects naming the path when the engine file is missing', async () => {
  await assert.rejects(readBundledVersion({ root: ROOT, fs: fsWith(new Map()) }), (err) => {
    assert.ok(err instanceof Error)
    assert.ok(err.message.includes(ENGINE), err.message)
    return true
  })
})

test('readBundledVersion rejects naming the path when the engine has no VERSION line', async () => {
  const fs = fsWith(new Map([[ENGINE, 'print("no version here")\n']]))
  await assert.rejects(readBundledVersion({ root: ROOT, fs }), (err) => {
    assert.ok(err.message.includes(ENGINE), err.message)
    return true
  })
})

test('isNewerEngine is true only when the bundled release is newer, compared numerically', () => {
  assert.equal(isNewerEngine('0.4.7+fork.11', '0.4.7+fork.10'), true)
  assert.equal(isNewerEngine('0.4.7+fork.10', '0.4.7+fork.11'), false, 'an installed fork newer than the bundled one shows nothing')
  assert.equal(isNewerEngine('0.4.7+fork.11', '0.4.7+fork.11'), false)
  assert.equal(isNewerEngine('0.4.10+fork.1', '0.4.9+fork.99'), true, 'patch 10 is newer than 9, not compared as text')
  assert.equal(isNewerEngine('0.4.9+fork.1', '0.4.10+fork.1'), false)
  assert.equal(isNewerEngine('0.10.0', '0.9.9+fork.5'), true, 'minor 10 is newer than 9')
  assert.equal(isNewerEngine('1.0.0', '0.99.99+fork.99'), true)
  assert.equal(isNewerEngine('0.4.7+fork.1', '0.4.7'), true, 'a fork suffix is newer than none')
  assert.equal(isNewerEngine('0.4.7', '0.4.7+fork.1'), false, 'no suffix is older than a fork of the same release')
})

test('isNewerEngine is never true for a version it cannot parse, or a missing one', () => {
  assert.equal(isNewerEngine(null, '0.4.7+fork.1'), false)
  assert.equal(isNewerEngine('0.4.7+fork.2', null), false)
  assert.equal(isNewerEngine('0.4.7+fork.2', 'nightly'), false)
  assert.equal(isNewerEngine('weird', '0.4.7'), false)
  assert.equal(isNewerEngine('0.4.7+fork.2', 7), false)
})
