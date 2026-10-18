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
  for (const name of ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'shortcuts']) {
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
    // 宿主以 ctx.inject(['shortcuts'], cb) 提供命令注册；这里照样实现
    shortcuts: { register: (definition) => registered.push(['command', definition.id]) },
    inject: (_names, fn) => fn(ctx),
    effect: (fn) => {
      fn()
      return () => {}
    },
    get: () => undefined,
  }

  exports.apply(ctx)

  const kinds = registered.map((row) => row[0])
  assert.ok(kinds.includes('locale'), 'must register locale dictionaries')
  assert.ok(kinds.includes('tabType'), 'must register the tab type')
  assert.ok(kinds.includes('slot'), 'must register slot components')
  assert.ok(
    registered.some((row) => row[0] === 'command' && row[1] === 'wechat-md.open'),
    'must register the command the guide card points at',
  )

  const slotNames = registered.filter((row) => row[0] === 'slot').map((row) => row[1])
  assert.ok(slotNames.includes('sidebar.right.pane.tab'), 'must register the pane body slot')
  assert.ok(slotNames.includes('sidebar.right.pane.tab.title'), 'must register the pane title slot')

  for (const row of registered.filter((entry) => entry[0] === 'slot')) {
    assert.equal(row[2], 'dsh-wechat-md', 'every slot must be keyed by the plugin id')
    assert.equal(row[3], 'function', 'every slot must register a component')
  }
})

// ---------------------------------------------------------------------------
// 主动打开侧边栏：产品化体验的关键一环
//
// 宿主机制（读 app.asar 确认过）：guide 卡片是否可点，取决于
// `shortcuts.find(s => s.id === entry.commandId)` 能否命中；命中后由该命令的
// `resolve()` 返回 `{ status:'handled', run }` 真正打开侧边栏。
// 所以这里要验证两件事：guide 的 commandId 与注册的命令 id 一致；resolve 能干活。
// ---------------------------------------------------------------------------

const { exports: clientExports } = loadClient()
const exportsApply = clientExports.apply

/** 跑一遍 apply()，收集定义与注册的命令。 */
function harness({ services = {} } = {}) {
  const defs = []
  const commands = []
  const ctx = {
    locale: { bind: () => (key) => key, register: () => {} },
    sidebarRightTabs: { register: (def) => defs.push(def) },
    slots: { inject: (_name, fn) => fn(), register: () => {} },
    shortcuts: { register: (definition) => { commands.push(definition); return () => {} } },
    // 宿主的 ctx.inject(['shortcuts'], cb) 模式
    inject: (_names, fn) => fn(ctx),
    effect: (fn) => {
      fn()
      return () => {}
    },
    get: (name) => services[name],
  }
  exportsApply(ctx)
  return { defs, commands }
}

test('the guide entry is wired to a command the host can actually resolve', () => {
  // 用户不该为了打开编辑器先"手动点侧边栏再选文章"。
  const { defs, commands } = harness()
  assert.equal(defs.length, 1, 'exactly one tab type must be registered')
  const guide = defs[0].guide ?? []
  assert.equal(guide.length, 1, 'the guide must expose one entry')

  const commandId = guide[0].commandId
  assert.equal(typeof commandId, 'string', 'the guide card needs a commandId or it renders inert')
  assert.ok(
    commands.some((cmd) => cmd.id === commandId),
    `the commandId ${commandId} must match a registered command, otherwise the card does nothing`,
  )
})

test('the registered command opens this tab and reveals the right sidebar', () => {
  const calls = []
  const { commands } = harness({
    services: {
      sidebarRight: {
        commandTarget: (element) => (element === null ? undefined : { sessionId: 's1' }),
        openTabFromTarget: (kind, target) => calls.push(['openTabFromTarget', kind, target]),
        openTab: (kind, options) => calls.push(['openTab', kind, options]),
      },
      layout: { openRightbar: (...args) => calls.push(['openRightbar', ...args]) },
    },
  })

  const cmd = commands.find((c) => c.id === 'wechat-md.open')
  assert.ok(cmd !== undefined, 'the open command must be registered')
  const resolved = cmd.resolve({ target: {} })
  assert.equal(resolved.status, 'handled', 'with a resolvable session the command must run')
  resolved.run()

  const opened = calls.find((c) => c[0] === 'openTabFromTarget' || c[0] === 'openTab')
  assert.ok(opened !== undefined, 'running it must ask the sidebar to open our tab')
  assert.equal(opened[1], 'wechat-md', 'it must open the wechat-md tab kind')
  assert.ok(
    calls.some((c) => c[0] === 'openRightbar'),
    'the command must actually reveal the right sidebar, not just select a tab',
  )
})

test('the command reports blocked (not a crash) when no session can be resolved', () => {
  const { commands } = harness({
    services: { sidebarRight: { commandTarget: () => undefined } },
  })
  const cmd = commands.find((c) => c.id === 'wechat-md.open')
  const resolved = cmd.resolve({ target: {} })
  assert.equal(resolved.status, 'blocked', 'the host needs a reason instead of an exception')
  assert.equal(typeof resolved.reason, 'string')
})

test('the command falls back to openTab when the host lacks openTabFromTarget', () => {
  // 老宿主没有 openTabFromTarget：不能把"打开编辑器"变成静默失败。
  const calls = []
  const { commands } = harness({
    services: {
      sidebarRight: {
        commandTarget: () => ({ sessionId: 's1' }),
        openTab: (kind, options) => calls.push(['openTab', kind, options]),
      },
    },
  })
  const cmd = commands.find((c) => c.id === 'wechat-md.open')
  const resolved = cmd.resolve({ target: {} })
  assert.doesNotThrow(() => resolved.run())
  assert.ok(calls.some((c) => c[0] === 'openTab'), 'must still try to open the tab')
})
