/**
 * Integration tests for the node half's HTTP surface.
 *
 * The routes are the plugin's whole contract with the tab, and several of them
 * guard real invariants: atomic writes, optimistic concurrency (so the chat
 * agent and the editor cannot silently overwrite each other), and — most
 * importantly — that no request can read or write outside the workspace.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { boot, makeOutsideFile, makeWorkspace, mkdir, utimes, writeFile } from './routes.harness.mjs'

const EXPECTED_ROUTES = [
  '/wechat-md/ping',
  '/wechat-md/file',
  '/wechat-md/state',
  '/wechat-md/article',
  '/wechat-md/article/new',
  '/wechat-md/theme',
  '/wechat-md/config',
]

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

test('applying the plugin registers every route as an exact match', async () => {
  const app = await boot({ workspace: await makeWorkspace() })
  const paths = app.routes.map((route) => route.path).sort()
  assert.deepEqual(paths, [...EXPECTED_ROUTES].sort())
  for (const route of app.routes) {
    assert.equal(route.kind, 'exact', `${route.path} must be an exact route`)
    assert.equal(typeof route.handler, 'function')
  }
})

test('folder materialisation is registered through ctx.effect so it can be disposed', async () => {
  const app = await boot({ workspace: await makeWorkspace() })
  assert.ok(
    app.effects.some((label) => String(label).includes('ensure folders')),
    `expected an ensure-folders effect, got: ${app.effects.join(' | ')}`,
  )
})

test('a fresh workspace gets its article and theme folders created', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const empty = await mkdtemp(join(tmpdir(), 'wechat-md-fresh-'))

  const app = await boot({ workspace: empty })

  // The effect is fire-and-forget, so the folders appear asynchronously. Polling
  // for the condition rather than sleeping a fixed 20 ms: on a loaded machine a
  // fixed delay is a coin flip, and a flaky test in a brand-new suite is worse
  // than no test at all.
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && !(app.exists('运营/articles') && app.exists('运营/themes'))) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  assert.ok(app.exists('运营/articles'), 'the default article folder must be created')
  assert.ok(app.exists('运营/themes'), 'the default theme folder must be created')
})

// ---------------------------------------------------------------------------
// ping
// ---------------------------------------------------------------------------

test('ping reports liveness and resolves the pinned workspace root', async () => {
  const workspace = await makeWorkspace()
  const app = await boot({ workspace })
  const { status, body } = await app.req('GET', '/wechat-md/ping')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.plugin, 'dsh-wechat-md')
  assert.equal(body.root, workspace, 'DSH_WECHAT_MD_ROOT is authoritative')
})

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

test('state reports the resolved folders, the file list and the folder picker', async () => {
  const app = await boot({ workspace: await makeWorkspace() })
  const { status, body } = await app.req('GET', '/wechat-md/state')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.articlesDir, '运营/articles')
  assert.equal(body.themesDir, '运营/themes')

  const names = body.articles.map((row) => row.file).sort()
  assert.deepEqual(names, ['01_正文_示例.md', '02_标题与发布清单.md'])
  for (const row of body.articles) {
    assert.ok(row.bytes > 0, 'the picker needs a size')
    assert.ok(row.mtime > 0, 'the picker needs an mtime')
  }
  assert.deepEqual(body.themes, ['moji.css'])

  assert.ok(Array.isArray(body.articleDirs) && body.articleDirs.length > 0)
  assert.ok(
    body.articleDirs.some((row) => row.value === '运营/articles' && row.exists === true),
    'the active convention must be offered and marked as existing',
  )
  assert.ok(
    body.articleDirs.some((row) => row.value === ''),
    'the workspace root must be offered as a choice',
  )
})

// ---------------------------------------------------------------------------
// articles
// ---------------------------------------------------------------------------

test('GET article returns text and mtime', async () => {
  const workspace = await makeWorkspace()
  const app = await boot({ workspace })
  const { status, body } = await app.req(
    'GET',
    `/wechat-md/article?file=${encodeURIComponent('01_正文_示例.md')}`,
  )
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.ok(body.text.startsWith('# 示例'))
  assert.ok(body.mtime > 0)
})

test('GET article with a matching mtime answers "unchanged" and sends no text', async () => {
  const workspace = await makeWorkspace()
  const app = await boot({ workspace })
  const file = encodeURIComponent('01_正文_示例.md')

  const first = await app.req('GET', `/wechat-md/article?file=${file}`)
  const probe = await app.req('GET', `/wechat-md/article?file=${file}&mtime=${first.body.mtime}`)

  assert.equal(probe.status, 200)
  assert.equal(probe.body.unchanged, true, 'the 2.5s poll depends on this short-circuit')
  assert.equal(probe.body.text, undefined, 'an unchanged answer must not ship the body again')
})

test('GET article with a stale mtime returns the fresh text', async () => {
  const workspace = await makeWorkspace()
  const app = await boot({ workspace })
  const path = app.join('运营/articles/01_正文_示例.md')
  const file = encodeURIComponent('01_正文_示例.md')

  const first = await app.req('GET', `/wechat-md/article?file=${file}`)
  await writeFile(path, '# 示例\n\n改过了。\n', 'utf8')

  // The change probe compares timestamps with a 1 ms tolerance, so a rewrite
  // that lands on the same clock tick as the read would look "unchanged" and
  // the assertion below would fail for a reason that has nothing to do with the
  // route. Backdating the known mtime makes the staleness real and the test
  // deterministic. The tick-granularity risk itself is covered by the
  // "identical mtime" test right after this one.
  const { utimes } = await import('node:fs/promises')
  const stale = (first.body.mtime - 60_000) / 1000
  await utimes(path, stale, stale)

  const again = await app.req('GET', `/wechat-md/article?file=${file}&mtime=${first.body.mtime}`)
  assert.equal(again.body.unchanged, undefined)
  assert.ok(again.body.text.includes('改过了'), 'a changed file must be transferred')
})

test('FINDING: content edited within the same mtime tick reads as "unchanged"', async () => {
  const workspace = await makeWorkspace()
  const app = await boot({ workspace })
  const path = app.join('运营/articles/01_正文_示例.md')
  const file = encodeURIComponent('01_正文_示例.md')

  const first = await app.req('GET', `/wechat-md/article?file=${file}`)
  await writeFile(path, '# 示例\n\n改成完全不同的内容。\n', 'utf8')

  // Does this filesystem expose enough mtime resolution to see the rewrite?
  const { stat } = await import('node:fs/promises')
  const after = await stat(path)
  if (after.mtimeMs !== first.body.mtime) {
    // A fine-grained clock: the route sees the change and the property below is
    // not observable here. Recorded so the assertion never silently drifts.
    assert.ok(after.mtimeMs > first.body.mtime, 'a rewrite should advance the mtime')
    return
  }

  // A coarse clock (NTFS ticks are ~15 ms on Windows). The bytes on disk are
  // different but the timestamp is identical, so the probe answers "unchanged"
  // and the text is not transferred. Two consequences worth knowing:
  //   * the editor's 2.5 s poll can keep showing stale text, and
  //   * `saveArticle`'s optimistic-concurrency guard compares the same way, so
  //     a save over an agent's same-tick rewrite is allowed through.
  // Detection therefore cannot rely on mtime alone — a content hash, or the
  // byte size, would be needed.
  const probe = await app.req('GET', `/wechat-md/article?file=${file}&mtime=${first.body.mtime}`)
  assert.equal(probe.body.unchanged, true, 'identical mtime is read as unchanged')
  assert.equal(probe.body.text, undefined, 'and the fresh text is never sent')

  const { readFile } = await import('node:fs/promises')
  assert.ok(
    (await readFile(path, 'utf8')).includes('完全不同的内容'),
    'even though the file on disk really did change',
  )
})

test('GET article on a missing file answers 404 rather than throwing', async () => {
  const app = await boot({ workspace: await makeWorkspace() })
  const { status, body } = await app.req('GET', '/wechat-md/article?file=nope.md')
  assert.equal(status, 404)
  assert.equal(body.ok, false)
  assert.equal(body.error, 'not-found')
})

test('POST article writes the file through an atomic replace', async () => {
  const app = await boot({ workspace: await makeWorkspace() })
  const { status, body } = await app.req('POST', '/wechat-md/article', {
    file: '01_正文_示例.md',
    text: '# 示例\n\n被编辑器保存过。\n',
    mtime: 0,
  })

  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(await app.disk('运营/articles/01_正文_示例.md'), '# 示例\n\n被编辑器保存过。\n')

  const leftovers = (await import('node:fs/promises')).readdir(app.join('运营/articles'))
  assert.ok(
    !(await leftovers).some((name) => name.includes('.tmp')),
    'an atomic write must not leave a temp file behind',
  )
})

test('POST article refuses to clobber a version someone else wrote', async () => {
  const app = await boot({ workspace: await makeWorkspace() })
  const file = '01_正文_示例.md'
  const path = app.join('运营/articles', file)

  const read = await app.req('GET', `/wechat-md/article?file=${encodeURIComponent(file)}`)
  // The chat agent edits the same file between the editor's read and its save.
  await writeFile(path, '# 示例\n\nAI 改过的版本。\n', 'utf8')

  // The guard compares the caller's mtime with the file's, and it compares with
  // a 1 ms tolerance — so a rewrite landing on the same clock tick as the read
  // would let the stale save through (see the "same mtime tick" tests). The
  // agent's write is backdated to make the conflict unambiguous and the test
  // deterministic; the tick-granularity hole itself is pinned separately.
  const stale = (read.body.mtime - 60_000) / 1000
  await utimes(path, stale, stale)

  const save = await app.req('POST', '/wechat-md/article', {
    file,
    text: '# 示例\n\n编辑器里的旧版本。\n',
    mtime: read.body.mtime,
  })

  assert.equal(save.status, 409, 'a stale mtime is a conflict, not a silent overwrite')
  assert.equal(save.body.error, 'changed-on-disk')
  assert.ok(save.body.mtime > 0, 'the caller needs the new mtime to recover')
  assert.ok(
    (await app.disk('运营/articles/01_正文_示例.md')).includes('AI 改过的版本'),
    'the other writer\u2019s content must survive',
  )
})

test('FINDING: a stale save is accepted when the rewrite shares the read\u2019s mtime tick', async () => {
  const app = await boot({ workspace: await makeWorkspace() })
  const file = '01_正文_示例.md'
  const path = app.join('运营/articles', file)

  const read = await app.req('GET', `/wechat-md/article?file=${encodeURIComponent(file)}`)
  await writeFile(path, '# 示例\n\nAI 改过的版本，长度刻意不同。\n', 'utf8')

  const { stat } = await import('node:fs/promises')
  if ((await stat(path)).mtimeMs !== read.body.mtime) {
    // Fine-grained clock: the guard sees the change here, so this hole is not
    // observable on this filesystem. Recorded so the assertion cannot drift.
    return
  }

  const save = await app.req('POST', '/wechat-md/article', {
    file,
    text: '# 示例\n\n编辑器里的旧版本。\n',
    mtime: read.body.mtime,
  })

  // Same tick plus a different byte length is the realistic case: the agent
  // (or any other writer) rewrote the file while the editor had it open.
  assert.equal(save.status, 200, 'identical mtime is treated as "no conflict"')
  assert.ok((await app.disk('运营/articles/01_正文_示例.md')).includes('编辑器里的旧版本'))
})

test('POST article with no mtime writes regardless (explicit overwrite wins)', async () => {
  const app = await boot({ workspace: await makeWorkspace() })
  const save = await app.req('POST', '/wechat-md/article', {
    file: '01_正文_示例.md',
    text: '# 强制覆盖\n',
  })
  assert.equal(save.status, 200)
  assert.equal(await app.disk('运营/articles/01_正文_示例.md'), '# 强制覆盖\n')
})

test('POST article creates missing parent folders instead of failing', async () => {
  const app = await boot({ workspace: await makeWorkspace() })
  const save = await app.req('POST', '/wechat-md/article', {
    file: '子目录/新文章.md',
    text: '# 新\n',
  })
  assert.equal(save.status, 200)
  assert.equal(await app.disk('运营/articles/子目录/新文章.md'), '# 新\n')
})

// ---------------------------------------------------------------------------
// new article
// ---------------------------------------------------------------------------

test('POST article/new seeds a dated file and tells the editor where it is', async () => {
  const app = await boot({ workspace: await makeWorkspace() })
  const { status, body } = await app.req('POST', '/wechat-md/article/new', { title: '未命名文章' })

  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.match(body.file, /^\d{4}-\d{2}-\d{2}-.+\.md$/, `expected a dated slug, got ${body.file}`)
  assert.ok(body.text.startsWith('# '), 'the seed must open with the H1 the caret jumps to')
  assert.ok(app.exists(`运营/articles/${body.file}`), 'the file must actually be on disk')
})

test('creating the same title twice cannot collide', async () => {
  const app = await boot({ workspace: await makeWorkspace() })
  const first = await app.req('POST', '/wechat-md/article/new', { title: '同名文章' })
  const second = await app.req('POST', '/wechat-md/article/new', { title: '同名文章' })

  assert.notEqual(first.body.file, second.body.file, 'the second file must be bumped')
  assert.match(second.body.file, /-2\.md$/, `expected a -2 suffix, got ${second.body.file}`)
  assert.ok(app.exists(`运营/articles/${first.body.file}`))
  assert.ok(app.exists(`运营/articles/${second.body.file}`))
})

test('FINDING: a title containing dots makes article creation fail with 400', async () => {
  const app = await boot({ workspace: await makeWorkspace() })
  const { status, body } = await app.req('POST', '/wechat-md/article/new', {
    title: '../../etc/passwd:A*B?C',
  })

  // Observed behaviour, pinned so a fix is visible in the diff.
  //
  // `slugify` strips the characters Windows forbids but keeps `.`, so this
  // title becomes `2026-10-13-....etcpasswdABC.md`. `resolveInside` then
  // rejects any path containing `..` — correctly, as a containment rule — and
  // the route answers 400. The editor surfaces that as "新建失败", so a title
  // with two consecutive dots simply cannot create an article.
  //
  // Nothing escapes the workspace (the containment guard is what stops it), so
  // this is a usability defect, not a security hole.
  assert.equal(status, 400)
  assert.equal(body.error, 'bad path')
  assert.ok(
    !app.exists('运营/articles/2026-10-13-....etcpasswdABC.md'),
    'no file may be created outside, or with a traversing name',
  )

  // The same title minus the dots behaves normally, which is what proves the
  // dots — not the slashes or the punctuation — are the trigger.
  const clean = await app.req('POST', '/wechat-md/article/new', { title: 'etc/passwd:A*B?C' })
  assert.equal(clean.status, 200)
  assert.ok(!/[\\/:*?"<>|]/u.test(clean.body.file), `unsafe characters remain: ${clean.body.file}`)
  assert.ok(app.exists(`运营/articles/${clean.body.file}`))
})

// ---------------------------------------------------------------------------
// path containment — the security-critical part
// ---------------------------------------------------------------------------

test('an article path cannot escape its folder', async () => {
  const app = await boot({ workspace: await makeWorkspace() })
  for (const file of ['../secret.md', '..\\secret.md', '../../secret.md', '子/../../secret.md']) {
    const { status, body } = await app.req('GET', `/wechat-md/article?file=${encodeURIComponent(file)}`)
    assert.equal(status, 400, `${file} must be rejected`)
    assert.equal(body.ok, false)
  }
})

test('a POST cannot write outside the article folder', async () => {
  const app = await boot({ workspace: await makeWorkspace() })
  const { status } = await app.req('POST', '/wechat-md/article', {
    file: '../escaped.md',
    text: '不该被写出去',
  })
  assert.equal(status, 400)
  assert.ok(!app.exists('escaped.md'), 'nothing may be created outside the article folder')
})

test('a theme path cannot escape its folder', async () => {
  const app = await boot({ workspace: await makeWorkspace() })
  const read = await app.req('GET', `/wechat-md/theme?file=${encodeURIComponent('../oops.css')}`)
  assert.equal(read.status, 400)

  const write = await app.req('POST', '/wechat-md/theme', { file: '../oops.css', text: 'wrap{}' })
  assert.equal(write.status, 400)
  assert.ok(!app.exists('oops.css'))
})

test('an empty file parameter is rejected instead of defaulting to the folder', async () => {
  const app = await boot({ workspace: await makeWorkspace() })
  const { status } = await app.req('GET', '/wechat-md/article?file=')
  assert.equal(status, 400)
})

// ---------------------------------------------------------------------------
// image serving
// ---------------------------------------------------------------------------

test('GET file serves a workspace image with its real MIME type', async () => {
  const app = await boot({ workspace: await makeWorkspace() })
  await mkdir(app.join('运营/articles/assets'), { recursive: true })
  await writeFile(app.join('运营/articles/assets/a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

  const route = app.routes.find((entry) => entry.path === '/wechat-md/file')
  let headers = null
  let bodyBytes = null
  await route.handler(
    { method: 'GET', url: `/wechat-md/file?path=${encodeURIComponent('运营/articles/assets/a.png')}` },
    {
      writeHead(_status, value) {
        headers = value
      },
      end(data) {
        bodyBytes = data
      },
    },
  )

  assert.ok(headers !== null, 'the route must answer')
  assert.equal(headers['content-type'], 'image/png')
  assert.equal(headers['cache-control'], 'no-cache', 'a rewritten image must revalidate')
  assert.equal(bodyBytes.length, 4)
})

test('GET file refuses extensions that are not images', async () => {
  const app = await boot({ workspace: await makeWorkspace() })
  const route = app.routes.find((entry) => entry.path === '/wechat-md/file')
  let status = 0
  let payload = ''
  await route.handler(
    { method: 'GET', url: `/wechat-md/file?path=${encodeURIComponent('运营/articles/01_正文_示例.md')}` },
    {
      writeHead(value) {
        status = value
      },
      end(data) {
        payload = String(data)
      },
    },
  )
  assert.equal(status, 415, 'serving markdown through the image route would be an exfiltration path')
  assert.ok(payload.includes('unsupported-extension'))
})

test('GET file cannot read outside the workspace', async () => {
  const outside = await makeOutsideFile()
  const app = await boot({ workspace: await makeWorkspace() })
  const route = app.routes.find((entry) => entry.path === '/wechat-md/file')

  const attempts = [
    outside.file,
    `../${outside.file.replace(/\\/gu, '/').split('/').pop()}`,
    '..\\..\\secret.png',
  ]

  for (const attempt of attempts) {
    let status = 0
    let payload = ''
    await route.handler(
      { method: 'GET', url: `/wechat-md/file?path=${encodeURIComponent(attempt)}` },
      {
        writeHead(value) {
          status = value
        },
        end(data) {
          payload = String(data)
        },
      },
    )
    assert.ok(status === 403 || status === 400 || status === 404, `${attempt} must be refused, got ${status}`)
    assert.ok(!payload.includes('PNG'), 'no bytes of the outside file may be returned')
  }
})

test('GET file on a missing image answers 404', async () => {
  const app = await boot({ workspace: await makeWorkspace() })
  const route = app.routes.find((entry) => entry.path === '/wechat-md/file')
  let status = 0
  await route.handler(
    { method: 'GET', url: `/wechat-md/file?path=${encodeURIComponent('运营/articles/assets/gone.png')}` },
    {
      writeHead(value) {
        status = value
      },
      end() {},
    },
  )
  assert.equal(status, 404)
})

// ---------------------------------------------------------------------------
// themes
// ---------------------------------------------------------------------------

test('GET theme returns a stylesheet from the theme folder', async () => {
  const app = await boot({ workspace: await makeWorkspace() })
  const { status, body } = await app.req('GET', '/wechat-md/theme?file=moji.css')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.ok(body.text.includes('wrap'))
})

test('POST theme writes a new stylesheet the picker will find next scan', async () => {
  const app = await boot({ workspace: await makeWorkspace() })
  const save = await app.req('POST', '/wechat-md/theme', {
    file: 'canglan.css',
    text: 'wrap { label: 苍蓝 }\np { margin: 1em 0 }\n',
  })
  assert.equal(save.status, 200)
  assert.ok((await app.disk('运营/themes/canglan.css')).includes('苍蓝'))

  const state = await app.req('GET', '/wechat-md/state')
  assert.ok(state.body.themes.includes('canglan.css'))
})

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

test('POST config moves the article folder and materialises it', async () => {
  const app = await boot({ workspace: await makeWorkspace() })
  const save = await app.req('POST', '/wechat-md/config', { articlesDir: 'content' })
  assert.equal(save.status, 200)
  assert.equal(save.body.config.articlesDir, 'content')
  assert.ok(app.exists('content'), 'the chosen folder must be created so the next read finds it')
  assert.ok(app.exists('.wechat-md/wechat-md.json'), 'the choice must be persisted per workspace')

  const state = await app.req('GET', '/wechat-md/state')
  assert.equal(state.body.articlesDir, 'content')
})

test('POST config accepts the workspace root as the article folder', async () => {
  const app = await boot({ workspace: await makeWorkspace() })
  const save = await app.req('POST', '/wechat-md/config', { articlesDir: '.' })
  assert.equal(save.status, 200)
  assert.equal(save.body.config.articlesDir, '', 'the root is represented by the empty string')

  const state = await app.req('GET', '/wechat-md/state')
  assert.equal(state.body.articlesDir, '')
})

test('POST config rejects a traversal in either folder', async () => {
  const app = await boot({ workspace: await makeWorkspace() })
  const bad = await app.req('POST', '/wechat-md/config', { articlesDir: '../escape' })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error, 'invalid-articlesDir')

  const badTheme = await app.req('POST', '/wechat-md/config', { themesDir: '..\\escape' })
  assert.equal(badTheme.status, 400)
  assert.equal(badTheme.body.error, 'invalid-themesDir')
})

test('POST config ignores fields it does not own', async () => {
  const app = await boot({ workspace: await makeWorkspace() })
  const save = await app.req('POST', '/wechat-md/config', { articlesDir: 'content', root: '/etc' })
  assert.equal(save.status, 200)
  assert.equal(save.body.config.root, undefined, 'only the folder fields may be persisted')
})

// ---------------------------------------------------------------------------
// method handling
// ---------------------------------------------------------------------------

test('an unsupported method answers 405 rather than falling through', async () => {
  const app = await boot({ workspace: await makeWorkspace() })
  const { status, body } = await app.req('DELETE', '/wechat-md/article')
  assert.equal(status, 405)
  assert.equal(body.error, 'method-not-allowed')
})

test('the config route treats any non-POST method as a read', async () => {
  // It is the one route that does not answer 405: anything that is not a POST
  // falls through to "return the current config", which keeps a plain browser
  // navigation to the path working.
  const app = await boot({ workspace: await makeWorkspace() })
  const { status, body } = await app.req('PUT', '/wechat-md/config')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.config.articlesDir, '运营/articles')
})

// ---------------------------------------------------------------------------
// host integration
// ---------------------------------------------------------------------------

test('the storage seam is used when the host provides ctx.fs', async () => {
  const writes = []
  const workspace = await makeWorkspace()
  const app = await boot({
    workspace,
    services: {
      fs: {
        resolve: async (path) => path,
        writeText: async (target, text) => {
          writes.push(target)
          await writeFile(target, text, 'utf8')
          return { version: 'v1' }
        },
      },
      sandboxPolicy: { resolve: () => 'workspace-write' },
    },
  })

  const save = await app.req('POST', '/wechat-md/article', {
    file: '01_正文_示例.md',
    text: '# 走 ctx.fs\n',
  })

  assert.equal(save.status, 200)
  assert.equal(writes.length, 1, 'the host file service must be preferred over a local write')
  assert.ok(writes[0].endsWith('01_正文_示例.md'))
})

test('a host without the storage seam still works through the local fallback', async () => {
  const app = await boot({ workspace: await makeWorkspace() })
  const save = await app.req('POST', '/wechat-md/article', {
    file: '01_正文_示例.md',
    text: '# 本地兜底\n',
  })
  assert.equal(save.status, 200)
  assert.equal(await app.disk('运营/articles/01_正文_示例.md'), '# 本地兜底\n')
})
