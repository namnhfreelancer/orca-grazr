import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const templateUrl = new URL('../panel/template.html', import.meta.url)

// Orca's PANEL_DESIGN_TOKEN_ALLOWLIST (src/shared/plugins/frames/plugin-panel-shell.ts): the only tokens Orca injects as --orca-*.
const ALLOWLIST = [
  'background', 'foreground', 'card', 'card-foreground', 'popover', 'popover-foreground',
  'primary', 'primary-foreground', 'secondary', 'secondary-foreground', 'muted', 'muted-foreground',
  'accent', 'accent-foreground', 'destructive', 'destructive-foreground', 'border', 'input', 'ring', 'radius',
]

// The text of the first block that opens with the given selector, without its braces.
const blockOf = (css, selector) => {
  const start = css.indexOf(`${selector} {`)
  assert.ok(start >= 0, `no ${selector} block`)
  return css.slice(start + selector.length + 2, css.indexOf('}', start))
}

// The custom properties a block declares, by name, with their values.
const declarationsOf = (block) => Object.fromEntries(
  [...block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
)

// WCAG relative luminance and contrast ratio for #rrggbb colours.
const luminance = (hex) => {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

test('every use of an allowlisted Orca token names its --orca- variant first', async () => {
  const html = await readFile(templateUrl, 'utf8')
  const uses = [...html.matchAll(/var\(--([a-z-]+)(?=[,)])/g)].filter((m) => ALLOWLIST.includes(m[1]))
  assert.ok(uses.length > 50, `expected the template to use the tokens, found ${uses.length}`)
  for (const m of uses) {
    const before = html.slice(0, m.index)
    assert.ok(before.endsWith(`var(--orca-${m[1]}, `), `var(--${m[1]} at ${m.index} is not preceded by its --orca- variant`)
  }
})

test('every --orca- variable the template reads is one Orca injects', async () => {
  const html = await readFile(templateUrl, 'utf8')
  for (const m of html.matchAll(/var\(--orca-([a-z-]+)/g)) {
    assert.ok(ALLOWLIST.includes(m[1]), `--orca-${m[1]} is not on Orca's allowlist`)
  }
})

test('the body keeps its card, then background, then transparent fallback, each with its --orca- name first', async () => {
  const html = await readFile(templateUrl, 'utf8')
  assert.ok(html.includes('background: var(--orca-card, var(--card, var(--orca-background, var(--background, transparent))));'))
})

test('every --grazr-* colour has an html.light override', async () => {
  const css = await readFile(templateUrl, 'utf8')
  const dark = declarationsOf(blockOf(css, ':root'))
  const light = declarationsOf(blockOf(css, 'html.light'))
  const names = Object.keys(dark).filter((name) => name.startsWith('grazr-'))
  assert.equal(names.length, 8)
  for (const name of names) {
    assert.ok(Object.hasOwn(light, name), `html.light does not override --${name}`)
  }
})

test('the dark values of the plugin colours are unchanged', async () => {
  const css = await readFile(templateUrl, 'utf8')
  const dark = declarationsOf(blockOf(css, ':root'))
  assert.deepEqual(dark, {
    'grazr-ok': '#4ade80',
    'grazr-next': '#f97316',
    'grazr-warn': '#fbbf24',
    'grazr-acct-1': '#8b5cf6',
    'grazr-acct-2': '#14b8a6',
    'grazr-acct-3': '#ec4899',
    'grazr-acct-4': '#818cf8',
    'grazr-acct-5': '#c9964a',
  })
})

test('every light plugin colour reads at 4.5:1 or better on Orca light card (#ffffff)', async () => {
  const css = await readFile(templateUrl, 'utf8')
  const light = declarationsOf(blockOf(css, 'html.light'))
  for (const [name, value] of Object.entries(light)) {
    assert.match(value, /^#[0-9a-f]{6}$/i, `--${name} is not a hex colour`)
    assert.ok(contrast(value, '#ffffff') >= 4.5, `--${name} ${value} is ${contrast(value, '#ffffff').toFixed(2)}:1 on white`)
  }
})
