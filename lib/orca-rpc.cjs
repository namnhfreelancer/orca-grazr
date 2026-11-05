'use strict'
// Calls one Orca runtime RPC through Orca's own CLI client and prints its reply as one JSON line.
// Run it in Electron's Node mode (ELECTRON_RUN_AS_NODE=1), as Orca's CLI runs itself:
//   <Orca.app>/Contents/MacOS/Orca orca-rpc.cjs <runtime-client.js> <method> [json params]
// ORCA_ENVIRONMENT names a paired environment; unset, the call goes to this Mac's runtime.
// It always prints { ok, result } or { ok: false, error: { code, message } }, and exits 1 on an error.

const [clientPath, method, rawParams] = process.argv.slice(2)

function reply(value, code) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
  process.exitCode = code
}

;(async () => {
  if (!clientPath || !method) throw Object.assign(new Error('usage: orca-rpc.cjs <runtime-client.js> <method> [json]'), { code: 'invalid_argument' })
  const params = rawParams ? JSON.parse(rawParams) : {}
  const { RuntimeClient } = require(clientPath)
  const client = new RuntimeClient()
  const result = await client.call(method, params, { timeoutMs: Number(process.env.GRAZR_RPC_TIMEOUT_MS) || 30000 })
  // The client hands back the runtime's envelope; the payload is its result.
  const payload = result && typeof result === 'object' && 'result' in result ? result.result : result
  reply({ ok: true, result: payload }, 0)
})().catch((err) => {
  const code = typeof err?.code === 'string' ? err.code : 'error'
  reply({ ok: false, error: { code, message: String(err?.message ?? err).split('\n')[0] } }, 1)
})
