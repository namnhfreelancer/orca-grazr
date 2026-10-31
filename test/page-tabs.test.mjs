import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPage, TEMPLATE_PATH } from './support/page-harness.mjs'

// The host tabs in the page script, over the stub DOM. Three hosts: mac is selected (the target), lab has a button.
// Each behaviour runs on both transports, as the other page tests do; a tab never sends a call.
const CARDS = [
  { name: 'mac', open: true, buttons: [] },
  { name: 'lab', buttons: [{ kind: 'refresh', command: 'refresh', params: { host: 'lab' }, text: 'lab refresh', label: 'Refresh parked' }] },
  { name: 'devbox', buttons: [] },
]
const FRESH = () => new Date(Date.now() - 1000).toISOString()
const load = (transport, extra = {}) => loadPage({ transport, generatedAt: FRESH(), cards: CARDS, ...extra })
const selectedOf = (page) => page.tabs().filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.getAttribute('data-host'))
const shownOf = (page) => page.main.querySelectorAll('section.host').filter((s) => s.getAttribute('hidden') === null).map((s) => s.getAttribute('data-host'))
const stops = (page) => page.tabs().map((t) => t.getAttribute('tabindex'))

for (const transport of ['post', 'frame']) {
  const t = (name, fn) => test(`${name} [${transport}]`, fn)

  t('a click on a tab selects it, shows its card and hides the others, and sends nothing', async () => {
    const page = await load(transport)
    await page.click(page.tabOf('lab'))
    assert.deepEqual(selectedOf(page), ['lab'])
    assert.deepEqual(shownOf(page), ['lab'])
    assert.deepEqual(stops(page), ['-1', '0', '-1'])
    assert.equal(page.calls.some((c) => c.action === 'commands.execute' && c.params.commandId !== 'active-host'), false)
    assert.equal(page.calls.filter((c) => c.action !== 'commands.execute' || c.params.commandId !== 'active-host').length, 0)
  })

  t('a card shows its own button after its tab is clicked, and the button still runs its command', async () => {
    const page = await load(transport)
    await page.click(page.tabOf('lab'))
    await page.click(page.buttonOf('lab', 'refresh'))
    assert.equal(page.calls.length, 1)
    assert.equal(page.calls[0].params.commandId, 'refresh')
  })

  t('Right moves to the next tab, takes the tab stop and focus, and prevents the default', async () => {
    const page = await load(transport)
    assert.equal(await page.key(page.tabOf('mac'), 'ArrowRight'), true)
    assert.deepEqual(selectedOf(page), ['lab'])
    assert.deepEqual(shownOf(page), ['lab'])
    assert.equal(page.focused(), page.tabOf('lab'))
    assert.deepEqual(stops(page), ['-1', '0', '-1'])
  })

  t('Left moves to the previous tab, and both arrows wrap at the ends', async () => {
    const page = await load(transport)
    await page.key(page.tabOf('mac'), 'ArrowLeft')
    assert.deepEqual(selectedOf(page), ['devbox'])
    await page.key(page.tabOf('devbox'), 'ArrowRight')
    assert.deepEqual(selectedOf(page), ['mac'])
    assert.equal(page.focused(), page.tabOf('mac'))
  })

  t('Home and End go to the first and the last tab', async () => {
    const page = await load(transport)
    await page.key(page.tabOf('mac'), 'End')
    assert.deepEqual(selectedOf(page), ['devbox'])
    await page.key(page.tabOf('devbox'), 'Home')
    assert.deepEqual(selectedOf(page), ['mac'])
  })

  t('other keys leave the selection and the default alone', async () => {
    const page = await load(transport)
    assert.equal(await page.key(page.tabOf('mac'), 'Enter'), false)
    assert.equal(await page.key(page.tabOf('mac'), 'ArrowDown'), false)
    assert.deepEqual(selectedOf(page), ['mac'])
    assert.equal(page.focused(), null)
  })

  t('after a keyboard move the focus follower still changes a host only on a change of host', async () => {
    const page = await load(transport, { visible: true })
    await page.key(page.tabOf('mac'), 'ArrowRight')
    assert.deepEqual(selectedOf(page), ['lab'])
    // The first poll answers mac, which differs from the page's start (no host yet) and so selects mac.
    await page.respond(0, { ok: true, value: { value: { ok: true, host: 'mac' } } })
    assert.deepEqual(selectedOf(page), ['mac'])
  })

  t('a page with one tab keeps its tab selected under the arrow keys', async () => {
    const page = await loadPage({ transport, generatedAt: FRESH(), cards: [CARDS[0]] })
    await page.key(page.tabOf('mac'), 'ArrowRight')
    assert.deepEqual(selectedOf(page), ['mac'])
    assert.deepEqual(shownOf(page), ['mac'])
  })
}

test('the template has no inline event handlers and no innerHTML for the tabs', async () => {
  const html = await readFile(TEMPLATE_PATH, 'utf8')
  assert.equal(/\son[a-z]+\s*=/i.test(html), false, 'an on* attribute')
  assert.equal(/\.innerHTML\s*=/.test(html.split('<script type="module">')[0].replace(/\/\*__CLOCK__\*\//, '')), false)
})
