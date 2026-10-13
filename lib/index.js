/**
 * dsh-wechat-md — node half.
 *
 * Owns everything the browser half must not: real filesystem access to the
 * article folder and the theme folder, plus the small HTTP route table the tab
 * uses. The article `.md` file is the single source of truth, so the chat agent
 * keeps editing it with its ordinary file tools while the tab reads and writes
 * the same bytes.
 *
 * Routes (all JSON, all same-origin with the Web app):
 *   GET  /wechat-md/state                     → articles + themes + config
 *   GET  /wechat-md/article?file=&mtime=      → one article (+ cheap change probe)
 *   POST /wechat-md/article { file, text, mtime }  → atomic write
 *   POST /wechat-md/article/new { title }     → create a slugged article
 *   POST /wechat-md/theme { file, text }      → write a theme stylesheet
 *   GET  /wechat-md/ping                      → liveness
 *
 * Writes go through `ctx.fs` when it is available (atomic replacement, and the
 * sandbox policy seam stays in charge); otherwise a local atomic rename is used.
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const name = 'dsh-wechat-md'

/**
 * Folder conventions, tried in order when the workspace does not name its own.
 *
 * The plugin must be usable from any workspace, so the article/theme folders are
 * detected rather than assumed: an explicit config always wins, then the first
 * convention that exists on disk, then the historical default (which is also
 * created on demand so a brand-new workspace gets somewhere to write).
 */
const ARTICLE_CANDIDATES = ['运营/articles', 'articles', '文章', 'content', 'posts']
const THEME_CANDIDATES = ['运营/themes', 'themes', '主题']
const ARTICLE_FALLBACK = '运营/articles'
const THEME_FALLBACK = '运营/themes'

/** Where a workspace's own choice lives. */
const DOT_DIR = '.wechat-md'
const CONFIG_FILE = 'wechat-md.json'
const MAX_BODY_BYTES = 8 * 1024 * 1024

const DEFAULT_CONFIG = {
  /** Workspace-relative article folder; empty string means the workspace root. */
  articlesDir: ARTICLE_FALLBACK,
  /** Workspace-relative theme folder. */
  themesDir: THEME_FALLBACK,
}

/** Normalise a workspace-relative folder from config ('' or '.' ⇒ workspace root). */
const normalizeDir = (value) => {
  if (typeof value !== 'string') return undefined
  const cleaned = value.trim().replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '')
  if (cleaned === '' || cleaned === '.') return ''
  if (cleaned.includes('..') || cleaned.includes('\0')) return undefined
  return cleaned
}

/**
 * Where an explicit workspace pin lives.
 *
 * The Host process serves every Session at once, so this plugin cannot tell
 * which Session its tab sits beside: it falls back to the newest workspace in
 * the registry, which silently follows the user into whatever workspace they
 * create next. A pin removes that guess — set DSH_WECHAT_MD_ROOT, or write one
 * absolute path to <DSH_HOME>/wechat-md-root.txt, and the editor stays put.
 */
const PIN_ENV = 'DSH_WECHAT_MD_ROOT'
const PIN_FILE = 'wechat-md-root.txt'

/** The pinned workspace as an absolute path, or undefined when unpinned/unusable. */
function readPinnedRoot() {
  let raw = process.env[PIN_ENV]
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    const home =
      typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim().length > 0
        ? process.env.DSH_HOME.trim()
        : join(homedir(), '.dsh')
    try {
      raw = readFileSync(join(home, PIN_FILE), 'utf8')
    } catch {
      return undefined
    }
  }
  const candidate = typeof raw === 'string' ? raw.trim().replace(/^\uFEFF/u, '') : ''
  if (candidate.length === 0) return undefined
  try {
    const resolved = resolve(candidate)
    return existsSync(resolved) ? resolved : undefined
  } catch {
    return undefined
  }
}

export function apply(ctx) {
  // The plugin row mounts before the webserver row provides its service, so ask
  // for it through `ctx.inject`: returning early on a missing service would
  // silently drop every route. `ctx.inject` runs the callback once the named
  // service is available and disposes its effects with this fiber.
  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped.webServer
    if (webServer === undefined) return

  // -- small helpers ---------------------------------------------------------

  /**
   * Resolve the workspace the editor should work in.
   *
   * This plugin is not Session-scoped, so it cannot borrow a Session's cwd the
   * way a tool does. Order of authority: an explicit pin (see `readPinnedRoot`),
   * then a path the Host exposes directly, then the durable workspace registry
   * (the workspace owning the Session this editor sits beside, else the most
   * recent one), then the last answer, then the process cwd. The answer is
   * cached briefly because every request needs it.
   */
  let cachedRoot
  let cachedRootAt = 0

  const root = () => {
    const now = Date.now()

    // The pin is authoritative and cheap, so it is checked before the cache: an
    // editor that has been following the wrong workspace must correct itself on
    // the next request rather than after the cache window expires.
    const pinned = readPinnedRoot()
    if (pinned !== undefined) {
      cachedRoot = pinned
      cachedRootAt = now
      return pinned
    }

    if (cachedRoot !== undefined && now - cachedRootAt < 5000) return cachedRoot

    const candidates = []
    const sessions = ctx.get('sessions')
    if (typeof sessions?.current === 'function') {
      const workspace = sessions.current()?.workspace
      if (typeof workspace === 'string') candidates.push(workspace)
      else if (typeof workspace?.path === 'string') candidates.push(workspace.path)
    }
    if (typeof sessions?.cwd === 'function') {
      const cwd = sessions.cwd()
      if (typeof cwd === 'string') candidates.push(cwd)
    }

    const registry = ctx.get('workspaceRegistry')
    if (registry !== undefined && typeof registry.list === 'function') {
      try {
        const all = registry.list()
        const sessionId = process.env.DSH_SESSION_ID
        const owner =
          sessionId === undefined
            ? undefined
            : all.find((workspace) => (workspace.sessionIds ?? []).includes(sessionId))
        for (const workspace of [owner, all[0]]) {
          if (workspace !== undefined && typeof workspace.path === 'string') candidates.push(workspace.path)
        }
      } catch {
        /* registry not ready yet: the remaining candidates still apply */
      }
    }

    if (cachedRoot !== undefined) candidates.push(cachedRoot)
    candidates.push(process.cwd())

    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || candidate.length === 0) continue
      try {
        const resolved = resolve(candidate)
        if (existsSync(resolved)) {
          cachedRoot = resolved
          cachedRootAt = now
          return resolved
        }
      } catch {
        /* an unusable candidate is simply skipped */
      }
    }
    return resolve(process.cwd())
  }

  const configPath = () => join(root(), DOT_DIR, CONFIG_FILE)

  async function readConfig() {
    try {
      const raw = await readFile(configPath(), 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object') return { ...DEFAULT_CONFIG, ...parsed }
    } catch {
      /* absent or unreadable: fall back to defaults */
    }
    return { ...DEFAULT_CONFIG }
  }

  async function writeConfig(config) {
    const path = configPath()
    await mkdir(dirname(path), { recursive: true })
    await atomicWriteLocal(path, JSON.stringify(config, null, 2) + '\n')
  }

  /**
   * Resolve a workspace-relative directory for articles or themes.
   *
   * Order: an explicit config value, then the first convention that already
   * exists in this workspace, then the historical default. The default is used
   * even when it does not exist yet, so a fresh workspace gets a folder to write
   * into instead of an error.
   */
  async function resolveDir(kind) {
    const config = await readConfig()
    const configured = normalizeDir(kind === 'theme' ? config.themesDir : config.articlesDir)
    const candidates = kind === 'theme' ? THEME_CANDIDATES : ARTICLE_CANDIDATES
    const fallback = kind === 'theme' ? THEME_FALLBACK : ARTICLE_FALLBACK

    // An explicit non-default choice is authoritative even if it does not exist.
    if (configured !== undefined && configured !== DEFAULT_CONFIG[kind === 'theme' ? 'themesDir' : 'articlesDir']) {
      return configured
    }

    for (const candidate of candidates) {
      const full = candidate === '' ? root() : join(root(), candidate)
      if (existsSync(full)) return candidate
    }
    return fallback
  }

  /** Absolute path of one directory, guaranteed to stay inside the workspace. */
  function absDir(rel) {
    return rel === '' ? root() : resolve(root(), rel)
  }

  const slugify = (title) => {
    const base = String(title ?? '')
      .trim()
      .replace(/[\\/:*?"<>|#%{}^[\]`]/gu, '')
      .replace(/\s+/gu, '-')
      .slice(0, 60)
    return base.length > 0 ? base : 'untitled'
  }

  /**
   * Resolve a client-supplied relative path inside one of this plugin's roots.
   * `kind` selects the root; the result is guaranteed to stay inside it.
   */
  function resolveInside(kind, rel, dirRel) {
    const base = absDir(dirRel ?? (kind === 'theme' ? THEME_FALLBACK : ARTICLE_FALLBACK))
    const cleaned = String(rel ?? '')
      .replace(/\\/gu, '/')
      .replace(/^\/+/u, '')
    if (cleaned.length === 0 || cleaned.includes('..') || cleaned.includes('\0')) {
      const error = new Error('bad path')
      error.statusCode = 400
      throw error
    }
    const full = resolve(base, cleaned)
    if (full !== base && !full.startsWith(base + (process.platform === 'win32' ? '\\' : '/'))) {
      const error = new Error('path escapes its root')
      error.statusCode = 400
      throw error
    }
    return full
  }

  async function atomicWriteLocal(path, text) {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, path)
  }

  /**
   * Write text through `ctx.fs` when possible so atomic replacement and the
   * sandbox seam stay in charge, with a local atomic write as the fallback.
   * The resolved `sandboxPolicy` keeps the write inside the workspace even when
   * a caller's own sandbox mode is narrower.
   */
  async function writeArticle(full, text) {
    const fs = ctx.get('fs')
    if (fs === undefined) {
      await atomicWriteLocal(full, text)
      return undefined
    }
    try {
      const target = await fs.resolve(full)
      const policy = ctx.get('sandboxPolicy')?.resolve()
      const outcome = await fs.writeText(target, text, undefined, undefined, policy)
      return outcome?.version
    } catch {
      await atomicWriteLocal(full, text)
      return undefined
    }
  }

  async function mtimeOf(path) {
    try {
      const info = await stat(path)
      return info.mtimeMs
    } catch {
      return undefined
    }
  }

  const json = (res, status, value) => {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  const readBody = (req) =>
    new Promise((accept, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          reject(Object.assign(new Error('body too large'), { statusCode: 413 }))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        if (raw.trim().length === 0) {
          accept({})
          return
        }
        try {
          accept(JSON.parse(raw))
        } catch {
          reject(Object.assign(new Error('invalid JSON body'), { statusCode: 400 }))
        }
      })
      req.on('error', reject)
    })

  /** List matching files in one directory, preferring the sandboxed `ctx.fs`. */
  async function listFiles(dirRel, pattern, withStat) {
    const fs = ctx.get('fs')
    const dir = absDir(dirRel)
    let names = []
    if (fs !== undefined) {
      try {
        const target = await fs.resolve(dir)
        const entries = await fs.listDir(target)
        names = entries.filter((entry) => entry.type === 'file' && pattern.test(entry.name)).map((entry) => entry.name)
      } catch {
        names = []
      }
    }
    if (names.length === 0) {
      try {
        const { readdir } = await import('node:fs/promises')
        const entries = await readdir(dir, { withFileTypes: true })
        names = entries.filter((entry) => entry.isFile() && pattern.test(entry.name)).map((entry) => entry.name)
      } catch {
        names = []
      }
    }
    if (withStat !== true) {
      names.sort((a, b) => a.localeCompare(b))
      return names
    }
    const rows = await Promise.all(
      names.map(async (fileName) => {
        const info = await stat(join(dir, fileName)).catch(() => undefined)
        return { file: fileName, bytes: info?.size ?? 0, mtime: info?.mtimeMs ?? 0 }
      }),
    )
    rows.sort((a, b) => a.file.localeCompare(b.file, 'zh-Hans-CN'))
    return rows
  }

  /** Candidate article folders for the picker: conventions plus anything present. */
  async function candidateDirs(kind) {
    const conventions = kind === 'theme' ? THEME_CANDIDATES : ARTICLE_CANDIDATES
    const seen = new Set()
    const out = []
    const push = async (rel, label) => {
      if (seen.has(rel)) return
      seen.add(rel)
      const full = absDir(rel)
      const count = (await listFiles(rel, kind === 'theme' ? /\.css$/iu : /\.(md|markdown)$/iu, false)).length
      out.push({ value: rel, label, exists: existsSync(full), count })
    }
    for (const rel of conventions) await push(rel, rel)
    await push('', '工作区根目录')
    // Any top-level directory that already holds matching files.
    try {
      const { readdir } = await import('node:fs/promises')
      const entries = await readdir(root(), { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        const nested = kind === 'theme' ? null : `${entry.name}/articles`
        if (nested !== null && existsSync(join(root(), nested))) await push(nested, nested)
      }
    } catch {
      /* an unreadable root simply yields the conventions above */
    }
    return out
  }

  // -- routes ---------------------------------------------------------------

  /**
   * Serve one workspace image so the editor preview can render local article
   * images. Markdown addresses them relatively (`../assets/x.png`), and the
   * preview lives in a `document.write` iframe with no base URL, so the client
   * rewrites each `src` to this route instead of relying on relative resolution.
   *
   * Reads stay inside the workspace: the resolved path is re-checked against the
   * root after normalisation, and only image extensions are served.
   */
  const IMAGE_MIME = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
  }

  function resolveWorkspaceFile(rel) {
    const base = root()
    const cleaned = String(rel ?? '')
      .replace(/\\/gu, '/')
      .replace(/^\/+/u, '')
    if (cleaned.length === 0 || cleaned.includes('\0')) {
      const error = new Error('bad path')
      error.statusCode = 400
      throw error
    }
    const full = resolve(base, cleaned)
    const sep = process.platform === 'win32' ? '\\' : '/'
    if (full !== base && !full.startsWith(base + sep)) {
      const error = new Error('path escapes the workspace')
      error.statusCode = 403
      throw error
    }
    return full
  }

  const routes = [
    {
      kind: 'exact',
      path: '/wechat-md/ping',
      handler: (_req, res) => json(res, 200, { ok: true, plugin: name, root: root() }),
    },
    {
      kind: 'exact',
      path: '/wechat-md/file',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const full = resolveWorkspaceFile(url.searchParams.get('path'))
          const ext = (full.match(/\.[^.\\/]+$/u)?.[0] ?? '').toLowerCase()
          const mime = IMAGE_MIME[ext]
          if (mime === undefined) {
            json(res, 415, { ok: false, error: 'unsupported-extension' })
            return
          }
          const data = await readFile(full)
          res.writeHead(200, {
            'content-type': mime,
            // Path-addressed with no content hash, so keep it revalidated: an
            // image the agent just rewrote shows up on the next preview.
            'cache-control': 'no-cache',
            'content-length': String(data.length),
          })
          res.end(data)
        } catch (error) {
          json(res, error?.statusCode ?? 404, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/wechat-md/state',
      handler: async (_req, res) => {
        try {
          const config = await readConfig()
          const [articlesDir, themesDir] = await Promise.all([resolveDir('article'), resolveDir('theme')])
          const [articles, themes, articleDirs, themeDirs] = await Promise.all([
            listFiles(articlesDir, /\.(md|markdown)$/iu, true),
            listFiles(themesDir, /\.css$/iu, false),
            candidateDirs('article'),
            candidateDirs('theme'),
          ])
          json(res, 200, {
            ok: true,
            root: root(),
            config,
            articlesDir,
            themesDir,
            articles,
            themes,
            articleDirs,
            themeDirs,
          })
        } catch (error) {
          json(res, error?.statusCode ?? 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/wechat-md/article',
      handler: async (req, res) => {
        try {
          const articlesDir = await resolveDir('article')
          if (req.method === 'GET') {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const full = resolveInside('article', url.searchParams.get('file'), articlesDir)
            const probe = Number(url.searchParams.get('mtime') ?? Number.NaN)
            const info = await stat(full).catch(() => undefined)
            if (info === undefined) {
              json(res, 404, { ok: false, error: 'not-found' })
              return
            }
            if (Number.isFinite(probe) && Math.abs(info.mtimeMs - probe) < 1) {
              json(res, 200, { ok: true, unchanged: true, mtime: info.mtimeMs })
              return
            }
            const text = await readFile(full, 'utf8')
            json(res, 200, { ok: true, text, mtime: info.mtimeMs, bytes: info.size })
            return
          }

          if (req.method === 'POST') {
            const body = await readBody(req)
            const full = resolveInside('article', body.file, articlesDir)
            const current = await mtimeOf(full)
            // A caller that sends a positive mtime wants optimistic concurrency.
            // Omitting it (or sending 0) means "write regardless of what is there".
            const expects = Number(body.mtime)
            if (Number.isFinite(expects) && expects > 0 && current !== undefined && Math.abs(current - expects) >= 1) {
              json(res, 409, { ok: false, error: 'changed-on-disk', mtime: current })
              return
            }
            await mkdir(dirname(full), { recursive: true })
            const version = await writeArticle(full, String(body.text ?? ''))
            const info = await stat(full).catch(() => undefined)
            json(res, 200, { ok: true, mtime: info?.mtimeMs ?? Date.now(), version: version ?? null })
            return
          }

          json(res, 405, { ok: false, error: 'method-not-allowed' })
        } catch (error) {
          json(res, error?.statusCode ?? 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/wechat-md/article/new',
      handler: async (req, res) => {
        try {
          const articlesDir = await resolveDir('article')
          const body = await readBody(req)
          const title = String(body.title ?? '').trim()
          const slug = slugify(title)
          const stem = /^\d{4}-/u.test(slug) ? slug : `${new Date().toISOString().slice(0, 10)}-${slug}`
          let file = `${stem}.md`
          let full = resolveInside('article', file, articlesDir)
          let bump = 2
          while ((await mtimeOf(full)) !== undefined) {
            file = `${stem}-${bump}.md`
            full = resolveInside('article', file, articlesDir)
            bump += 1
          }
          await mkdir(dirname(full), { recursive: true })
          const seed = `# ${title || '未命名文章'}\n\n> 摘要写在这里（公众号摘要/朋友圈文案）\n\n正文从这里开始。\n`
          await writeArticle(full, seed)
          const info = await stat(full).catch(() => undefined)
          json(res, 200, { ok: true, file, text: seed, mtime: info?.mtimeMs ?? Date.now() })
        } catch (error) {
          json(res, error?.statusCode ?? 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/wechat-md/theme',
      handler: async (req, res) => {
        try {
          const themesDir = await resolveDir('theme')
          if (req.method === 'GET') {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const full = resolveInside('theme', url.searchParams.get('file'), themesDir)
            const text = await readFile(full, 'utf8')
            json(res, 200, { ok: true, text })
            return
          }
          if (req.method === 'POST') {
            const body = await readBody(req)
            const full = resolveInside('theme', body.file, themesDir)
            await mkdir(dirname(full), { recursive: true })
            await writeArticle(full, String(body.text ?? ''))
            json(res, 200, { ok: true })
            return
          }
          json(res, 405, { ok: false, error: 'method-not-allowed' })
        } catch (error) {
          json(res, error?.statusCode ?? 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/wechat-md/config',
      handler: async (req, res) => {
        try {
          if (req.method === 'POST') {
            const body = await readBody(req)
            const current = await readConfig()
            const next = { ...current }
            // Only accept the folder fields, and only in a normalisable form.
            if ('articlesDir' in body) {
              const value = normalizeDir(body.articlesDir)
              if (value === undefined) {
                json(res, 400, { ok: false, error: 'invalid-articlesDir' })
                return
              }
              next.articlesDir = value
            }
            if ('themesDir' in body) {
              const value = normalizeDir(body.themesDir)
              if (value === undefined) {
                json(res, 400, { ok: false, error: 'invalid-themesDir' })
                return
              }
              next.themesDir = value
            }
            await writeConfig(next)
            // Make the chosen folders real so the next read finds them.
            for (const rel of [next.articlesDir, next.themesDir]) {
              try {
                await mkdir(absDir(rel), { recursive: true })
              } catch {
                /* a read-only workspace is reported by the routes instead */
              }
            }
            json(res, 200, { ok: true, config: next })
            return
          }
          json(res, 200, { ok: true, config: await readConfig() })
        } catch (error) {
          json(res, error?.statusCode ?? 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
  ]

  for (const route of routes) {
    ctx.effect(() => webServer.register(route), `dsh-wechat-md: route ${route.path}`)
  }

  // Materialise the folders this workspace will actually use, so a first run in
  // a fresh workspace opens an empty editor instead of failing to write.
  ctx.effect(() => {
    void (async () => {
      try {
        const [articlesDir, themesDir] = await Promise.all([resolveDir('article'), resolveDir('theme')])
        await mkdir(absDir(articlesDir), { recursive: true })
        await mkdir(absDir(themesDir), { recursive: true })
      } catch {
        /* a read-only or absent workspace is reported by the routes instead */
      }
    })()
  }, 'dsh-wechat-md: ensure folders')
  })
}
