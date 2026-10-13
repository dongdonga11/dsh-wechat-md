# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `LICENSE` (MIT), `README.md`, `README.en.md`.
- Test suite: 73 tests on `node:test`, no test dependencies.
  - `test/client.smoke.test.mjs` — module-loader contract and the slots
    `apply()` registers.
  - `test/client.unit.test.mjs` — markdown rendering, WeChat paste fixes and
    theme CSS parsing, driven through the module's own pure functions.
  - `test/routes.test.mjs` — all seven routes, optimistic concurrency, atomic
    writes, and the path-containment guards.
  - `test/helpers.mjs` — loads the browser half in a `vm` sandbox and reaches
    its internals without adding a test seam to production code.
- `npm run check` for a syntax-only pass over both halves.

### Changed

- Hardened two timing-sensitive spots in the suite: the "fresh workspace" test
  now polls for the folders the fire-and-forget effect creates instead of
  sleeping a fixed 20 ms, and the emphasis tests pin `currentTheme` in a
  `beforeEach` instead of relying on an earlier test having rendered first.

### Known issues

- Paragraphs, code blocks and the inner paragraphs of blockquotes declare no
  `line-height` of their own and inherit it from the `wrap` section, which
  WeChat's validator is documented to distrust. Fixing it changes every
  article's HTML, so it is recorded rather than changed.
- A title containing two consecutive dots produces a candidate filename with
  `..` in it, which the containment guard rejects; `POST
  /wechat-md/article/new` therefore answers `400` and the editor reports
  「新建失败」.
- The workspace pin (`DSH_WECHAT_MD_ROOT`, `$DSH_HOME/wechat-md-root.txt`) was
  observed not to take effect in a running instance. Not yet diagnosed.

## [0.1.0] - 2026-10-05

### Added

- WeChat Official Account markdown editor as a DSH right-sidebar tab.
- Node half (`lib/index.js`): seven same-origin JSON routes for state, article
  read/write, article creation, theme read/write, image serving and folder
  configuration; atomic writes through the host's `ctx.fs` when available, with
  a local temp-file + rename fallback; workspace-relative path containment.
- Browser half (`lib/client.js`): dependency-free markdown renderer that emits
  one `<section>` of inline styles, three built-in themes, theme-file overrides,
  side-by-side source/preview panes, "copy to 公众号" via the rich clipboard,
  "send to AI" into the session, and a 2.5-second disk poll with optimistic
  concurrency on save.

[Unreleased]: https://github.com/dongdonga11/dsh-wechat-md/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/dongdonga11/dsh-wechat-md/releases/tag/v0.1.0
