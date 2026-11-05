import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPage } from './support/page-harness.mjs'

// Orca 1.4.246+ lets a panel ask its own worker (plugin.request, no capability). A frame whose host.has offers it runs
// every button, the focus poll and the stale-page wake-up that way; commands.execute is only the older route.
const CARD = {
  name: 'mac',
  buttons: [
    { kind: 'swap-to', command: 'swap', params: { host: 'mac', account: 'b' }, text: 'mac swap b', label: 'Switch', palette: "Grazr: Swap to the next account (this workspace's server)" },
    { kind: 'refresh', command: 'refresh', params: { host: 'mac' }, text: 'mac refresh', label: 'Refresh parked', palette: "Grazr: Refresh parked accounts (this workspace's server)" },
  ],
}
const FRESH = () => new Date(Date.now() - 1000).toISOString()
const STALE = () => new Date(Date.now() - 200000).toISOString()
// The host resolves plugin.request with { output }: the handler's own return value.
const answered = (output) => ({ ok: true, value: { output } })
const ran = (value) => ({ ok: true, value: { value } })
const msgOf = (page, name) => page.cardOf(name).querySelector('p.msg')
const requests = (page) => page.calls.filter((c) => c.action === 'plugin.request')
const executes = (page) => page.calls.filter((c) => c.action === 'commands.execute')
const load = (extra = {}) => loadPage({ transport: 'frame', request: true, generatedAt: FRESH(), cards: [CARD], ...extra })

test('a command click sends plugin.request with the command id as the name, the params as input and the command budget', async () => {
  const page = await load()
  await page.click(page.buttonOf('mac', 'swap-to'))
  assert.equal(page.calls.length, 1)
  assert.deepEqual(page.calls[0], { action: 'plugin.request', params: { name: 'swap', input: { host: 'mac', account: 'b' }, timeoutMs: 30000 } })
  await page.respond(0, answered({ ok: true, message: 'Switched to b' }))
  assert.equal(msgOf(page, 'mac').textContent, 'Switched to b')
  assert.equal(msgOf(page, 'mac').classList.contains('msg-error'), false)
  assert.equal(page.cardOf('mac').getAttribute('data-busy'), 'false')
  assert.equal(executes(page).length, 0)
})

test('a handler that reports ok false is shown in the error style', async () => {
  const page = await load()
  await page.click(page.buttonOf('mac', 'swap-to'))
  await page.respond(0, answered({ ok: false, message: 'swap: no account b' }))
  assert.equal(msgOf(page, 'mac').textContent, 'swap: no account b')
  assert.equal(msgOf(page, 'mac').classList.contains('msg-error'), true)
  assert.equal(page.calls.length, 1)
})

test('a host that offers plugin.request but has no handler of that name falls back to commands.execute', async () => {
  const page = await load()
  await page.click(page.buttonOf('mac', 'refresh'))
  await page.respond(0, { ok: false, errorCode: 'unknown_method', error: 'no panel handler named refresh' })
  assert.equal(page.calls.length, 2)
  assert.deepEqual(page.calls[1], { action: 'commands.execute', params: { commandId: 'refresh', params: { host: 'mac' } } })
  await page.respond(1, ran({ ok: true, message: 'Refreshed 2 parked' }))
  assert.equal(msgOf(page, 'mac').textContent, 'Refreshed 2 parked')
  assert.equal(page.cardOf('mac').getAttribute('data-busy'), 'false')
})

test('when neither route runs the button, the card names the Cmd-J command', async () => {
  const page = await load()
  await page.click(page.buttonOf('mac', 'refresh'))
  await page.respond(0, { ok: false, errorCode: 'unknown_method', error: 'no panel handler named refresh' })
  await page.respond(1, { ok: false, errorCode: 'capability_denied', error: 'denied' })
  assert.equal(msgOf(page, 'mac').textContent, "Run Cmd-J › Grazr: Refresh parked accounts (this workspace's server)")
  assert.equal(page.cardOf('mac').getAttribute('data-busy'), 'false')
})

test('a handler failure shows "failed" in the error style and does not try commands.execute', async () => {
  const page = await load()
  await page.click(page.buttonOf('mac', 'swap-to'))
  await page.respond(0, { ok: false, errorCode: 'plugin_request_failed', error: 'engine exited 2' })
  assert.equal(msgOf(page, 'mac').textContent, 'swap failed: engine exited 2')
  assert.equal(msgOf(page, 'mac').classList.contains('msg-error'), true)
  assert.equal(page.calls.length, 1)
})

test('a request that times out says so and frees the card', async () => {
  const page = await load()
  await page.click(page.buttonOf('mac', 'swap-to'))
  await page.fireTimers(30000)
  assert.equal(msgOf(page, 'mac').textContent, 'swap timed out')
  assert.equal(page.calls.length, 1)
  assert.equal(page.cardOf('mac').getAttribute('data-busy'), 'false')
})

test('a frame whose host does not offer plugin.request uses commands.execute at once', async () => {
  const page = await loadPage({ transport: 'frame', request: false, generatedAt: FRESH(), cards: [CARD] })
  await page.click(page.buttonOf('mac', 'swap-to'))
  assert.equal(page.calls.length, 1)
  assert.equal(page.calls[0].action, 'commands.execute')
})

test('the focus poll asks the worker for the focused host through plugin.request and follows its answer', async () => {
  const cards = [{ name: 'mac', open: true, buttons: [] }, { name: 'devbox', buttons: [] }]
  const page = await load({ cards, visible: true })
  // A visible page also asks for the latest render (panel-live) at load; the focus poll is the first request.
  assert.deepEqual(requests(page).map((c) => c.params.name), ['active-host', 'panel-live'])
  assert.deepEqual(requests(page)[0].params, { name: 'active-host', input: {}, timeoutMs: 30000 })
  await page.respond(0, answered({ ok: true, host: 'devbox' }))
  assert.equal(page.tabOf('devbox').getAttribute('aria-selected'), 'true')
  assert.equal(page.cardOf('mac').getAttribute('hidden'), '')
})

test('a stale page wakes the worker through plugin.request and reports a failed refresh in the footer', async () => {
  const page = await load({ generatedAt: STALE() })
  assert.equal(page.calls.length, 1)
  assert.deepEqual(page.calls[0].params, { name: 'panel-refresh', input: {}, timeoutMs: 30000 })
  await page.respond(0, answered({ ok: false, message: 'panel refresh failed' }))
  assert.equal(page.stamp.textContent, 'Panel refresh failed — Cmd-J Grazr: Refresh panel')
})
