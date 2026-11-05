import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claudePanes, createSessionMover, relaunchLine, LOCAL_GRACE_MS } from '../lib/orca-session-mover.mjs'

const OLD = 'aaaaaaaa-0000-4000-8000-000000000001'
const NEW = 'bbbbbbbb-0000-4000-8000-000000000002'
const SESSION = '6fedc3b8-0936-43fe-9a65-8f2138dbe246'
const VPS = { name: 'VPS', orcaEnvironment: 'VPS' }
const MAC = { name: 'mac', orcaEnvironment: null }
const VALUE = { accounts: [{ id: OLD, name: 'old@example.com' }, { id: NEW, name: 'new@example.com' }] }

const pane = ({ handle = 'term_1', state = 'done', account = OLD, session = SESSION } = {}) => ({
  type: 'terminal',
  title: `pane ${handle}`,
  agentStatus: {
    agentType: 'claude',
    state,
    terminalHandle: handle,
    providerSession: { id: session, transcriptPath: `/home/u/.config/orca/claude-profiles/${account}/home/projects/-w/${session}.jsonl` },
  },
})

// A host whose panes run Claude until /exit reaches them; sends are recorded in order.
function fakeHost(tabs, { exits = true, launch = { agentDefaultArgs: { claude: '--dangerously-skip-permissions' }, agentCmdOverrides: {} } } = {}) {
  const running = new Map(tabs.map((t) => [t.agentStatus.terminalHandle, true]))
  const sends = []
  const rpc = async (h, method, params) => {
    if (method === 'session.tabs.listAll') return { ok: true, result: { snapshots: [{ tabs }] } }
    if (method === 'settings.getAgentLaunch') return { ok: true, result: { settings: launch } }
    if (method === 'terminal.agentStatus') {
      const on = running.get(params.terminal) ?? false
      return { ok: true, result: { agentStatus: { isRunningAgent: on, status: on ? 'idle' : null } } }
    }
    if (method === 'terminal.send') {
      sends.push({ host: h.name, ...params })
      if (params.text === '/exit' && exits) running.set(params.terminal, false)
      if (params.text?.startsWith('claude ')) running.set(params.terminal, true)
      return { ok: true, result: {} }
    }
    return { ok: false, failure: { kind: 'engine', detail: method } }
  }
  return { rpc, sends, running }
}

function storage(initial = {}) {
  const data = structuredClone(initial)
  return { data, get: async (k) => data[k], set: async (k, v) => { data[k] = structuredClone(v) } }
}

const clock = (start = 1_000_000) => {
  let t = start
  return { now: () => t, sleep: async (ms) => { t += ms }, advance: (ms) => { t += ms } }
}

test('the panes are read from Orca’s tab snapshots, with the account their transcript lives under', () => {
  const panes = claudePanes({ snapshots: [{ tabs: [pane(), { type: 'terminal', agentStatus: null }, pane({ handle: 'term_2', session: 'bad id;rm' })] }] })
  assert.deepEqual(panes.map((p) => [p.handle, p.state, p.accountId, p.sessionId]), [['term_1', 'done', OLD, SESSION], ['term_2', 'done', OLD, null]])
})

test('the relaunch uses Orca’s Claude command and default args', () => {
  assert.equal(relaunchLine({ agentDefaultArgs: { claude: '--dangerously-skip-permissions' } }, SESSION), `claude --dangerously-skip-permissions --resume ${SESSION}`)
  assert.equal(relaunchLine({ agentCmdOverrides: { claude: '/opt/claude' }, agentDefaultArgs: { claude: '' } }, SESSION), `/opt/claude --resume ${SESSION}`)
  assert.equal(relaunchLine(null, SESSION), `claude --resume ${SESSION}`)
})

test('an idle pane on the old account is exited and resumed on a paired environment', async () => {
  const host = fakeHost([pane()])
  const c = clock()
  const store = storage()
  const mover = createSessionMover({ rpc: host.rpc, storage: store, now: c.now, sleep: c.sleep })
  const lines = await mover.move(VPS, VALUE, { activeId: NEW })
  assert.deepEqual(host.sends.map((s) => s.text ?? (s.interrupt ? '^C' : '')), ['^C', '/exit', `claude --dangerously-skip-permissions --resume ${SESSION}`])
  assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ title: 'grazr: sessions moved', body: '1 Claude session resumed on new@example.com' }])
  assert.deepEqual(store.data.orcaPendingRelaunch, {})
})

test('a busy pane, a pane on the selected account and one already tried are left alone', async () => {
  const host = fakeHost([pane({ handle: 'busy', state: 'working' }), pane({ handle: 'current', account: NEW }), pane({ handle: 'tried' })])
  const c = clock()
  const store = storage({ orcaRestartAttempts: { 'VPS\u0000tried': { sessionId: SESSION, at: c.now() - 60000 } } })
  const mover = createSessionMover({ rpc: host.rpc, storage: store, now: c.now, sleep: c.sleep })
  assert.deepEqual(await mover.move(VPS, VALUE, { activeId: NEW }), [])
  assert.deepEqual(host.sends, [])
})

test('on this Mac, Orca’s own restart gets its grace after a swap first', async () => {
  const host = fakeHost([pane()])
  const c = clock()
  const mover = createSessionMover({ rpc: host.rpc, storage: storage(), now: c.now, sleep: c.sleep })
  assert.deepEqual(await mover.move(MAC, VALUE, { activeId: NEW, lastRotationAt: c.now() - 1000 }), [])
  assert.deepEqual(host.sends, [])
  c.advance(LOCAL_GRACE_MS)
  assert.equal((await mover.move(MAC, VALUE, { activeId: NEW, lastRotationAt: c.now() - LOCAL_GRACE_MS - 1000 })).length, 1)
  assert.equal(host.sends.at(-1).text, `claude --dangerously-skip-permissions --resume ${SESSION}`)
})

test('a pane that does not exit is reported, keeps its pending line, and a later tick relaunches it at its shell', async () => {
  const host = fakeHost([pane()], { exits: false })
  const c = clock()
  const store = storage()
  const mover = createSessionMover({ rpc: host.rpc, storage: store, now: c.now, sleep: c.sleep })
  const lines = await mover.move(VPS, VALUE, { activeId: NEW })
  assert.equal(JSON.parse(lines[0]).title, 'grazr: session not moved')
  assert.ok(store.data.orcaPendingRelaunch['VPS\u0000term_1'])
  // Claude exits later (the user, or a slow /exit); the next tick types the stored line, and only once.
  host.running.set('term_1', false)
  await mover.move(VPS, VALUE, { activeId: NEW })
  assert.equal(host.sends.at(-1).text, `claude --dangerously-skip-permissions --resume ${SESSION}`)
  assert.deepEqual(store.data.orcaPendingRelaunch, {})
})

test('a pane a usage limit stopped is resumed with the continue prompt, on this Mac without waiting out the grace', async () => {
  const host = fakeHost([pane()])
  const c = clock()
  const mover = createSessionMover({ rpc: host.rpc, storage: storage(), now: c.now, sleep: c.sleep })
  const panes = claudePanes({ snapshots: [{ tabs: [pane()] }] }).map((p) => ({ ...p, limited: true }))
  const lines = await mover.move(MAC, VALUE, { activeId: NEW, lastRotationAt: c.now() - 1000, panes })
  assert.equal(lines.length, 1)
  assert.equal(host.sends.at(-1).text, `claude --dangerously-skip-permissions --resume ${SESSION} 'Continue where you left off.'`)
})
