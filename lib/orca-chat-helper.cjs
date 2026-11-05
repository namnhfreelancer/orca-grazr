'use strict'
// Runs on an Orca host, under that host's own Node, and talks to its runtime over the local socket, where native
// chat calls need no client capabilities (a paired client's calls are refused for them). Dependency-free, so it
// can be piped over ssh to a paired server: `node - <command> ...` with this file on stdin.
//
//   scan <sinceMs>                        Claude chats whose latest turn a usage limit ended, with nothing sent since,
//                                         each with the account its process ran on.
//   continue <sessionId> <turnItemId> <fence>   Send Orca's own usage-limit continue message to one of them.
//
// Prints one JSON line: { ok, result } or { ok: false, error: { code, message } }.
// The cut is found as Orca's latestNativeChatUsageLimitCut finds it, and the continue message, operation id and
// payload fingerprint are built as Orca's usage-limit auto-continue builds them.

const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const CONTINUE_MESSAGE = 'Continue where you left off.'
const HISTORY_ITEMS = 40

const out = (value, code) => {
  process.stdout.write(`${JSON.stringify(value)}\n`)
  process.exitCode = code
}

function userData() {
  if (process.env.ORCA_USER_DATA_PATH) return process.env.ORCA_USER_DATA_PATH
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library/Application Support/orca')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'orca')
}

function rpc(method, params) {
  const meta = JSON.parse(fs.readFileSync(path.join(userData(), 'orca-runtime.json'), 'utf8'))
  const transports = Array.isArray(meta.transports) ? meta.transports : meta.transport ? [meta.transport] : []
  const transport = transports.find((t) => t.kind === 'unix' || t.kind === 'named-pipe')
  if (!transport || !meta.authToken) return Promise.reject(Object.assign(new Error('no local Orca runtime socket'), { code: 'runtime_unavailable' }))
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    const socket = net.createConnection(transport.endpoint)
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(Object.assign(new Error(`${method} timed out`), { code: 'runtime_timeout' }))
    }, 20000)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify({ id, authToken: meta.authToken, method, params })}\n`))
    socket.on('error', (err) => {
      clearTimeout(timer)
      reject(Object.assign(err, { code: 'runtime_unavailable' }))
    })
    socket.on('data', (chunk) => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        const frame = JSON.parse(line)
        if (frame._keepalive || frame.id !== id) continue
        clearTimeout(timer)
        socket.end()
        if (frame.ok === false) reject(Object.assign(new Error(frame.error?.message ?? 'refused'), { code: frame.error?.code ?? 'error', data: frame.error?.data }))
        else resolve(frame.result)
        return
      }
    })
  })
}

// Claude chats this host's journal changed since sinceMs, read-only.
function recentClaudeChats(sinceMs) {
  const db = path.join(userData(), 'agent-session-journal.db')
  // The account a chat's process acquired is recorded with it; a chat on the System default has none.
  const sql = `select session_id || '|' || coalesce(json_extract(record_json,'$.acquiredAccount.recipe.accountId'),'') from agent_session_records where json_extract(record_json,'$.provider')='claude' and json_extract(record_json,'$.updatedAt') >= ${Number(sinceMs) || 0} order by json_extract(record_json,'$.updatedAt') desc limit 50`
  const text = execFileSync(process.env.GRAZR_SQLITE || 'sqlite3', ['-readonly', db, sql], { encoding: 'utf8', timeout: 10000 })
  return text.split('\n').map((line) => line.trim().split('|')).filter(([id]) => /^claude_[A-Za-z0-9_]+$/.test(id ?? ''))
    .map(([sessionId, accountId]) => ({ sessionId, accountId: accountId || null }))
}

// The cut of a history page: its latest turn ended (not running) by a usage-limit status row, with nothing sent since.
function cutOf(page) {
  if (!page || page.working === true) return null
  if (Array.isArray(page.submissions) && page.submissions.length > 0) return null
  if (Array.isArray(page.queuedMessages) && page.queuedMessages.length > 0) return null
  const latest = page.latestTurn
  if (!latest || typeof latest.itemId !== 'string' || latest.turn?.state === 'running') return null
  const row = (page.items ?? []).find((item) => item?.turnScope?.kind === 'turn' && item.turnScope.turnItemId === latest.itemId
    && item.body?.kind === 'status' && item.body.failure?.kind === 'usageLimitReached')
  if (!row) return null
  const limit = row.body.failure.usageLimit ?? {}
  return {
    sessionId: page.sessionId,
    turnItemId: latest.itemId,
    fence: page.fence,
    ...(typeof limit.window === 'string' ? { window: limit.window } : {}),
    ...(Number.isFinite(limit.resetsAt) ? { resetsAt: limit.resetsAt } : {}),
    endedAt: latest.turn?.completedAt ?? row.observedAt ?? null,
  }
}

async function scan(sinceMs) {
  const cuts = []
  for (const { sessionId, accountId } of recentClaudeChats(sinceMs)) {
    try {
      const history = await rpc('agentSession.history', { sessionId, direction: 'tail', limit: HISTORY_ITEMS })
      const cut = cutOf(history?.page)
      if (cut) cuts.push({ ...cut, accountId })
    } catch {
      // A chat this host cannot read now is skipped; the next scan reads it again.
    }
  }
  return { cuts }
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`
}

// An older host refuses the continuation field (its schema is strict); the same message is then sent as a plain one.
async function continueChat(sessionId, turnItemId, fence) {
  const body = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: CONTINUE_MESSAGE }] }
  const send = (withContinuation) => {
    const control = withContinuation ? { usageLimitContinuationOfTurnItemId: turnItemId } : {}
    const payloadFingerprint = crypto.createHash('sha256')
      .update(canonicalize({ method: 'agentSession.send', sessionId, fields: { body, ...control } }))
      .digest('hex')
    const clientOperationId = `${Math.trunc(Date.now()).toString().padStart(13, '0')}-${crypto.randomUUID().replaceAll('-', '')}`
    return rpc('agentSession.send', {
      envelope: { sessionId, clientOperationId, expectedRuntimeFence: Number(fence), payloadFingerprint },
      ...control,
      body,
    })
  }
  // The host can answer and still refuse (a chat that moved on, a stale fence): that is not a send.
  const accepted = (result, plain) => {
    if (result?.ok === false) throw Object.assign(new Error(result.refusal?.message ?? 'refused'), { code: result.refusal?.details?.reason ?? result.refusal?.code ?? 'refused' })
    return { sent: true, ...(plain ? { plain: true } : {}) }
  }
  try {
    return accepted(await send(true), false)
  } catch (err) {
    if (!/usageLimitContinuation|unrecognized key/i.test(String(err.message))) throw err
    return accepted(await send(false), true)
  }
}

module.exports = { cutOf, canonicalize, CONTINUE_MESSAGE }
// Run as a script (a file, or `node -` with this file on stdin, where Node names the module [stdin]); tests require it.
if (require.main === module || module.id === '[stdin]') main()

async function main() {
  try {
    await run()
  } catch (err) {
    out({ ok: false, error: { code: err.code ?? 'error', message: String(err.message ?? err).split('\n')[0] } }, 1)
  }
}

async function run() {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'scan') return out({ ok: true, result: await scan(args[0]) }, 0)
  if (command === 'continue' && args.length === 3) return out({ ok: true, result: await continueChat(...args) }, 0)
  throw Object.assign(new Error('usage: scan <sinceMs> | continue <sessionId> <turnItemId> <fence>'), { code: 'invalid_argument' })
}
