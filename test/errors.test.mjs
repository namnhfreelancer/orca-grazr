import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeFailure } from '../lib/errors.mjs'

const base = {
  code: null,
  signal: null,
  stdout: '',
  stderr: '',
  timedOut: false,
  spawnError: null,
  host: 'mac',
  remote: false,
  timeoutMs: 5000,
}

const enoent = () => Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' })

test('timeout is reported with the timeout in seconds', () => {
  assert.deepEqual(describeFailure({ ...base, timedOut: true }), {
    kind: 'timeout',
    detail: 'timed out after 5s',
  })
})

test('ENOENT spawn error is a missing binary named by the error message', () => {
  assert.deepEqual(describeFailure({ ...base, spawnError: enoent() }), {
    kind: 'missing-binary',
    detail: 'spawn ssh ENOENT',
  })
})

test('a non-ENOENT spawn error is reported with its own message', () => {
  const eacces = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })
  assert.deepEqual(describeFailure({ ...base, spawnError: eacces }), {
    kind: 'exit',
    detail: 'spawn EACCES',
  })
})

test('exit 127 is a missing binary named by the first stderr line', () => {
  assert.deepEqual(
    describeFailure({ ...base, code: 127, stderr: 'zsh: command not found: python3\nmore\n' }),
    { kind: 'missing-binary', detail: 'zsh: command not found: python3' },
  )
})

test('exit 255 on a remote host is unreachable, named by the last stderr line', () => {
  assert.deepEqual(
    describeFailure({
      ...base,
      remote: true,
      host: 'devbox',
      code: 255,
      stderr: 'Warning: noise\nssh: connect to host devbox port 22: Operation timed out\n\n',
    }),
    {
      kind: 'unreachable',
      detail: 'ssh: connect to host devbox port 22: Operation timed out',
    },
  )
})

test('exit 255 on a local host is a generic exit', () => {
  assert.deepEqual(describeFailure({ ...base, code: 255, stderr: 'boom\n' }), {
    kind: 'exit',
    detail: 'exit 255: boom',
  })
})

test('a grazr: line on stdout is an engine failure without its prefix', () => {
  assert.deepEqual(
    describeFailure({
      ...base,
      code: 1,
      stdout: 'working\ngrazr: no account is enrolled\n',
      stderr: 'Traceback (most recent call last)\n',
    }),
    { kind: 'engine', detail: 'no account is enrolled' },
  )
})

test('a grazr: line on stdout is preferred over one on stderr', () => {
  assert.deepEqual(
    describeFailure({
      ...base,
      code: 1,
      stdout: 'grazr: from stdout\n',
      stderr: 'grazr: from stderr\n',
    }),
    { kind: 'engine', detail: 'from stdout' },
  )
})

test('a grazr: line beats the generic exit detail', () => {
  assert.equal(describeFailure({ ...base, code: 2, stderr: 'grazr: bad state\n' }).kind, 'engine')
})

test('a generic non-zero exit names the code and last stderr line', () => {
  assert.deepEqual(describeFailure({ ...base, code: 2, stderr: 'a\nlast line\n' }), {
    kind: 'exit',
    detail: 'exit 2: last line',
  })
})

test('a generic exit falls back to the last stdout line when stderr is empty', () => {
  assert.deepEqual(describeFailure({ ...base, code: 3, stdout: 'partial\n' }), {
    kind: 'exit',
    detail: 'exit 3: partial',
  })
})

test('timeout beats every other signal', () => {
  assert.equal(
    describeFailure({ ...base, timedOut: true, code: 127, spawnError: enoent(), stdout: 'grazr: x' }).kind,
    'timeout',
  )
})

test('exit 2 with "can\'t open file" means the engine is not installed on that host', () => {
  const stderr = "python3: can't open file '/h/.local/share/orca-grazr/engine/grazr.py': [Errno 2] No such file or directory\n"
  assert.deepEqual(describeFailure({ ...base, code: 2, remote: true, stderr }), {
    kind: 'not-installed',
    detail: "python3: can't open file '/h/.local/share/orca-grazr/engine/grazr.py': [Errno 2] No such file or directory",
  })
})

test('other exit 2 failures stay plain exit failures', () => {
  assert.equal(describeFailure({ ...base, code: 2, stderr: 'usage: grazr\n' }).kind, 'exit')
})
