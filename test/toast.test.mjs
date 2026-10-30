import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TITLE_MAX, BODY_MAX, clamp, toast, formatStatus, formatFailure, failureBody } from '../lib/toast.mjs'

const fullReport = {
  installed: true,
  connection: {
    statusline: true,
    failure_hook: true,
    foreign: { statusline: null, failure_hook: null },
  },
  active: { id: 'a1', name: 'work', enrolled: true, in_order: true },
  accounts: [
    {
      id: 'a2',
      name: 'home',
      email: 'home@example.com',
      parked: false,
      snapshot: [
        { kind: 'session', group: 'session', remaining: 60 },
        { kind: 'weekly', group: 'weekly', remaining: 90 },
      ],
      blocked: null,
      in_order: true,
      first_reading_due: false,
    },
    {
      id: 'a1',
      name: 'work',
      email: 'work@example.com',
      parked: false,
      snapshot: [
        { kind: 'session', group: 'session', remaining: 42 },
        { kind: 'weekly', group: 'weekly', remaining: 80 },
      ],
      blocked: null,
      in_order: true,
      first_reading_due: false,
    },
    {
      id: 'a3',
      name: 'spare',
      email: 'spare@example.com',
      parked: true,
      snapshot: [{ kind: 'session', group: 'session', remaining: 0 }],
      blocked: null,
      in_order: false,
      first_reading_due: false,
    },
  ],
  order: ['work', 'home'],
  settings: { enabled: true },
  blocked: {},
  changed_at: null,
  last_rotation: null,
  last_reported: null,
  managed_profile: null,
  version: '0.1.0',
}

test('clamp returns text of exactly max length unchanged', () => {
  assert.equal(clamp('abc', 3), 'abc')
})

test('clamp truncates text one over max with a trailing ellipsis', () => {
  const out = clamp('abcd', 3)
  assert.equal(out, 'ab…')
  assert.equal(out.length, 3)
})

test('clamp returns the empty string for non-string input', () => {
  assert.equal(clamp(42, 3), '')
  assert.equal(clamp(undefined, 3), '')
})

test('toast prefixes the title with the host name', () => {
  assert.deepEqual(toast('mac', 'Rotated'), { title: 'mac: Rotated', body: '' })
})

test('toast clamps the title to TITLE_MAX', () => {
  assert.equal(toast('h', 'x'.repeat(200)).title.length, TITLE_MAX)
})

test('toast clamps the body to BODY_MAX', () => {
  assert.equal(toast('h', 't', 'x'.repeat(2000)).body.length, BODY_MAX)
})

test('formatStatus renders the active account, usage lines and rotation state', () => {
  assert.deepEqual(formatStatus('mac', fullReport), {
    title: 'mac: work',
    body: [
      'rotation on',
      '* work S:42% W:80%',
      'home S:60% W:90%',
      'spare S:0% (parked)',
    ].join('\n'),
  })
})

test('formatStatus does not throw on an empty report', () => {
  assert.deepEqual(formatStatus('mac', {}), { title: 'mac: no account', body: '' })
})

test('formatStatus appends each account blocked reason and skips the empty top-level dict', () => {
  const report = {
    blocked: {},
    active: { id: 'a1', name: 'work' },
    accounts: [{ id: 'a1', name: 'work', snapshot: [{ kind: 'session', remaining: 40 }], blocked: 'usage exhausted' }],
    connection: { foreign: { statusline: '/home/x/.claude' } },
  }
  assert.equal(
    formatStatus('mac', report).body,
    '* work S:40% blocked: usage exhausted\nforeign statusLine: /home/x/.claude',
  )
})

test('formatStatus never prints the top-level blocked dict', () => {
  const body = formatStatus('mac', { ...fullReport, blocked: { a2: { reason: 'usage', at: 1, until: 2 } } }).body
  assert.ok(!body.includes('blocked'))
  assert.ok(!body.includes('object'))
})

test('formatStatus rounds usage percentages to whole numbers', () => {
  const report = { active: { id: 'a1', name: 'work' }, accounts: [{ id: 'a1', name: 'work', snapshot: [{ kind: 'session', remaining: 42.010000000000005 }] }] }
  assert.equal(formatStatus('mac', report).body, '* work S:42%')
})

test('formatFailure names the command in the title and labels the kind in the body', () => {
  assert.deepEqual(
    formatFailure('devbox', { kind: 'timeout', detail: 'timed out after 5s' }, 'swap'),
    { title: 'devbox: swap failed', body: 'timeout: timed out after 5s' },
  )
})

test('formatFailure shows an engine line as written, without a kind label', () => {
  assert.equal(formatFailure('mac', { kind: 'engine', detail: 'no second account' }, 'install').body, 'no second account')
  assert.equal(failureBody({ kind: 'engine', detail: 'x' }), 'x')
})

test('formatFailure clamps the body', () => {
  assert.equal(formatFailure('h', { kind: 'exit', detail: 'x'.repeat(2000) }, 'status').body.length, BODY_MAX)
})
