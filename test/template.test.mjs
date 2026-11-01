import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { placeholderPanel } from '../lib/panel.mjs'

const templateUrl = new URL('../panel/template.html', import.meta.url)
const pageUrl = new URL('../panel/accounts.html', import.meta.url)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

// The committed placeholder, not the working file: a development install overwrites the working file with the live page.
// Outside a git checkout the working file is the only copy there is.
const committedPage = async () => {
  try {
    return execFileSync('git', ['show', 'HEAD:panel/accounts.html'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return readFile(pageUrl, 'utf8')
  }
}

const count = (html, needle) => html.split(needle).length - 1

test('template carries the three markers exactly once', async () => {
  const html = await readFile(templateUrl, 'utf8')
  assert.equal(count(html, '<!--__CARDS__-->'), 1)
  assert.equal(count(html, '/*__DATA__*/'), 1)
  assert.equal(count(html, '/*__CLOCK__*/'), 1)
  assert.ok(html.indexOf('<!--__CARDS__-->') > html.indexOf('<main'))
})

test('the clock marker sits inside a module script after the classic data script', async () => {
  const html = await readFile(templateUrl, 'utf8')
  const module = html.indexOf('<script type="module">')
  assert.ok(module > html.indexOf('/*__DATA__*/'))
  const end = html.indexOf('</script>', module)
  assert.ok(html.slice(module, end).includes('/*__CLOCK__*/'))
})

// Orca mounts the panel in a sandbox without allow-same-origin, so no storage is reachable; the choices come from settings.
test('the template uses no storage API', async () => {
  const html = await readFile(templateUrl, 'utf8')
  for (const api of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie']) {
    assert.equal(html.includes(api), false, `found ${api}`)
  }
})

test('template redraws the clock every 30 s from the browser clock', async () => {
  const html = await readFile(templateUrl, 'utf8')
  assert.ok(html.includes('setInterval(draw, 30000)'))
  assert.ok(html.includes('clockSvg(clock, { now: Date.now() / 1000, span: div.getAttribute(\'data-span\') })'))
})

test('template hides the clock under the dial face and the dial under the clock face', async () => {
  const html = await readFile(templateUrl, 'utf8')
  assert.ok(html.includes('.host[data-face="dial"] .clock, .host[data-face="dial"] .clock-note, .host[data-face="clock"] .dial { display: none }'))
})

test('template disables every button in a card while one of its calls is pending', async () => {
  const html = await readFile(templateUrl, 'utf8')
  assert.ok(html.includes('function setBusy(card, busy)'))
  assert.ok(html.includes("card.getAttribute('data-busy') === 'true') return"))
  assert.ok(html.includes("card.querySelectorAll('button.act')"))
  assert.ok(html.includes('other.disabled = busy'))
  // The guard is released on every path out of the command call: a message, a timeout, the Cmd-J guide, and a failure.
  assert.equal(html.split('setBusy(card, false)').length - 1, 4)
})


test('template never reads the terminal context or types into a terminal: official Orca names the Cmd-J command', async () => {
  const html = await readFile(templateUrl, 'utf8')
  assert.equal(html.includes('workspace.readContext'), false)
  assert.equal(html.includes('terminal.sendText'), false)
  assert.equal(html.includes('typeIntoNewest'), false)
})

test('template has the list rules and the reading-age script', async () => {
  const html = await readFile(templateUrl, 'utf8')
  assert.ok(html.includes('.host[data-face="list"] .dial, .host[data-face="list"] .clock, .host[data-face="list"] .clock-note, .host[data-face="list"] .rows, .host[data-face="list"] button.view { display: none }'))
  assert.ok(html.includes('.host:not([data-face="list"]) .list { display: none }'))
  assert.ok(html.includes('Intl.RelativeTimeFormat'))
  assert.ok(html.includes("querySelectorAll('p.reading[data-updated]')"))
  assert.ok(html.includes('setInterval(ageLines, 30000)'))
})

test('template has no external references', async () => {
  const html = await readFile(templateUrl, 'utf8')
  for (const needle of ['src=', 'href=', '<link', 'url(', '@import', 'fetch(', 'XMLHttpRequest']) {
    assert.equal(html.includes(needle), false, `found ${needle}`)
  }
})


test('template names the Cmd-J command when the host lacks commands.execute, and types nothing', async () => {
  const html = await readFile(templateUrl, 'utf8')
  assert.ok(html.includes("'Run Cmd-J › ' + title"))
  assert.ok(html.includes("button.getAttribute('data-palette')"))
  assert.ok(html.includes("button.classList.contains('act-swap-to') && typeof params.account === 'string'"))
  assert.ok(html.includes("' (swaps to the next account; to pick ' + params.account + ', run the command from a terminal: ' + text + ')'"))
  assert.ok(html.includes('var guide = guideFor(button)'))
  assert.ok(html.includes('setMsg(button, guide.message)'))
  assert.equal(html.includes('No terminal on this Mac'), false)
  assert.equal(html.includes('Open a shell terminal in a worktree first'), false)
  assert.ok(html.includes('send failed') === false)
  assert.ok(html.includes('5000'))
})


test('template shows the selectable command only for a swap to one account', async () => {
  const html = await readFile(templateUrl, 'utf8')
  assert.ok(html.includes("createElement('pre')"))
  assert.ok(html.includes("pre.className = 'cmd'"))
  assert.ok(html.includes('pre.tabIndex = 0'))
  assert.ok(html.includes('pre.textContent = text'))
  assert.ok(html.includes('selectAllChildren'))
  assert.ok(html.includes('user-select: all'))
  assert.ok(html.includes("addEventListener('click', selectCommand)"))
  assert.ok(html.includes("addEventListener('focus', selectCommand)"))
  assert.ok(html.includes('clearCommand(card)'))
  assert.ok(html.includes("insertAdjacentElement('afterend'"))
  assert.ok(html.includes('el.remove()'))
  assert.ok(html.includes('if (!line) return'))
  assert.ok(html.includes('if (sel) sel.selectAllChildren(event.currentTarget)'))
  assert.equal(html.includes('HINTS'), false)
  assert.equal(html.includes('cmd-hint'), false)
})

test('placeholder page equals placeholderPanel(template)', async () => {
  const template = await readFile(templateUrl, 'utf8')
  const page = await committedPage()
  assert.equal(page, placeholderPanel(template))
})

test('template footer only names the refresh command; the as-of time moved into each card header', async () => {
  const html = await readFile(templateUrl, 'utf8')
  assert.ok(html.includes("textContent = 'Cmd-J Grazr: Refresh panel'"))
  assert.ok(!html.includes("'as of '"))
})

test('template hides the inactive view block by the card data-view', async () => {
  const html = await readFile(templateUrl, 'utf8')
  assert.ok(html.includes('.host[data-view="session"] .view-weekly'))
  assert.ok(html.includes('.host[data-view="weekly"] .view-session'))
})

test('reading age always names the number, so 30 hours reads "1 day ago" and never "yesterday"', async () => {
  const html = await readFile(templateUrl, 'utf8')
  assert.ok(html.includes("numeric: 'always'"))
  assert.equal(html.includes("numeric: 'auto'"), false)
})

test('a reading whose data-updated does not parse to a finite number shows an empty line, not just now', async () => {
  const html = await readFile(templateUrl, 'utf8')
  assert.ok(html.includes("if (!Number.isFinite(seconds)) return ''"))
  assert.ok(html.includes("text === '' ? '' : 'Reading from ' + text"))
})

test('the page background is Orca\'s card colour, matching the sidebar, with the background token as the fallback', async () => {
  const html = await readFile(templateUrl, 'utf8')
  assert.ok(html.includes('background: var(--orca-card, var(--card, var(--orca-background, var(--background, transparent))));'))
  assert.equal(html.includes('background: var(--background, transparent);'), false)
})

test('the tooltip clamps its lower edge as well as its upper edge', async () => {
  const html = await readFile(templateUrl, 'utf8')
  assert.ok(html.includes('Math.max(8,'))
})

test('the tooltip delegates on any element with a data-tip-label, so the model tracks and fills get it too', async () => {
  const html = await readFile(templateUrl, 'utf8')
  assert.ok(html.includes("var TIP_SEG = '[data-tip-label]'"))
  assert.equal(html.includes("path.seg[data-tip-label]"), false)
})

test('the tick line takes the warning tone when the tooltip says it is under the swap tick', async () => {
  const html = await readFile(templateUrl, 'utf8')
  assert.ok(html.includes("get('tick-tone') === 'warning' ? 'tone-warning' : 'muted'"))
})

test('the model rings have their track, fill, dim and tick rules, and the fill sits after the tone fills', async () => {
  const html = await readFile(templateUrl, 'utf8')
  assert.ok(html.includes('.mseg-track { stroke: var(--orca-muted-foreground, var(--muted-foreground, #999)); stroke-opacity: .2; fill: none; }'))
  assert.ok(html.includes('.mseg-fill { fill: none; stroke-opacity: .85; }'))
  assert.ok(html.includes('.mseg-fill.dim { stroke-opacity: .3; }'))
  assert.ok(html.includes('.mseg-fill.tone-fine { stroke: var(--grazr-ok); }'))
  assert.ok(html.includes('.mseg-fill.tone-warning { stroke: var(--grazr-warn); }'))
  assert.ok(html.includes('.mtick { stroke: var(--orca-muted-foreground, var(--muted-foreground, #999)); stroke-width: 1; stroke-linecap: round; }'))
  assert.ok(html.indexOf('.mseg-fill {') > html.indexOf('.tone-fine{fill:var(--grazr-ok)}'))
})

test('the footnote is muted, centred and shown only on the dial face', async () => {
  const html = await readFile(templateUrl, 'utf8')
  assert.ok(html.includes('.dial-note { font-size: 10.5px; color: var(--orca-muted-foreground, var(--muted-foreground, #999)); text-align: center; margin: 2px 0 0; }'))
  assert.ok(html.includes('.host:not([data-face="dial"]) .dial-note { display: none }'))
})

test('the model fills and ticks pass the pointer through, so hover reaches the track under them', async () => {
  const html = await readFile(templateUrl, 'utf8')
  assert.ok(html.includes('.mseg-fill, .mtick { pointer-events: none; }'))
})

test('tooltip treats a missing data-tip attribute as an empty line', async () => {
  const html = await readFile(templateUrl, 'utf8')
  assert.ok(html.includes("getAttribute('data-tip-' + key) || ''"))
  assert.ok(html.includes('if (!text) return'))
})
