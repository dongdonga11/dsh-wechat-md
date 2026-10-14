/**
 * Unit tests for the markdown → WeChat-HTML pipeline.
 *
 * These are the tests that matter most: every rule here exists because the
 * Official Account editor silently mangles the input otherwise (it drops
 * `<style>` blocks and class names, ignores `var()`, and cannot follow in-text
 * anchors), so a regression is invisible in the editor and only shows up as a
 * broken paste in 公众号后台.
 *
 * The functions under test are extracted out of `lib/client.js` by
 * `helpers.loadPrivates()` — see that file for why the module has no test seam.
 */

import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'

import { loadPrivates } from './helpers.mjs'

const { fns } = loadPrivates()
const { renderInline, renderWeChat, blockify, parseThemeCss, wechatify, style } = fns

// `renderInline` reads the module-level `currentTheme` that `renderWeChat`
// assigns, so without this the emphasis tests would depend on some earlier test
// having rendered first. Pinning it here keeps every test order-independent.
beforeEach(() => {
  renderWeChat('', 'simple')
})

// ---------------------------------------------------------------------------
// inline rendering
// ---------------------------------------------------------------------------

test('escapes HTML before anything else can inject markup', () => {
  const html = renderInline('a < b > c & d " e')
  assert.ok(!html.includes('<b '), 'a literal tag must not survive')
  assert.ok(html.includes('&lt;'), 'angle brackets must be escaped')
  assert.ok(html.includes('&amp;'), 'ampersands must be escaped')
  assert.ok(html.includes('&quot;'), 'quotes must be escaped')
})

test('a code span is protected from the emphasis pass', () => {
  const html = renderInline('run `a * b _ c` now')
  assert.ok(html.includes('<code style='), 'code span must render as <code>')
  assert.ok(html.includes('a * b _ c'), 'the asterisk inside code must stay literal')
  assert.ok(!html.includes('<em>'), 'nothing inside code may become emphasis')
})

test('inline code carries line-height so WeChat does not flag the line box', () => {
  const html = renderInline('`code`')
  assert.ok(html.includes('line-height:inherit'), 'inline code needs an explicit line-height')
})

test('images get max-width and keep their alt text', () => {
  const html = renderInline('![配图说明](../assets/a.png)')
  assert.ok(html.includes('src="../assets/a.png"'), 'src must survive verbatim')
  assert.ok(html.includes('alt="配图说明"'), 'alt must survive')
  assert.ok(html.includes('max-width:100%'), 'images must be width-capped')
})

test('an angle-bracket image URL does not leak its brackets into src', () => {
  // Markdown permits `![alt](<path>)`, and that spelling is common in this
  // workspace. escapeHtml runs first, so the brackets arrive as entities and
  // the greedy src group used to swallow them — yielding
  // src="&lt;path&gt;", which no browser can load. Regression test for that.
  const html = renderInline('![说明](<assets/01_侧边栏入口_公众号排版标签.png>)')
  const src = /src="([^"]*)"/u.exec(html)?.[1]
  assert.equal(
    src,
    'assets/01_侧边栏入口_公众号排版标签.png',
    `brackets must not survive, got: ${src}`,
  )
  assert.ok(!html.includes('&lt;assets'), 'no escaped bracket may remain in src')
})

test('an angle-bracket link URL does not leak its brackets into href', () => {
  const html = renderInline('[文档](<https://example.com/a>)')
  const href = /href="([^"]*)"/u.exec(html)?.[1]
  assert.equal(href, 'https://example.com/a', `brackets must not survive, got: ${href}`)
})

test('links become inline-styled anchors in the WeChat link colour', () => {
  const html = renderInline('[文档](https://example.com/a)')
  assert.ok(html.includes('href="https://example.com/a"'))
  assert.ok(html.includes('color:#576b95'), 'WeChat links use #576b95')
  assert.ok(html.includes('text-decoration:none'))
})

test('bold, italic and strikethrough map to the right tags', () => {
  // `renderInline` reads the module-level `currentTheme` that `renderWeChat`
  // assigns, so it needs one render pass first. The simple theme declares no
  // `strong` colour, which is what the bare <strong> below asserts.
  renderWeChat('x', 'simple')
  const html = renderInline('**粗** 与 *斜* 与 ~~删~~')
  assert.ok(html.includes('<strong>粗</strong>'))
  assert.ok(html.includes('<em>斜</em>'))
  assert.ok(html.includes('<del>删</del>'))
})

test('a strong colour in the theme is copied onto <strong>', () => {
  renderWeChat('x', 'classic', { classic: { wrap: {}, p: {}, strong: { color: '#c00' } } })
  const html = renderInline('**重点**')
  assert.ok(html.includes('<strong style="color:#c00;">重点</strong>'), `got: ${html}`)
})

// ---------------------------------------------------------------------------
// block parsing
// ---------------------------------------------------------------------------

test('blockify strips HTML comments instead of leaking them into the paste', () => {
  const blocks = blockify('正文\n\n<!-- 这是编辑备注 -->\n\n更多正文')
  assert.equal(blocks.length, 2)
  const text = JSON.stringify(blocks)
  assert.ok(!text.includes('这是编辑备注'), 'comments are notes, never prose')
})

test('blockify recognises every block kind it claims to support', () => {
  const source = [
    '# 一级标题',
    '',
    '段落一',
    '',
    '> 引用一行',
    '> 引用二行',
    '',
    '- 无序甲',
    '- 无序乙',
    '',
    '1. 有序甲',
    '2. 有序乙',
    '',
    '| 列A | 列B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '```js',
    'const a = 1',
    '```',
    '',
    '---',
  ].join('\n')

  const types = blockify(source).map((block) => block.type)
  for (const kind of ['heading', 'p', 'quote', 'ul', 'ol', 'table', 'code', 'hr']) {
    assert.ok(types.includes(kind), `expected a ${kind} block, got ${types.join(',')}`)
  }
})

test('blockify normalises CRLF input', () => {
  const lf = blockify('# 标题\n\n段落')
  const crlf = blockify('# 标题\r\n\r\n段落')
  assert.deepEqual(crlf, lf, 'CRLF must parse identically to LF')
})

// ---------------------------------------------------------------------------
// full document rendering
// ---------------------------------------------------------------------------

test('renderWeChat emits exactly one outer <section> carrying the theme wrap', () => {
  const html = renderWeChat('# 标题\n\n正文一段。', 'classic')
  assert.equal(html.match(/<section/g)?.length, 1, 'one outer section only')
  assert.ok(html.startsWith('<section style="'))
  assert.ok(html.includes('font-size:16px'), 'classic wrap font-size')
  assert.ok(html.includes('line-height:1.75'), 'classic wrap line-height')
})

test('every paragraph carries the theme spacing inline', () => {
  const html = renderWeChat('第一段。\n\n第二段。', 'grace')
  const paragraphs = html.match(/<p style="[^"]*"/g) ?? []
  assert.ok(paragraphs.length >= 2, 'both paragraphs must render')
  for (const tag of paragraphs) {
    assert.ok(
      tag.includes('margin'),
      `a paragraph must at least carry the theme spacing: ${tag}`,
    )
  }
})

test('a theme that sets a line-height for <p> puts it on the element, not the wrapper', () => {
  const theme = { wrap: { 'font-size': '16px', 'line-height': '1.8' }, p: { margin: '1em 0', 'line-height': '1.8' } }
  const html = renderWeChat('一段。', 'classic', { classic: theme })
  const paragraph = html.match(/<p style="[^"]*"/)?.[0] ?? ''
  assert.ok(paragraph.includes('line-height:1.8'), `got: ${paragraph}`)
})

test('as shipped, a <p> inherits its line-height from the wrap and declares none of its own', () => {
  // This is the plugin's current behaviour and it is deliberate enough to pin
  // down: 公众号's validator is documented to distrust an inherited line-height,
  // which is why wechat_lint.py reports these elements. Fixing it means adding
  // a line-height to the built-in themes, which changes every article's HTML —
  // pinned here so that change is visible rather than silent.
  const html = renderWeChat('一段。', 'classic')
  const paragraph = html.match(/<p style="[^"]*"/)?.[0] ?? ''
  assert.ok(paragraph !== '', 'a paragraph must render')
  assert.ok(!paragraph.includes('line-height'), `expected no explicit line-height yet, got: ${paragraph}`)
  assert.ok(html.includes('line-height:1.75'), 'the wrap still carries the line-height everything inherits')
})

test('the inherited line box is never shorter than the text it wraps', () => {
  // The failure wechat_lint.py exists to catch: `line-height < font-size`.
  // Classic wrap is 16px / 1.75 => 28px, so every element that inherits it is
  // comfortably above its own font size.
  for (const theme of ['classic', 'grace', 'simple']) {
    const html = renderWeChat('一段。', theme)
    const wrap = html.match(/<section style="([^"]*)"/)?.[1] ?? ''
    const size = Number(/(?:font-size):([\d.]+)px/u.exec(wrap)?.[1])
    const height = Number(/(?:line-height):([\d.]+)/u.exec(wrap)?.[1])
    assert.ok(Number.isFinite(size), `${theme}: wrap font-size must be resolvable`)
    assert.ok(Number.isFinite(height), `${theme}: wrap line-height must be resolvable`)
    const pixels = height * size
    assert.ok(pixels >= size * 1.5, `${theme}: inherited line box ${pixels}px on ${size}px text is too tight`)
  }
})

test('a paragraph keeps its internal line breaks as <br>', () => {
  const html = renderWeChat('第一行\n第二行', 'classic')
  assert.ok(html.includes('<br>'), 'a soft wrap inside a paragraph must become <br>')
})

test('the classic theme numbers h2 headings 一、二、三', () => {
  const html = renderWeChat('## 第一节\n\n正文\n\n## 第二节\n\n正文', 'classic')
  assert.ok(html.includes('一、第一节'), `expected 一、 prefix, got: ${html}`)
  assert.ok(html.includes('二、第二节'), `expected 二、 prefix, got: ${html}`)
})

test('a hand-numbered heading keeps the author\u2019s own number', () => {
  const html = renderWeChat('## 一、我自己的编号', 'classic')
  assert.ok(html.includes('一、我自己的编号'), 'author numbering must be preserved')
  assert.ok(!html.includes('一、一、'), 'the counter must not double-number')
})

test('the grace theme does not number headings', () => {
  const html = renderWeChat('## 小节\n\n正文', 'grace')
  assert.ok(html.includes('<h2'), 'h2 still renders')
  assert.ok(!html.includes('一、'), 'grace sets counter: false')
})

test('code blocks land inside <pre> with the theme body styling', () => {
  const html = renderWeChat('```js\nconst a = 1\n```', 'classic')
  assert.ok(html.includes('<pre style="'), 'fenced code must use <pre>')
  assert.ok(html.includes('const a = 1'), 'code body must survive')
  assert.ok(/<pre style="[^"]*"><code style="[^"]*font:90%/.test(html), `code needs the theme font: ${html}`)
})

test('tables render as thead/tbody with styled cells', () => {
  const html = renderWeChat('| 列A | 列B |\n| --- | --- |\n| 1 | 2 |', 'classic')
  assert.ok(html.includes('<thead>') && html.includes('<tbody>'))
  assert.ok(html.includes('<th style="'))
  assert.ok(html.includes('<td style="'))
})

test('a short first column is kept from wrapping one character per line', () => {
  const html = renderWeChat('| 分数段 | 说明 |\n| --- | --- |\n| 90+ | 优秀 |', 'classic')
  assert.ok(html.includes('white-space:nowrap'), 'a <=6 char first cell needs nowrap')
})

test('a long first column is allowed to wrap normally', () => {
  const html = renderWeChat('| 这是一个很长的第一列表头 | 说明 |\n| --- | --- |\n| 长内容也一样很长 | 优秀 |', 'classic')
  assert.ok(!html.includes('white-space:nowrap'), 'long first cells must not be force-nowrapped')
})

test('a blockquote renders inner paragraphs that carry the theme body styling', () => {
  const html = renderWeChat('> 引用第一行\n>\n> 引用第二行', 'classic')
  assert.ok(html.includes('<blockquote style="'), 'quote must render as blockquote')
  const inner = html.match(/<blockquote[^>]*>(.*)<\/blockquote>/s)?.[1] ?? ''
  assert.ok(inner.includes('<p style="'), 'inner paragraphs must be styled')
  assert.ok(inner.includes('letter-spacing'), 'inner paragraphs inherit the theme body declarations')
  assert.equal(inner.match(/<p /g)?.length, 2, 'each quoted line becomes its own paragraph')
})

test('lists render with the theme list styling on both the list and its items', () => {
  const ul = renderWeChat('- 甲\n- 乙', 'classic')
  assert.ok(ul.includes('<ul style="'))
  assert.ok(ul.includes('<li style="'))
  assert.ok(ul.includes('甲') && ul.includes('乙'))

  const ol = renderWeChat('1. 甲\n2. 乙', 'classic')
  assert.ok(ol.includes('<ol style="'))
  assert.ok(ol.includes('<li style="'))
})

test('horizontal rules render with the theme border', () => {
  const html = renderWeChat('上文\n\n---\n\n下文', 'classic')
  assert.ok(/<hr style="[^"]*border-top/.test(html), `got: ${html}`)
})

test('an unknown theme name falls back to classic instead of throwing', () => {
  const html = renderWeChat('# 标题', 'no-such-theme')
  assert.ok(html.includes('font-size:16px'), 'should fall back to the classic palette')
})

// ---------------------------------------------------------------------------
// WeChat paste fixes
// ---------------------------------------------------------------------------

test('wechatify converts an <img width> attribute into an inline width style', () => {
  const out = wechatify('<p>图</p><img src="a.png" width="320" alt="x">')
  assert.ok(out.includes('width:320px'), 'width must become an inline style')
  assert.ok(!/\swidth="320"/.test(out), 'the attribute form must be gone')
  assert.ok(!/style="[^"]*"\s*style="/.test(out), 'no duplicate style attributes')
})

test('wechatify strips the href of in-text anchor links', () => {
  const out = wechatify('<a href="#section-2" style="color:#576b95;">跳转</a>')
  assert.ok(!out.includes('href='), 'an in-text anchor cannot be followed in 公众号')
  assert.ok(out.includes('跳转'), 'the label must survive')
})

test('wechatify leaves absolute links alone', () => {
  const out = wechatify('<a href="https://example.com">外部</a>')
  assert.ok(out.includes('href="https://example.com"'), 'external links must be kept')
})

// ---------------------------------------------------------------------------
// theme stylesheets
// ---------------------------------------------------------------------------

const THEME_CSS = `
/* 注释必须被忽略 */
wrap { font-size: 17px; line-height: 2; color: #222; counter: off; label: 我的主题 }
h2, h3 { color: #c00 }
p { margin: 1em 0 }
p { line-height: 1.9 }
`

test('parseThemeCss reads selectors, merges duplicates and pulls out meta keys', () => {
  const theme = parseThemeCss(THEME_CSS)
  assert.ok(theme !== null, 'a stylesheet with wrap {} must parse')
  assert.equal(theme.wrap['font-size'], '17px')
  assert.equal(theme.label, '我的主题', 'label is lifted out for the dropdown')
  assert.ok(!('label' in theme.wrap), 'label must not leak into the inline styles')
  assert.equal(theme.counter, false, 'counter: off disables heading numbering')
  assert.equal(theme.h2.color, '#c00', 'comma-separated selectors share one body')
  assert.equal(theme.h3.color, '#c00')
  assert.equal(theme.p['line-height'], '1.9', 'a later rule wins over an earlier one')
  assert.equal(theme.p.margin, '1em 0', 'merge must not drop the earlier declaration')
})

test('parseThemeCss honours counter: on', () => {
  const theme = parseThemeCss('wrap { counter: on }\np { margin: 0 }')
  assert.equal(theme.counter, true)
})

test('parseThemeCss returns null when there is no wrap block', () => {
  assert.equal(parseThemeCss('h1 { color: red }'), null)
})

test('parseThemeCss refuses empty or non-string input', () => {
  assert.equal(parseThemeCss(''), null)
  assert.equal(parseThemeCss('   '), null)
  assert.equal(parseThemeCss(undefined), null)
  assert.equal(parseThemeCss(42), null)
})

test('a theme file replaces the built-in palette of the same name', () => {
  const override = {
    wrap: { 'font-size': '21px', 'line-height': '2.2' },
    p: { margin: '0' },
    h1: {}, h2: {}, h3: {}, h4: {},
    quote: {}, li: {}, ul: {}, ol: {}, hr: {}, code: {}, th: {}, td: {}, table: {},
  }
  const html = renderWeChat('# 标题\n\n正文', 'classic', { classic: override })
  assert.ok(html.includes('font-size:21px'), 'the file must win over the built-in')
  assert.ok(!html.includes('font-size:16px'), 'the built-in size must be gone')
})

// ---------------------------------------------------------------------------
// style() contract
// ---------------------------------------------------------------------------

test('style() drops empty declarations and always terminates with a semicolon', () => {
  const out = style({ color: '#333', margin: '', 'padding-top': undefined, border: null })
  assert.equal(out, 'color:#333;')
})
