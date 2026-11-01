import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPage } from './support/page-harness.mjs'
import { PALETTE } from '../lib/palette.mjs'

// Official Orca refuses commands.execute: each button then names its Cmd-J title on the card, and types nothing.
// Every button kind is checked on both transports of the page harness.
const FRESH = () => new Date(Date.now() - 1000).toISOString()
const KINDS = [
  { kind: 'reauth', command: 'enrol', params: { host: 'mac', account: 'c' }, label: 'Re-authenticate…', palette: PALETTE.reauth, title: PALETTE.reauth },
  { kind: 'enrol', command: 'enrol', params: { host: 'mac' }, label: 'Add account…', palette: PALETTE['add-account'], title: PALETTE['add-account'] },
  { kind: 'rotation', command: 'rotation-toggle', params: { host: 'mac', enabled: false }, text: 'OFF0', label: 'Turn rotation off', palette: PALETTE['rotation-toggle'], title: PALETTE['rotation-toggle'] },
  { kind: 'swap', command: 'swap', params: { host: 'mac' }, text: 'swap mac', label: 'Swap to next', palette: PALETTE.swap, title: PALETTE.swap },
  { kind: 'refresh', command: 'refresh', params: { host: 'mac' }, text: 'refresh mac', label: 'Refresh parked', palette: PALETTE.refresh, title: PALETTE.refresh },
  { kind: 'panel-refresh', command: 'panel-refresh', params: {}, text: '', label: 'Refresh panel', palette: PALETTE['panel-refresh'], title: PALETTE['panel-refresh'] },
]

for (const transport of ['post', 'frame']) {
  for (const spec of KINDS) {
    test(`a ${spec.kind} button names its Cmd-J title when the host lacks commands.execute [${transport}]`, async () => {
      const page = await loadPage({ transport, generatedAt: FRESH(), cards: [{ name: 'mac', buttons: [spec] }] })
      await page.click(page.buttonOf('mac', spec.kind))
      await page.respond(0, { ok: false, errorCode: 'unknown_method', error: 'no such method' })
      assert.equal(page.calls.length, 1)
      assert.equal(page.cardOf('mac').querySelector('p.msg').textContent, `Run Cmd-J › ${spec.title}`)
      assert.equal(page.cardOf('mac').querySelector('pre.cmd'), null)
      assert.equal(page.cardOf('mac').getAttribute('data-busy'), 'false')
    })
  }

  test(`a swap to one named account gives the Cmd-J title, the account note and the selectable command [${transport}]`, async () => {
    const swapTo = { kind: 'swap-to', command: 'swap', params: { host: 'mac', account: 'b@x' }, text: 'swap b@x', label: 'Switch', palette: PALETTE.swap }
    const page = await loadPage({ transport, generatedAt: FRESH(), cards: [{ name: 'mac', buttons: [swapTo] }] })
    await page.click(page.buttonOf('mac', 'swap-to'))
    await page.respond(0, { ok: false, errorCode: 'capability_denied', error: 'denied' })
    assert.equal(
      page.cardOf('mac').querySelector('p.msg').textContent,
      `Run Cmd-J › ${PALETTE.swap} (swaps to the next account; to pick b@x, run the command from a terminal: swap b@x)`,
    )
    assert.equal(page.cardOf('mac').querySelector('pre.cmd').textContent, 'swap b@x')
  })
}
