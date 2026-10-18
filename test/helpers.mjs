/**
 * Test helpers: load the plugin's two halves without a browser or a host.
 *
 * `lib/client.js` is an IIFE that calls `window.__ModuleLoader__.load(...)`, so
 * a test cannot `import` it. Instead it is evaluated in a `node:vm` context with
 * a minimal `window` stub, and the module factory is invoked with the captured
 * sandbox as the module system's `require`. That gives us `module.exports` plus
 * an observation window (`sandbox.__obs`) onto the private pure functions the
 * factory closes over — `renderWeChat`, `blockify`, `parseThemeCss`, … — without
 * changing one line of production code or exposing a testing seam in the API.
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

/**
 * Where `lib/` lives. Normally the package this test file ships inside; while a
 * test run is staged outside the package, `DSH_WECHAT_MD_ROOT` points at it.
 */
export const REPO_ROOT = (() => {
  const override = process.env.DSH_WECHAT_MD_ROOT
  if (typeof override === 'string' && existsSync(join(override, 'lib', 'client.js'))) return override
  return join(dirname(fileURLToPath(import.meta.url)), '..')
})()

const nodeRequire = createRequire(import.meta.url)

/** Build a fake element, recording every node so tests can find them by text. */
function makeElement(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    listeners: {},
    attributes: {},
    style: {},
    parentNode: null,
    value: '',
    textContent: '',
    spellcheck: undefined,
    contentDocument: null,
  }
  node.append = (...kids) => {
    for (const kid of kids) {
      if (kid === undefined || kid === null) continue
      kid.parentNode = node
      node.children.push(kid)
    }
  }
  node.appendChild = (kid) => node.append(kid)
  node.removeChild = (kid) => {
    const at = node.children.indexOf(kid)
    if (at >= 0) node.children.splice(at, 1)
  }
  node.replaceChildren = (...kids) => {
    node.children.length = 0
    node.append(...kids)
  }
  node.remove = () => {
    if (node.parentNode !== null) node.parentNode.removeChild(node)
  }
  node.contains = (other) => {
    let cursor = other
    while (cursor !== null && cursor !== undefined) {
      if (cursor === node) return true
      cursor = cursor.parentNode
    }
    return false
  }
  node.setAttribute = (key, value) => {
    node.attributes[key] = String(value)
  }
  node.getAttribute = (key) => (key in node.attributes ? node.attributes[key] : null)
  node.addEventListener = (type, handler) => {
    ;(node.listeners[type] ??= []).push(handler)
  }
  node.dispatch = (type, event = {}) => {
    for (const handler of node.listeners[type] ?? []) handler(event)
  }
  node.querySelector = (sel) => {
    const want = String(sel).toUpperCase()
    const walk = (n) => {
      for (const kid of n.children) {
        if (kid.tagName === want) return kid
        const found = walk(kid)
        if (found !== null) return found
      }
      return null
    }
    return walk(node)
  }
  node.querySelectorAll = (sel) => {
    const want = String(sel).toUpperCase()
    const found = []
    const walk = (n) => {
      for (const kid of n.children) {
        if (kid.tagName === want) found.push(kid)
        walk(kid)
      }
    }
    walk(node)
    return found
  }
  return node
}

/** The `document` stub returned to the plugin, with a `__find` walker added. */
export function makeDocumentStub() {
  const document = {
    head: makeElement('head'),
    body: makeElement('body'),
    createElement: (tag) => makeElement(tag),
    listeners: {},
    addEventListener: (type, handler) => {
      ;(document.listeners[type] ??= []).push(handler)
    },
  }
  document.__find = (needle) => {
    let hit = null
    const walk = (node) => {
      if (hit !== null) return
      if (node.textContent === needle || node.value === needle || node.attributes?.title === needle) {
        hit = node
        return
      }
      for (const kid of node.children ?? []) walk(kid)
    }
    walk(document.body)
    return hit
  }
  return document
}

/**
 * Extract the pure functions of the browser half by name and evaluate them in
 * the same realm the module ran in.
 *
 * The file is a closure with no exports and — deliberately — no testing seam,
 * so a unit test has to reach the functions another way. Evaluating the module
 * source is not an option either: the module records only `apply` and `inject`
 * on its exports object, so the pure functions stay unreachable from outside.
 *
 * Slicing each declaration straight out of the source keeps the test honest:
 * nothing is injected into production code, and no behaviour is re-implemented
 * in the test. Every top-level declaration in this file starts at column 4 with
 * balanced braces inside it, which is what makes the slice unambiguous; the
 * sanity checks below fail loudly if that stops being true.
 */
/**
 * The declarations worth asserting on, in source order.
 *
 * `CN_NUM` and `THEMES` are data, not behaviour, but they must come along:
 * `renderWeChat` closes over both, and leaving them out would silently fall
 * back to an undefined theme instead of failing loudly.
 *
 * `createEditor` is included because the editor's own behaviour is now part of
 * the contract: it reveals the sidebar when the agent edits the open article,
 * and that decision lives inside this closure. The DOM doubles in this module
 * are enough to drive it.
 */
const EXTRACTABLE = [
  'CN_NUM',
  'escapeHtml',
  'renderInline',
  'blockify',
  'style',
  'THEMES',
  'parseThemeCss',
  'renderWeChat',
  'wechatify',
  'api',
  'baseName',
  'createEditor',
]

const DECLARATION = {
  CN_NUM: /^ {4}const CN_NUM = /mu,
  escapeHtml: /^ {4}(?:const|let|var) escapeHtml = /mu,
  renderInline: /^ {4}function renderInline\(/mu,
  blockify: /^ {4}function blockify\(/mu,
  style: /^ {4}(?:const|let|var) style = /mu,
  THEMES: /^ {4}const THEMES = /mu,
  parseThemeCss: /^ {4}function parseThemeCss\(/mu,
  renderWeChat: /^ {4}function renderWeChat\(/mu,
  wechatify: /^ {4}function wechatify\(/mu,
  api: /^ {4}const api = /mu,
  baseName: /^ {4}const baseName = /mu,
  createEditor: /^ {4}function createEditor\(/mu,
}

/**
 * Slice one top-level declaration out of the browser half.
 *
 * Counting braces does not work here: the module's template literals are full
 * of `${…}` interpolation, so a `}` inside a template and a `}` that closes a
 * block are indistinguishable to a character scan. Instead every line that
 * begins at column 4 with a non-space character is treated as the start of the
 * next statement, and the first such boundary that the JavaScript parser
 * accepts is the declaration's real end.
 *
 * That check is what makes the slice trustworthy: a boundary that cuts the
 * declaration short leaves the wrapper unclosed and fails to compile, so the
 * scan simply moves to the next candidate.
 */
function sliceDeclaration(source, name) {
  const pattern = DECLARATION[name]
  const match = pattern.exec(source)
  if (match === null) throw new Error(`could not find the ${name} declaration in lib/client.js`)

  // A declaration ends right before the next statement that starts at column 4.
  // Enumerating the *shapes* of those last lines does not work: a continuation
  // line may itself be indented four spaces and end in `)`, which looks exactly
  // like the end of a `const f = (x) => ( … )` declaration. Anchoring on "the
  // next line that begins at column 4 with a non-space character" covers every
  // statement form, and the parser check below rejects the ones that are still
  // mid-expression.
  const candidates = []
  const nextStatement = /\n {4}(?=[^\s])/gu
  nextStatement.lastIndex = match.index
  for (let hit = nextStatement.exec(source); hit !== null; hit = nextStatement.exec(source)) {
    candidates.push(hit.index + 1)
  }
  if (candidates.length === 0) throw new Error(`no candidate end for ${name} in lib/client.js`)

  for (const end of candidates) {
    const text = source.slice(match.index, end)
    try {
      // Wrapping forces the slice to be *complete*: a candidate that stops
      // mid-declaration leaves the wrapper unclosed and fails to compile.
      // Compile-only, the wrapper is never invoked.
      // eslint-disable-next-line no-new
      new vm.Script(`(function () {\n${text}\nvoid 0;\n})`)
      return text
    } catch {
      /* this boundary cut the declaration short: try the next one */
    }
  }
  throw new Error(`could not slice a complete ${name} declaration out of lib/client.js`)
}

/**
 * Load the browser half into a `vm` sandbox.
 *
 * @returns the module exports plus `sandbox`, whose DOM doubles are available
 *   for editor-level tests.
 */
export function loadClient() {
  const document = makeDocumentStub()
  const previewDoc = {
    open() {},
    write(html) {
      previewDoc.written = html
    },
    close() {},
    written: '',
  }
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    TextEncoder,
    URL,
    URLSearchParams,
    Blob: class Blob {
      constructor(parts, options) {
        this.parts = parts
        this.type = options?.type
      }
    },
    document,
    navigator: { clipboard: { writeText: async () => {}, write: async () => {} } },
    localStorage: {
      store: {},
      getItem(key) {
        return key in this.store ? this.store[key] : null
      },
      setItem(key, value) {
        this.store[key] = String(value)
      },
    },
    ClipboardItem: class ClipboardItem {
      constructor(map) {
        this.map = map
      }
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
  }
  sandbox.setInterval = () => 1
  sandbox.clearInterval = () => {}
  sandbox.globalThis = sandbox

  const capture = { factory: null, loaderId: null }
  sandbox.window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        capture.loaderId = id
        capture.factory = factory
      },
    },
    setInterval: sandbox.setInterval,
    clearInterval: sandbox.clearInterval,
    localStorage: sandbox.localStorage,
    ClipboardItem: sandbox.ClipboardItem,
  }

  const source = readFileSync(join(REPO_ROOT, 'lib', 'client.js'), 'utf8')
  vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' })

  if (capture.factory === null) throw new Error('client.js did not register a module factory')

  const exports = capture.factory((specifier) => {
    if (specifier === 'react') {
      return {
        useRef: () => ({ current: null }),
        useEffect: () => {},
        createElement: (type, props, ...kids) => ({ type, props, kids }),
      }
    }
    throw new Error(`unexpected require in client.js: ${specifier}`)
  })

  return { exports, sandbox, capture, document, previewDoc, source }
}

/**
 * Return the private pure functions of the browser half, ready to assert on.
 *
 * They are wrapped in one function so they share a single scope, exactly as
 * they do inside the module. Splicing them in as separate top-level scripts
 * would break the two pieces of module state they rely on: `renderInline`
 * reads `currentTheme`, which `renderWeChat` assigns, and a top-level `let`
 * declared by one script is *not* the binding an implicit assignment from
 * another script creates — the lexical binding shadows the global property and
 * reads back as `undefined`.
 */
export function loadPrivates() {
  const loaded = loadClient()
  const declarations = EXTRACTABLE.map((name) => sliceDeclaration(loaded.source, name)).join('\n')
  const snippet = `globalThis.__fns = (function () {
${declarations}
    return { ${EXTRACTABLE.join(', ')} }
  })()`
  vm.runInNewContext(snippet, loaded.sandbox, { filename: 'lib/client.js#extracted' })
  return { ...loaded, fns: loaded.sandbox.__fns }
}
