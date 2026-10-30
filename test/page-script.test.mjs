import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPage } from './support/page-harness.mjs'

// The page script run in a vm over a stub DOM: one card 'mac' with a Switch and a Refresh parked button.
// Each behaviour runs on both transports: the older postMessage bridge and the Orca 1.4.245+ frame API.
const CARD = {
  name: 'mac',
  buttons: [
    { kind: 'swap-to', command: 'swap', params: { host: 'mac', account: 'b' }, text: 'mac swap b', label: 'Switch' },
    { kind: 'refresh', command: 'refresh', params: { host: 'mac' }, text: 'mac refresh', label: 'Refresh parked' },
  ],
}
// The host runs a command and wraps its return value: a command's result is { value: { ok, message } }.
const ran = (value) => ({ ok: true, value: { value } })
const STALE = () => new Date(Date.now() - 200000).toISOString()
const FRESH = () => new Date(Date.now() - 1000).toISOString()
const commandCalls = (page, id) => page.calls.filter((c) => c.action === 'commands.execute' && c.params.commandId === id)
const msgOf = (page, name) => page.cardOf(name).querySelector('p.msg')
const SWITCH = (page) => page.buttonOf('mac', 'swap-to')
const FAILED_FOOTER = 'Panel refresh failed — Cmd-J Grazr: Refresh panel'

for (const transport of ['post', 'frame']) {
  const t = (name, fn) => test(`${name} [${transport}]`, fn)

  t('a command click sends commands.execute with the button command and params, and shows the host message', async () => {
    const page = await loadPage({ transport, generatedAt: FRESH(), cards: [CARD] })
    await page.click(SWITCH(page))
    assert.equal(page.calls.length, 1)
    assert.deepEqual(page.calls[0].params, { commandId: 'swap', params: { host: 'mac', account: 'b' } })
    await page.respond(0, ran({ ok: true, message: 'Switched to b' }))
    assert.equal(msgOf(page, 'mac').textContent, 'Switched to b')
    assert.equal(msgOf(page, 'mac').classList.contains('msg-error'), false)
    assert.equal(page.cardOf('mac').getAttribute('data-busy'), 'false')
  })

  t('a timeout shows "timed out", never types the command, and frees the card', async () => {
    const page = await loadPage({ transport, generatedAt: FRESH(), cards: [CARD] })
    await page.click(SWITCH(page))
    await page.fireTimers(30000)
    assert.equal(msgOf(page, 'mac').textContent, 'swap timed out')
    assert.equal(msgOf(page, 'mac').classList.contains('msg-error'), true)
    assert.equal(page.calls.some((c) => c.action === 'workspace.readContext' || c.action === 'terminal.sendText'), false)
    assert.equal(page.cardOf('mac').getAttribute('data-busy'), 'false')
  })

  t('a fallback code from the host falls back to the 0.5.x path: the page reads the context', async () => {
    const page = await loadPage({ transport, generatedAt: FRESH(), cards: [CARD] })
    await page.click(SWITCH(page))
    await page.respond(0, { ok: false, errorCode: 'unknown_method', error: 'no such method' })
    assert.equal(page.calls[1].action, 'workspace.readContext')
    await page.respond(1, { ok: true, value: { terminals: [] } })
    assert.match(msgOf(page, 'mac').textContent, /No terminal on this Mac/)
    assert.equal(page.cardOf('mac').getAttribute('data-busy'), 'false')
  })

  t('a fallback to a newest terminal types the command into it', async () => {
    const page = await loadPage({ transport, generatedAt: FRESH(), cards: [CARD] })
    await page.click(SWITCH(page))
    await page.respond(0, { ok: false, errorCode: 'capability_denied', error: 'denied' })
    await page.respond(1, { ok: true, value: { terminals: [{ id: 'old' }, { id: 'new' }] } })
    const send = page.calls[2]
    assert.equal(send.action, 'terminal.sendText')
    assert.deepEqual(send.params, { terminalId: 'new', text: 'mac swap b', enter: false })
  })

  t('a host error that is not a fallback code shows "failed" in the error style, and types nothing', async () => {
    const page = await loadPage({ transport, generatedAt: FRESH(), cards: [CARD] })
    await page.click(SWITCH(page))
    await page.respond(0, { ok: false, errorCode: 'action_failed', error: 'engine exited 2' })
    assert.equal(msgOf(page, 'mac').textContent, 'swap failed: engine exited 2')
    assert.equal(msgOf(page, 'mac').classList.contains('msg-error'), true)
    assert.equal(page.calls.length, 1)
  })

  t('a command that reports ok false is shown in the error style, not typed', async () => {
    const page = await loadPage({ transport, generatedAt: FRESH(), cards: [CARD] })
    await page.click(SWITCH(page))
    await page.respond(0, ran({ ok: false, message: 'swap: no account b' }))
    assert.equal(msgOf(page, 'mac').textContent, 'swap: no account b')
    assert.equal(msgOf(page, 'mac').classList.contains('msg-error'), true)
    assert.equal(page.calls.length, 1)
  })

  t('a click while the card is busy is ignored', async () => {
    const page = await loadPage({ transport, generatedAt: FRESH(), cards: [CARD] })
    await page.click(SWITCH(page))
    await page.click(page.buttonOf('mac', 'refresh'))
    assert.equal(commandCalls(page, 'refresh').length, 0)
    assert.equal(page.calls.length, 1)
  })

  t('a stale page sends exactly one panel-refresh on load', async () => {
    const page = await loadPage({ transport, generatedAt: STALE(), cards: [CARD] })
    assert.equal(page.calls.length, 1)
    assert.deepEqual(page.calls[0].params, { commandId: 'panel-refresh', params: {} })
    assert.equal(commandCalls(page, 'panel-refresh').length, 1)
  })

  t('a fresh page and the placeholder send no call on load', async () => {
    const fresh = await loadPage({ transport, generatedAt: FRESH(), cards: [CARD] })
    assert.equal(fresh.calls.length, 0)
    const placeholder = await loadPage({ transport, generatedAt: null, cards: [] })
    assert.equal(placeholder.calls.length, 0)
  })

  t('a stale page whose refresh fails says so in the footer', async () => {
    const page = await loadPage({ transport, generatedAt: STALE(), cards: [CARD] })
    await page.respond(0, { ok: false, errorCode: 'unknown_method', error: 'no such method' })
    assert.equal(page.stamp.textContent, FAILED_FOOTER)
  })

  t('a stale page whose refresh reports ok false says so in the footer', async () => {
    const page = await loadPage({ transport, generatedAt: STALE(), cards: [CARD] })
    await page.respond(0, ran({ ok: false, message: 'panel refresh failed' }))
    assert.equal(page.stamp.textContent, FAILED_FOOTER)
  })

  t('a stale page whose refresh times out says so in the footer', async () => {
    const page = await loadPage({ transport, generatedAt: STALE(), cards: [CARD] })
    await page.fireTimers(30000)
    assert.equal(page.stamp.textContent, FAILED_FOOTER)
  })

  t('a stale page whose refresh succeeds leaves the footer alone', async () => {
    const page = await loadPage({ transport, generatedAt: STALE(), cards: [CARD] })
    const before = page.stamp.textContent
    await page.respond(0, ran({ ok: true, message: 'panel updated' }))
    assert.equal(page.stamp.textContent, before)
  })
}
