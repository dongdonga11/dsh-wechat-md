/**
 * 「AI 改稿后自动弹出编辑器」的集成测试。
 *
 * 这条行为依赖三件事同时成立，缺一就会静默失效，所以值得单独测：
 *   1. 宿主声明了 keepMounted —— 侧边栏收起后编辑器仍在轮询（宿主保证，这里不测）
 *   2. 轮询发现"文件被外部改了"，且编辑器当前不可见
 *   3. 这时调用 openInSidebar 把侧边栏叫出来
 *
 * 用真实 DOM 假件 + 可编程假后端 + 可手动驱动的定时器来测，不依赖宿主。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { loadPrivates } from './helpers.mjs'

/** 建一个可手动触发回调的 setInterval 桩。 */
function makeTimerStub() {
  const timers = new Map()
  let seq = 0
  return {
    setInterval: (fn) => {
      seq += 1
      timers.set(seq, fn)
      return seq
    },
    clearInterval: (id) => timers.delete(id),
    /** 手动跑一轮所有已注册的 interval（模拟 2.5s 轮询到点）。 */
    async fireAll() {
      for (const fn of [...timers.values()]) fn()
      await new Promise((resolve) => setTimeout(resolve, 50))
    },
    get count() {
      return timers.size
    },
  }
}

/** 可编程假后端。 */
function fakeBackend(initial) {
  let current = { ...initial }
  const fetchImpl = async (url) => {
    if (url.startsWith('/wechat-md/state')) {
      return {
        json: async () => ({
          ok: true,
          root: '/tmp',
          config: {},
          articlesDir: 'articles',
          themesDir: 'themes',
          articles: [{ file: 'a.md', bytes: current.text.length, mtime: current.mtime }],
          themes: [],
          articleDirs: [{ value: 'articles', label: 'articles', exists: true, count: 1 }],
        }),
      }
    }
    if (url.startsWith('/wechat-md/article?')) {
      const probe = new URL(`http://x${url}`).searchParams.get('mtime')
      if (probe !== null && Math.abs(Number(probe) - current.mtime) < 1) {
        return { json: async () => ({ ok: true, unchanged: true, mtime: current.mtime }) }
      }
      return { json: async () => ({ ok: true, text: current.text, mtime: current.mtime }) }
    }
    return { json: async () => ({ ok: true }) }
  }
  return {
    fetchImpl,
    /** 模拟"AI 在聊天里改了这篇稿"：内容与 mtime 都变。 */
    externalEdit(nextText) {
      current = { text: nextText, mtime: current.mtime + 1000 }
    },
  }
}

/**
 * 挂载一个编辑器实例。
 *
 * `loadPrivates()` 已经把 createEditor 连同它的闭包依赖（escapeHtml、THEMES…）
 * 一起提取到同一个作用域里，所以这里直接可用；sandbox 上的 fetch / 定时器
 * 在提取之后覆盖，createEditor 运行时读的就是覆盖后的版本。
 */
function mount({ text = '# 初稿', mtime = 1000, openInSidebar, isVisible } = {}) {
  const { sandbox, fns, document } = loadPrivates()
  assert.equal(typeof fns.createEditor, 'function', 'helpers must expose createEditor')

  const backend = fakeBackend({ text, mtime })
  const timer = makeTimerStub()
  sandbox.fetch = backend.fetchImpl
  sandbox.setInterval = timer.setInterval
  sandbox.clearInterval = timer.clearInterval
  sandbox.window.setInterval = timer.setInterval
  sandbox.window.clearInterval = timer.clearInterval

  const host = document.createElement('div')
  document.body.append(host)
  const dispose = fns.createEditor(host, {
    sessionId: 's1',
    initialFile: 'a.md',
    openInSidebar,
    isVisible,
  })
  return { dispose, backend, document, sandbox, timer }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

test('an external edit reveals the editor when it is not visible', async () => {
  const opened = []
  const { dispose, backend, timer } = mount({
    openInSidebar: (file) => opened.push(file),
    isVisible: () => false,
  })
  try {
    await settle()
    assert.equal(timer.count > 0, true, 'the editor must run a background poll')
    assert.equal(opened.length, 0, 'the first load must not pop the sidebar')

    backend.externalEdit('# 初稿\n\nAI 改过的内容')
    await timer.fireAll()

    assert.deepEqual(opened, ['a.md'], 'an external edit must reveal the editor on that article')
  } finally {
    dispose()
  }
})

test('an external edit leaves the editor alone while the user is looking at it', async () => {
  const opened = []
  const { dispose, backend, timer } = mount({
    openInSidebar: (file) => opened.push(file),
    isVisible: () => true,
  })
  try {
    await settle()
    backend.externalEdit('# 初稿\n\nAI 改过的内容')
    await timer.fireAll()
    assert.deepEqual(opened, [], 'no reveal when the editor is already in view')
  } finally {
    dispose()
  }
})

test('no reveal when no external change happened', async () => {
  const opened = []
  const { dispose, timer } = mount({
    openInSidebar: (file) => opened.push(file),
    isVisible: () => false,
  })
  try {
    await settle()
    await timer.fireAll()
    await timer.fireAll()
    assert.deepEqual(opened, [], 'an unchanged file must never trigger a reveal')
  } finally {
    dispose()
  }
})

test('the auto-reveal preference can be switched off from the toolbar', async () => {
  const opened = []
  const { dispose, backend, timer, sandbox } = mount({
    openInSidebar: (file) => opened.push(file),
    isVisible: () => false,
  })
  try {
    await settle()
    const button = sandbox.document.__find('AI 改稿:自动弹出 ✓')
    assert.ok(button, 'the toolbar must expose the auto-reveal toggle')
    const handler = (button.listeners.click ?? [])[0]
    assert.equal(typeof handler, 'function')
    handler()

    backend.externalEdit('# 初稿\n\nAI 改过的内容')
    await timer.fireAll()
    assert.deepEqual(opened, [], 'with the preference off a reveal must not happen')
  } finally {
    dispose()
  }
})
