import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPage } from './support/page-harness.mjs'

// The page script over the stub DOM: three hosts as tabs, the target 'mac' selected and its card shown, the others hidden.
// The focus poll asks the worker for the focused host: commands.execute with commandId 'active-host'.
const CARDS = [
  { name: 'mac', open: true, buttons: [] },
  { name: 'devbox', buttons: [] },
  { name: 'devbox-2', buttons: [] },
]
const FRESH = () => new Date(Date.now() - 1000).toISOString()
const POLL_MS = 4000
// The host runs a command and wraps its return value: a command's result is { value: { ok, message, host } }.
const focused = (host, extra = {}) => ({ ok: true, value: { value: { ok: true, message: '', host, ...extra } } })
const polls = (page) => page.calls.filter((c) => c.action === 'commands.execute' && c.params.commandId === 'active-host')
// A host's card is shown when it does not carry the hidden attribute; its tab is selected when aria-selected is true.
const isOpen = (page, name) => page.cardOf(name).getAttribute('hidden') === null
const isSelected = (page, name) => page.tabOf(name).getAttribute('aria-selected') === 'true'
const openNames = (page) => ['mac', 'devbox', 'devbox-2'].filter((name) => isOpen(page, name))
const load = (transport, extra = {}) => loadPage({ transport, generatedAt: FRESH(), cards: CARDS, visible: true, ...extra })

for (const transport of ['post', 'frame']) {
  const t = (name, fn) => test(`${name} [${transport}]`, fn)

  t('a visible page asks for the focused host on load, with the active-host command and no params', async () => {
    const page = await load(transport)
    assert.equal(polls(page).length, 1)
    assert.deepEqual(polls(page)[0].params, { commandId: 'active-host', params: {} })
  })

  t('a hidden page sends no poll, on load or on the interval, until it becomes visible', async () => {
    const page = await load(transport, { visible: false })
    assert.equal(polls(page).length, 0)
    await page.fireIntervals(POLL_MS)
    assert.equal(polls(page).length, 0)
    await page.setVisibility('visible')
    assert.equal(polls(page).length, 1)
  })

  t('the poll runs every 4 seconds while visible, one call at a time', async () => {
    const page = await load(transport)
    await page.fireIntervals(POLL_MS)
    assert.equal(polls(page).length, 1, 'a call still pending is not repeated')
    await page.respond(0, focused('mac'))
    await page.fireIntervals(POLL_MS)
    assert.equal(polls(page).length, 2)
  })

  t('the first focused host selects its tab, shows its card, hides the others, and scrolls its tab into view', async () => {
    const page = await load(transport)
    let scrolled = null
    page.tabOf('devbox').scrollIntoView = (options) => { scrolled = options }
    await page.respond(0, focused('devbox'))
    assert.deepEqual(openNames(page), ['devbox'])
    assert.equal(isSelected(page, 'devbox'), true)
    assert.equal(isSelected(page, 'mac'), false)
    assert.equal(JSON.stringify(scrolled), '{"block":"nearest","inline":"nearest"}')
  })

  t('a change of the focused host moves the selected tab and its card', async () => {
    const page = await load(transport)
    await page.respond(0, focused('devbox'))
    await page.fireIntervals(POLL_MS)
    await page.respond(1, focused('devbox-2'))
    assert.deepEqual(openNames(page), ['devbox-2'])
    await page.fireIntervals(POLL_MS)
    await page.respond(2, focused('mac'))
    assert.deepEqual(openNames(page), ['mac'])
  })

  t('the same host again changes nothing, so a tab the user picked by hand stays selected', async () => {
    const page = await load(transport)
    await page.respond(0, focused('mac'))
    await page.click(page.tabOf('devbox'))
    assert.deepEqual(openNames(page), ['devbox'])
    await page.fireIntervals(POLL_MS)
    await page.respond(1, focused('mac'))
    assert.deepEqual(openNames(page), ['devbox'])
    assert.equal(polls(page).length, 2)
  })

  t('a host with no tab, a null host or an ok false answer leaves the selection as it is', async () => {
    const page = await load(transport)
    await page.respond(0, focused('devbox'))
    await page.fireIntervals(POLL_MS)
    await page.respond(1, focused('lab'))
    assert.deepEqual(openNames(page), ['devbox'])
    await page.fireIntervals(POLL_MS)
    await page.respond(2, focused(null))
    assert.deepEqual(openNames(page), ['devbox'])
    await page.fireIntervals(POLL_MS)
    await page.respond(3, focused('mac', { ok: false }))
    assert.deepEqual(openNames(page), ['devbox'])
    assert.equal(page.stamp.textContent, 'Cmd-J Grazr: Refresh panel', 'a quiet failure does not touch the footer')
  })

  t('a failed read keeps polling, and the next good answer opens its card', async () => {
    const page = await load(transport)
    await page.respond(0, { ok: false, errorCode: 'action_failed', error: 'sqlite3 failed' })
    await page.fireIntervals(POLL_MS)
    assert.equal(polls(page).length, 2)
    await page.respond(1, focused('devbox-2'))
    assert.deepEqual(openNames(page), ['devbox-2'])
  })

  for (const code of ['invalid_request', 'unknown_method', 'panel_forbidden', 'capability_denied', 'consent_required']) {
    t(`the fallback code ${code} stops the poll for this page, silently`, async () => {
      const page = await load(transport)
      await page.respond(0, { ok: false, errorCode: code, error: 'not offered' })
      await page.fireIntervals(POLL_MS)
      await page.setVisibility('hidden')
      await page.setVisibility('visible')
      assert.equal(polls(page).length, 1)
      assert.equal(page.stamp.textContent, 'Cmd-J Grazr: Refresh panel')
      assert.deepEqual(openNames(page), ['mac'])
    })
  }

  t('a timed-out poll stops the poll for this page', async () => {
    const page = await load(transport)
    await page.fireTimers(30000)
    await page.fireIntervals(POLL_MS)
    assert.equal(polls(page).length, 1)
  })

  t('a page with no cards still polls and changes nothing', async () => {
    const page = await loadPage({ transport, generatedAt: null, cards: [], visible: true })
    assert.equal(polls(page).length, 1)
    await page.respond(0, focused('devbox'))
    assert.equal(page.tabs().length, 0)
    assert.equal(page.main.querySelectorAll('section.host').length, 0)
  })
}
