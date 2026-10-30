import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readBundledVersion } from '../lib/engine-version.mjs'

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
