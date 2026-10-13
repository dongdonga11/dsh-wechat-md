# dsh-wechat-md

> A **WeChat Official Account (公众号) markdown editor** in the DSH right sidebar: write, preview, and copy straight into the Official Account composer — sharing the same `.md` file with the chat agent.

[中文](README.md) · MIT

---

## Why

The Official Account composer does not accept markdown, and it drops `<style>` blocks and class names on paste. This plugin makes the right sidebar a markdown editor built for that target:

- **Source and preview side by side**, rendering the real Official Account layout
- **Copy to 公众号** inlines every declaration onto its element and writes rich HTML to the clipboard, so the paste keeps its styling
- **The article is an ordinary `.md` file.** The agent edits the same file with its ordinary file tools; the editor polls every 2.5s and reloads
- **Send to AI** hands the current file path plus your instruction to the session

Because the `.md` file is the single source of truth, the editor, the agent, and your own edits cannot diverge.

## Features

| | |
|---|---|
| Zero runtime dependencies | Node built-ins only on the host; a hand-written markdown renderer in the browser — no JSX, no bundler, no build step |
| Paste compatibility | Everything inlined; `<img width>` becomes an inline `width`; in-text anchors lose `href`; `var()` avoided |
| Three built-in themes | `classic` (blue, auto-numbers h2 as 一、二、三), `grace` (green), `simple` (grey) |
| Custom themes | Drop a `*.css` in the theme folder; the same name replaces a built-in outright |
| Switchable folders | Pick the article folder from the toolbar; the choice is stored per workspace |
| Optimistic concurrency | A save carries the mtime it read; if the agent rewrote the file the route answers `409` instead of clobbering |
| Containment | Every read and write is confined to the workspace; the image route is extension-allowlisted |

## Requirements

- Node.js **>= 20** (developed and verified on 24.18.0)
- A DSH host with the web server enabled
- Peers: `@deepseek-ai/cordis` (`~4.0.4`), `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-sidebar-right`, `react >= 18`

> DSH profiles default to `autoInstallPeers: false`, so peers are not installed for you — the profile must already provide them.

## Install

In a DSH profile directory (e.g. `~/.dsh/profiles/desktop`):

```json
{
  "dependencies": {
    "dsh-wechat-md": "link:D:/path/to/dsh-wechat-md"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-wechat-md"]
    }
  }
}
```

```bash
pnpm install
```

Restart DSH; a 「公众号排版」 tab appears in the right sidebar. Confirm it is alive:

```bash
curl http://127.0.0.1:19387/wechat-md/ping
# {"ok":true,"plugin":"dsh-wechat-md","root":"D:\\your-workspace"}
```

The loader row is declared by the package itself (`dsh.bundle.patch`), so no hand-editing of `cordis.patch.yml` is needed.

## Configuration

### Article and theme folders

Resolution order:

1. **Explicit** — `<workspace>/.wechat-md/wechat-md.json`, written for you when you switch folders in the UI:

   ```json
   { "articlesDir": "运营/articles", "themesDir": "运营/themes" }
   ```

2. **Convention** — the first that already exists:
   - articles: `运营/articles` → `articles` → `文章` → `content` → `posts`
   - themes: `运营/themes` → `themes` → `主题`
   - any `<name>/articles` one level down is also offered in the picker
3. **Fallback** — `运营/articles` and `运营/themes`, created if missing

### Pinning the workspace

The plugin is **not** session-scoped, while a DSH host serves many sessions at once, so it cannot reliably tell which workspace you are looking at. By default it guesses: `sessions` → `cwd` → workspace registry → process cwd. Pin it to remove the guess:

| Method | Usage |
|---|---|
| Environment | `DSH_WECHAT_MD_ROOT=D:\dongzhiAI` |
| File | one absolute path in `$DSH_HOME/wechat-md-root.txt` |

The pin wins and is re-read on every request, so it also overrides the 5-second root cache.

## HTTP surface

Seven same-origin JSON routes. Request bodies are capped at 8 MB.

| Method | Path | Purpose |
|---|---|---|
| GET | `/wechat-md/ping` | Liveness plus the resolved workspace `root` |
| GET | `/wechat-md/state` | Articles, themes, folder candidates, current config |
| GET | `/wechat-md/article?file=&mtime=` | Read one article; a matching `mtime` answers `{unchanged:true}` with no body |
| POST | `/wechat-md/article` | Write one article; a positive `mtime` enables optimistic concurrency (`409 changed-on-disk`) |
| POST | `/wechat-md/article/new` | Create an article as `YYYY-MM-DD-<slug>.md` |
| GET/POST | `/wechat-md/theme` | Read / write one theme stylesheet |
| GET/POST | `/wechat-md/config` | Read / change the two folders; any non-POST is treated as a read |
| GET | `/wechat-md/file?path=` | Preview support: one workspace image, extension-allowlisted |

Statuses: `400` bad path · `404` missing · `405` method not allowed · `409` conflict · `413` body too large · `415` not an image extension.

## Custom themes

Put `<name>.css` in the theme folder. Selectors are element names; every declaration is inlined onto that element:

```css
wrap { label: My Theme; font-size: 16px; line-height: 1.8; color: #333; counter: on }
h2   { font-size: 1.14em; font-weight: bold; color: #0F4C81 }
p    { margin: 1em 0; letter-spacing: 0.03em }
code { font: 90% Consolas,Monaco,monospace; background: #f6f6f6; padding: 1em }
strong { color: #c0392b }   /* optional emphasis colour */
```

- Properties are inlined verbatim, so any real CSS property works.
- **Avoid `var()`** — the Official Account editor does not resolve it on paste.
- The file **must** contain a `wrap {}` block, otherwise it is reported as unparseable.
- Theme files are re-fetched on every switch (cache-busted), so edits show up immediately.

## Tests

```bash
npm test
```

75 tests on Node's built-in `node:test` with **no test dependencies**:

| File | Covers |
|---|---|
| `test/client.smoke.test.mjs` | Module-loader contract, the slots and dictionaries `apply()` registers |
| `test/client.unit.test.mjs` | Markdown rendering, paste fixes, theme CSS parsing |
| `test/routes.test.mjs` | All seven routes, optimistic concurrency, atomic writes, **path-escape cases** |

`lib/client.js` is an IIFE with no exports and, deliberately, **no test seam**. `test/helpers.mjs` reaches its internal pure functions by slicing declarations out of the source and evaluating them — production code is untouched and no behaviour is re-implemented in the test.

`npm test` runs `test/run.mjs` rather than `node --test` directly, because the option that puts every file in one process is spelled differently across Node versions — and Node 20 has no such option at all:

| Version | Single-process option |
|---|---|
| Node 20 | **none** (the runner falls back to the default per-file isolation) |
| Node 22.8+ | `--experimental-test-isolation=none` |
| Node 23+ / 24 | `--test-isolation=none` |

The runner picks the spelling the runtime advertises and falls back to a plain `node --test` when there is none. Verified at 75/75 on Node 20.20.2, 22.14.0 and 24.18.0. CI does not need the flag (no sandbox restriction); it is only there so a confined local sandbox can run the suite.

## Known limitations

Reproducible as of this writing:

1. **Paragraphs, code blocks and quoted paragraphs inherit their line-height.**
   `wrap` declares it (classic 1.75 / grace 1.9 / simple 1.8), but `p`, `code` and the inner `<p>` of a blockquote declare none of their own. WeChat's validator distrusts an inherited line-height and reports `line-height-overlapping`. The inherited box is safe today (16px × 1.75 = 28px), and removing the warning means adding a `line-height` to each element in the built-in themes — which changes every article's HTML, so it has not been done unilaterally. A test pins the current behaviour.

2. **A title containing two consecutive dots cannot create an article.**
   `slugify` strips characters Windows forbids but keeps `.`, so a title like `../../etc/passwd` yields a candidate name containing `..`, which the containment guard rejects with `400 bad path` and the UI reports as 「新建失败」. It is a usability defect, not a hole — the guard is exactly what stops it. Also pinned by a test.

3. **The workspace pin may not take effect.**
   In one observation the running instance answered `/wechat-md/ping` with `root: D:\个人经营` while `$DSH_HOME/wechat-md-root.txt` said `D:\dongzhiAI`. Either the process predated the pin file or the pin path has a defect; not yet diagnosed. Before relying on the pin, request `/wechat-md/ping` once and check `root`.

4. **Coarse mtime resolution can hide a change.**
   Both the `unchanged` short-circuit on read and the `409` guard on save decide "did the file change?" by comparing mtime with a 1 ms tolerance. Filesystem timestamp granularity is often coarser than 1 ms (NTFS ticks are ~15 ms), so two writes inside one tick carry an identical mtime: the bytes on disk differ while the route answers `unchanged: true` and never transfers the text. In practice the editor's 2.5 s poll can keep showing stale text, and a save over an agent's same-tick rewrite is not treated as a conflict.
   Removing it means basing change detection on a content hash instead of mtime, or comparing the byte size alongside it. Both paths are pinned by `FINDING` cases in `test/routes.test.mjs`, which skip and leave a trace on filesystems with a fine enough clock.

## Security model

- Every file operation goes through `resolveInside()` / `resolveWorkspaceFile()`: absolute paths, `..` and `\0` are refused, and the resolved path is re-checked against the root.
- The image route `/wechat-md/file` allows only `png/jpg/jpeg/gif/webp/bmp/svg`.
- Writes prefer the host's `ctx.fs` + `sandboxPolicy` (atomic replacement, sandbox policy stays authoritative) and fall back to a local temp-file + rename.
- **Trust boundary:** the routes are unauthenticated and assume same-origin trust. They bind to localhost, reads are limited to workspace images, and the risk is accepted — but any page able to reach the host could in principle read images from your workspace.

## License

[MIT](LICENSE) © 2026 dsh-wechat-md contributors
