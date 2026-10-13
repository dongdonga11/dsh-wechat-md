/**
 * Harness for the node half: a minimal host that exercises the real HTTP
 * handlers without a webserver.
 *
 * The plugin asks the host for `webServer`, `sessions`, `workspaceRegistry`,
 * `fs` and `sandboxPolicy`. Only `webServer` is mandatory, so the harness
 * deliberately injects *none* of the optional services: that is the
 * least-privileged host a third-party profile can offer, and it forces every
 * route down the documented fallback path rather than a happy path that only
 * exists on this machine.
 */

import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Where `lib/` lives. Normally the package this test file ships inside; while a
 * test run is staged outside the package, `DSH_WECHAT_MD_ROOT` points at it.
 */
export const REPO_ROOT = (() => {
  const override = process.env.DSH_WECHAT_MD_ROOT
  if (typeof override === 'string' && existsSync(join(override, 'lib', 'index.js'))) return override
  return join(dirname(fileURLToPath(import.meta.url)), '..')
})()
const ENTRY = pathToFileURL(join(REPO_ROOT, 'lib', 'index.js')).href

/**
 * Spin up one isolated plugin instance.
 *
 * `workspace` is pinned through `DSH_WECHAT_MD_ROOT` so the suite never depends
 * on — or touches — the real workspace registry of the machine running it.
 */
export async function boot({ workspace, services = {} } = {}) {
  const root = workspace ?? (await mkdtemp(join(tmpdir(), 'wechat-md-test-')))
  process.env.DSH_WECHAT_MD_ROOT = root

  const routes = []
  const server = {
    register(route) {
      routes.push(route)
      return () => {
        const at = routes.indexOf(route)
        if (at >= 0) routes.splice(at, 1)
      }
    },
  }

  const effects = []
  const ctx = {
    webServer: server,
    effect(fn, label) {
      effects.push(label)
      return fn() ?? (() => {})
    },
    get(name) {
      return name in services ? services[name] : undefined
    },
    inject(names, fn) {
      return fn(ctx)
    },
  }

  const mod = await import(ENTRY)
  mod.apply(ctx)

  /**
   * Drive one request through the registered handler.
   *
   * The body is replayed to whichever listeners the handler attaches, whenever
   * it attaches them. An earlier timer-based version raced the handler: a route
   * that awaited anything before `readBody()` could miss the `end` event and
   * hang forever. Replaying on demand removes the timing dependency entirely.
   */
  function makeRequest(method, path, body) {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const request = new IncomingMessage(new Socket())
    request.method = method
    request.url = path
    const listeners = new Map()
    request.on = (type, fn) => {
      const bucket = listeners.get(type) ?? []
      bucket.push(fn)
      listeners.set(type, bucket)
      // Already-buffered data is delivered immediately, in order and
      // synchronously, so a handler never waits on an event that already ended.
      if (type === 'data') for (const chunk of chunks) fn(chunk)
      if (type === 'end') fn()
      return request
    }
    request.destroy = () => {}
    request.resume = () => request
    return request
  }

  async function req(method, path, body) {
    const [pathname] = path.split('?')
    const route = routes.find((entry) => entry.kind === 'exact' && entry.path === pathname)
    if (route === undefined) throw new Error(`no route registered for ${method} ${pathname}`)

    let status = 0
    let payload = ''
    const response = {
      writeHead(value) {
        status = value
      },
      end(data) {
        payload = data === undefined ? '' : String(data)
      },
    }

    await route.handler(makeRequest(method, path, body), response)

    let parsed = null
    if (payload !== '') {
      try {
        parsed = JSON.parse(payload)
      } catch {
        parsed = payload
      }
    }
    return { status, body: parsed }
  }

  return {
    root,
    ctx,
    routes,
    effects,
    req,
    /** Read a workspace-relative file straight off disk, bypassing the plugin. */
    async disk(rel) {
      return readFile(join(root, rel), 'utf8')
    },
    exists(rel) {
      return existsSync(join(root, rel))
    },
    join: (...parts) => join(root, ...parts),
  }
}

/** A scratch workspace with the folder conventions the plugin looks for. */
export async function makeWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'wechat-md-ws-'))
  await mkdir(join(root, '运营', 'articles'), { recursive: true })
  await mkdir(join(root, '运营', 'themes'), { recursive: true })
  await writeFile(join(root, '运营', 'articles', '01_正文_示例.md'), '# 示例\n\n第一段。\n', 'utf8')
  await writeFile(join(root, '运营', 'articles', '02_标题与发布清单.md'), '# 清单\n\n- 甲\n', 'utf8')
  await writeFile(join(root, '运营', 'themes', 'moji.css'), 'wrap { label: 墨迹 }\np { margin: 0 }\n', 'utf8')
  return root
}

/** A file that lives outside the workspace, to prove reads cannot escape it. */
export async function makeOutsideFile() {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-md-outside-'))
  const file = join(dir, 'secret.png')
  await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  return { dir, file }
}

export { mkdir, mkdtemp, writeFile }
