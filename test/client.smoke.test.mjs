/**
 * Smoke test for the module-loader contract of the browser half.
 *
 * If this fails, every editor-level test below it is meaningless: the file did
 * not register itself with the host's module loader, or the exported surface
 * drifted away from what the sidebar tab contract expects.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { loadClient } from './helpers.mjs'

test('client.js registers itself under the plugin id', () => {
  const { capture } = loadClient()
  assert.equal(capture.loaderId, 'dsh-wechat-md')
})

test('client.js exports an apply() and declares its injected services', () => {
  const { exports } = loadClient()
  assert.equal(typeof exports.apply, 'function')
  assert.ok(Array.isArray(exports.inject), 'inject must be an array')
  for (const name of ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']) {
    assert.ok(exports.inject.includes(name), `inject must request ${name}`)
  }
})

test('apply() registers dictionaries, tab type, body and title through ctx.effect', () => {
  const { exports } = loadClient()
  const registered = []
  const ctx = {
    locale: {
      bind: () => (key) => key,
      register: (ns, dicts) => registered.push(['locale', ns, dicts]),
    },
    sidebarRightTabs: { register: (def) => registered.push(['tabType', def]) },
    slots: {
      inject: (name, fn) => {
        registered.push(['inject', name])
        return fn()
      },
      register: (meta, component) => registered.push(['slot', meta.name, meta.key, typeof component]),
    },
    effect: (fn) => {
      fn()
      return () => {}
    },
  }

  exports.apply(ctx)

  const kinds = registered.map((row) => row[0])
  assert.ok(kinds.includes('locale'), 'must register locale dictionaries')
  assert.ok(kinds.includes('tabType'), 'must register the tab type')
  assert.ok(kinds.includes('slot'), 'must register slot components')

  const slotNames = registered.filter((row) => row[0] === 'slot').map((row) => row[1])
  assert.ok(slotNames.includes('sidebar.right.pane.tab'), 'must register the pane body slot')
  assert.ok(slotNames.includes('sidebar.right.pane.tab.title'), 'must register the pane title slot')

  for (const row of registered.filter((entry) => entry[0] === 'slot')) {
    assert.equal(row[2], 'dsh-wechat-md', 'every slot must be keyed by the plugin id')
    assert.equal(row[3], 'function', 'every slot must register a component')
  }
})
