import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mergeSettings } from '../lib/hosts.mjs'
import { createOrcaRunner, forgetSharedReadings } from '../lib/orca-accounts.mjs'
import { relaunchLine, showsUsageLimit } from '../lib/orca-session-mover.mjs'

const require = createRequire(import.meta.url)
const { cutOf, canonicalize, workingTasks } = require('../lib/orca-chat-helper.cjs')

const NOW = Date.parse('2026-11-05T06:00:00Z')
const HOUR = 3600000
const A = { id: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'a@example.com' }
const B = { id: 'bbbbbbbb-0000-4000-8000-000000000002', email: 'b@example.com' }
const TURN = 'legacy:claude:x:turn-lifecycle%3A1'
const usage = (sessionUsed, weeklyUsed = 10) => ({
  session: { usedPercent: sessionUsed, windowMinutes: 300, resetsAt: NOW + HOUR },
  weekly: { usedPercent: weeklyUsed, windowMinutes: 10080, resetsAt: NOW + 48 * HOUR },
  updatedAt: NOW,
})

const limitedPage = (over = {}) => ({
  sessionId: 'claude_s1',
  working: false,
  fence: 4,
  submissions: [],
  latestTurn: { itemId: TURN, turn: { state: 'completed', completedAt: NOW - 1000 } },
  items: [
    { itemId: 'm1', turnScope: { kind: 'turn', turnItemId: TURN }, body: { kind: 'message', role: 'assistant' } },
    { itemId: 's1', turnScope: { kind: 'turn', turnItemId: TURN }, body: { kind: 'status', failure: { kind: 'usageLimitReached', usageLimit: { window: 'session', resetsAt: NOW + HOUR } } } },
  ],
  ...over,
})

test('a chat whose latest turn a usage limit ended, with nothing sent since, is a cut', () => {
  assert.deepEqual(cutOf(limitedPage()), { sessionId: 'claude_s1', turnItemId: TURN, fence: 4, window: 'session', resetsAt: NOW + HOUR, endedAt: NOW - 1000 })
})

test('a working chat, a pending send, a running turn or an older limit row is not a cut', () => {
  assert.equal(cutOf(limitedPage({ working: true })), null)
  assert.equal(cutOf(limitedPage({ submissions: [{ clientMessageId: 'x', dispatchState: 'unknown' }] })), null)
  assert.equal(cutOf(limitedPage({ latestTurn: { itemId: TURN, turn: { state: 'running' } } })), null)
  assert.equal(cutOf(limitedPage({ latestTurn: { itemId: 'legacy:claude:x:turn-lifecycle%3A2', turn: { state: 'completed' } } })), null)
})

test('a settled submission does not block the cut; one still in flight does', () => {
  assert.notEqual(cutOf(limitedPage({ submissions: [{ clientMessageId: 'x', dispatchState: 'accepted', resolvedAt: NOW }] })), null)
  assert.equal(cutOf(limitedPage({ submissions: [{ clientMessageId: 'x', dispatchState: 'pending' }] })), null)
})

test('the background tasks still working are the ones a move must stop first', () => {
  const page = { backgroundTasks: { tasks: [{ id: 'a', state: 'working' }, { id: 'b', state: 'done' }] } }
  assert.deepEqual(workingTasks(page).map((t) => t.id), ['a'])
  assert.deepEqual(workingTasks({}), [])
})

test('the continue fingerprint canonicalizes keys the way Orca does', () => {
  assert.equal(canonicalize({ b: 1, a: { d: [1, { f: 2, e: undefined }], c: null } }), '{"a":{"c":null,"d":[1,{"f":2}]},"b":1}')
})

test('a usage limit is read only from the pane’s last lines', () => {
  assert.equal(showsUsageLimit('working…\n⎿ 5-hour limit reached ∙ resets 1pm\n❯ '), true)
  assert.equal(showsUsageLimit("You've hit your limit · resets 3pm (Asia/Saigon)\n"), true)
  assert.equal(showsUsageLimit(['we talked about the usage limit reached earlier', ...Array(20).fill('code line')].join('\n')), false)
  assert.equal(showsUsageLimit('all good\n❯ '), false)
})

test('a limited session relaunches with the continue prompt, quoted for the shell', () => {
  assert.equal(relaunchLine({ agentDefaultArgs: { claude: '--x' } }, 'abcdefgh-1', "Continue where you left off."), "claude --x --resume abcdefgh-1 'Continue where you left off.'")
  assert.equal(relaunchLine(null, 'abcdefgh-1', "it's"), "claude --resume abcdefgh-1 'it'\\''s'")
})

// A host answering both helpers: the RPC helper (accounts) and the chat helper (scan, continue).
function fakeHost({ active = A.id, usages = {}, cuts = [] } = {}) {
  const state = { active, sent: [] }
  const exec = async (argv) => {
    const script = argv.find((a) => typeof a === 'string' && a.endsWith('.cjs')) ?? ''
    if (script.endsWith('orca-chat-helper.cjs')) {
      const [command, ...rest] = argv.slice(argv.indexOf(script) + 1)
      if (command === 'scan') return { code: 0, stdout: JSON.stringify({ ok: true, result: { cuts } }), stderr: '' }
      state.sent.push(rest)
      return { code: 0, stdout: JSON.stringify({ ok: true, result: { sent: true } }), stderr: '' }
    }
    const [, , , method, raw] = argv
    if (method === 'accounts.list') {
      const accounts = [A, B]
      return {
        code: 0,
        stdout: JSON.stringify({ ok: true, result: {
          claude: { accounts, activeAccountId: state.active },
          rateLimits: {
            claude: usages[state.active] ?? usage(10),
            inactiveClaudeAccounts: accounts.filter((a) => a.id !== state.active).map((a) => ({ accountId: a.id, rateLimits: usages[a.id] ?? usage(10), updatedAt: NOW })),
          },
        } }),
        stderr: '',
      }
    }
    if (method === 'accounts.selectClaude') {
      state.active = JSON.parse(raw).accountId
      return { code: 0, stdout: '{"ok":true,"result":{}}', stderr: '' }
    }
    return { code: 1, stdout: JSON.stringify({ ok: false, error: { code: 'method_not_found', message: method } }), stderr: '' }
  }
  return { exec, state, cuts }
}

const MAC = { name: 'mac', orcaEnvironment: null, notifier: 'queue' }
const storage = () => {
  const data = {}
  return { data, get: async (k) => data[k], set: async (k, v) => { data[k] = structuredClone(v) } }
}
const runner = (host) => forgetSharedReadings() ?? createOrcaRunner({
  settings: mergeSettings({ mode: 'orca-accounts', orcaAccounts: { restartSessions: 'off' } }),
  exec: host.exec,
  storage: storage(),
  now: () => NOW,
})
const cut = (accountId) => ({ sessionId: 'claude_s1', turnItemId: TURN, fence: 4, accountId, endedAt: NOW - 1000 })

test('a chat that hit the limit on the active account swaps at once, before Orca’s reading crosses the threshold, and continues', async () => {
  // Orca still reads 40% left on A, above the 15% threshold.
  const host = fakeHost({ usages: { [A.id]: usage(60) }, cuts: [cut(A.id)] })
  const result = await runner(host).runLines(MAC, ['notices-drain'])
  assert.equal(host.state.active, B.id)
  assert.deepEqual(host.state.sent, [['claude_s1', TURN]])
  assert.deepEqual(result.lines.map((l) => JSON.parse(l).title), ['grazr: swapped', 'grazr: chats continued'])
  assert.match(JSON.parse(result.lines[0]).body, /usage limit reached/)
})

test('a chat stopped on an account already swapped away from is continued without another swap', async () => {
  const host = fakeHost({ active: B.id, cuts: [cut(A.id)] })
  await runner(host).runLines(MAC, ['notices-drain'])
  assert.equal(host.state.active, B.id)
  assert.equal(host.state.sent.length, 1)
})

test('with every account spent, a stopped chat is not continued', async () => {
  const host = fakeHost({ usages: { [A.id]: usage(100), [B.id]: usage(100) }, cuts: [cut(A.id)] })
  const result = await runner(host).runLines(MAC, ['notices-drain'])
  assert.equal(host.state.active, A.id)
  assert.deepEqual(host.state.sent, [])
  assert.equal(JSON.parse(result.lines[0]).title, 'grazr: no account to swap to')
})

test('a chat is continued once, not on every tick', async () => {
  const host = fakeHost({ active: B.id, cuts: [cut(A.id)] })
  const r = runner(host)
  await r.runLines(MAC, ['notices-drain'])
  await r.runLines(MAC, ['notices-drain'])
  assert.equal(host.state.sent.length, 1)
})

test('a paired environment without an ssh alias has its chats left alone', async () => {
  const host = fakeHost({ active: B.id, cuts: [cut(A.id)] })
  await runner(host).runLines({ name: 'VPS', orcaEnvironment: 'VPS', notifier: 'queue' }, ['notices-drain'])
  assert.deepEqual(host.state.sent, [])
})

test('the helper runs when piped to `node -`, as it is over ssh', async () => {
  const { spawnSync } = await import('node:child_process')
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../lib/orca-chat-helper.cjs', import.meta.url), 'utf8')
  const run = spawnSync(process.execPath, ['-', 'bogus'], { input: source, encoding: 'utf8' })
  assert.equal(JSON.parse(run.stdout.trim()).error.code, 'invalid_argument')
})

test('a chat that keeps stopping at the limit after each continue is left alone after three', async () => {
  const host = fakeHost({ active: B.id })
  const r = runner(host)
  for (let i = 1; i <= 5; i += 1) {
    host.cuts.splice(0, host.cuts.length, { ...cut(A.id), turnItemId: `${TURN}-${i}` })
    await r.runLines(MAC, ['notices-drain'])
  }
  assert.equal(host.state.sent.length, 3)
})
