import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

// The page's own digitsOnly and patchLive, taken from the template and run over minimal nodes.
const template = await readFile(new URL('../panel/template.html', import.meta.url), 'utf8')
const source = template.slice(template.indexOf('      function digitsOnly('), template.indexOf('      function pollLive('))
const page = vm.runInNewContext(`${source}; ({ digitsOnly, patchLive })`)

const text = (value) => ({ nodeType: 3, nodeValue: value })
function el(tag, attrs = {}, children = [], classes = []) {
  const map = new Map(Object.entries(attrs))
  return {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    childNodes: children,
    get attributes() { return [...map].map(([name, value]) => ({ name, value })) },
    getAttribute: (n) => (map.has(n) ? map.get(n) : null),
    setAttribute: (n, v) => map.set(n, String(v)),
    classList: { contains: (c) => classes.includes(c) },
    matches: (sel) => sel === 'p.reading' && tag === 'p' && classes.includes('reading'),
  }
}

test('only text and attributes that differ in their digits are updated', () => {
  const old = el('div', { style: 'width:47%', 'data-view': 'weekly', 'aria-pressed': 'true' }, [text('47% left'), text('active')])
  const fresh = el('div', { style: 'width:46%', 'data-view': 'session', 'aria-pressed': 'false' }, [text('46% left'), text('NEXT ▸')])
  page.patchLive(old, fresh)
  assert.equal(old.getAttribute('style'), 'width:46%')
  // What the page set (its view, a pressed toggle) and a change beyond digits are left alone.
  assert.equal(old.getAttribute('data-view'), 'weekly')
  assert.equal(old.getAttribute('aria-pressed'), 'true')
  assert.deepEqual(old.childNodes.map((n) => n.nodeValue), ['46% left', 'active'])
})

test('a subtree whose shape changed is left for the rewrite, and its siblings are still updated', () => {
  const old = el('main', {}, [el('span', {}, [text('1'), text('2')]), el('b', {}, [text('resets 16:30')])])
  const fresh = el('main', {}, [el('span', {}, [text('9')]), el('b', {}, [text('resets 17:05')])])
  page.patchLive(old, fresh)
  assert.equal(old.childNodes[0].childNodes[0].nodeValue, '1')
  assert.equal(old.childNodes[1].childNodes[0].nodeValue, 'resets 17:05')
})

test('the clocks and reading lines keep what the page script wrote, and take only their attributes', () => {
  const clock = el('div', { 'data-span': '24' }, [text('drawn 10')], ['clock'])
  const reading = el('p', { 'data-updated': '100' }, [text('Reading from 2 min ago')], ['reading'])
  page.patchLive(el('div', {}, [clock, reading]), el('div', {}, [el('div', { 'data-span': '24' }, [text('drawn 99')], ['clock']), el('p', { 'data-updated': '160' }, [text('')], ['reading'])]))
  assert.equal(clock.childNodes[0].nodeValue, 'drawn 10')
  assert.equal(reading.getAttribute('data-updated'), '160')
  assert.equal(reading.childNodes[0].nodeValue, 'Reading from 2 min ago')
})
