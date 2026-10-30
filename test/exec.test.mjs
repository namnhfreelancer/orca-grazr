import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execCapture } from '../lib/exec.mjs'

const node = process.execPath

test('execCapture reports exit code and stdout of a finished process', async () => {
  const r = await execCapture([node, '-e', 'process.stdout.write("hi");process.exit(3)'])
  assert.equal(r.code, 3)
  assert.equal(r.stdout, 'hi')
  assert.equal(r.timedOut, false)
  assert.equal(r.spawnError, null)
})

test('execCapture kills a process that outlives its timeout', async () => {
  const started = Date.now()
  const r = await execCapture([node, '-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 })
  assert.ok(Date.now() - started < 4000, 'should resolve well before the script sleeps')
  assert.equal(r.timedOut, true)
  assert.ok(['SIGTERM', 'SIGKILL'].includes(r.signal), `unexpected signal ${r.signal}`)
})

test('execCapture reports a missing binary as a spawn error, not a rejection', async () => {
  const r = await execCapture(['/nonexistent/bin/xyz'])
  assert.equal(r.spawnError.code, 'ENOENT')
  assert.equal(r.code, null)
})

test('execCapture delivers input to the child stdin', async () => {
  const echo = 'process.stdin.pipe(process.stdout)'
  const r = await execCapture([node, '-e', echo], { input: 'ping' })
  assert.equal(r.stdout, 'ping')
  assert.equal(r.code, 0)
})
