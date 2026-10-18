/**
 * dsh-wechat-md — browser half.
 *
 * A WeChat Official Account (公众号) markdown editor living in the right
 * sidebar. Deliberately dependency-free: no JSX, no bundler, no non-baseline
 * module requests, so the module system can serve this file as-is.
 *
 * Layout: a compact toolbar, then side-by-side 原文 / 预览 panes in a wide
 * pane and a single toggled pane when narrow.
 *
 * WeChat paste compatibility rules this renderer implements:
 * styles must be inlined onto elements (WeChat drops <style> blocks and class
 * names), `var()` and pseudo-classes are resolved here rather than left to CSS,
 * `<img width>` attributes become inline `width`, and in-text anchor links lose
 * their href.
 */

window.__ModuleLoader__.load({
  id: 'dsh-wechat-md',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const react = require('react')

    const NS = 'wechatMd'
    const KIND = 'wechat-md'
    const ID = 'dsh-wechat-md'

    const zh = {
      label: '公众号排版',
      guideTitle: '公众号排版',
      guideDesc: '写公众号文章 · 预览 · 复制',
    }
    const en = {
      label: 'WeChat Editor',
      guideTitle: 'WeChat Editor',
      guideDesc: 'Write, preview and copy Official Account posts',
    }

    // `shortcuts` 供可点击指南卡与快捷键直达使用（宿主没有该服务时 inject 会拒绝，
    // 插件其余部分仍可用——这也是为什么打开逻辑都做了降级）。
    const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'shortcuts']

    // ======================================================================
    // Markdown → HTML
    // ======================================================================

    const escapeHtml = (text) =>
      String(text).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;')

    const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十']

    /** Inline markdown: code, images, links, bold, italic, strikethrough. */
    function renderInline(text) {
      let out = escapeHtml(text)
      const codes = []
      out = out.replace(/`([^`]+)`/gu, (_m, code) => {
        codes.push(code)
        return `\u0000CODE${codes.length - 1}\u0000`
      })
      out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu, (_m, alt, src) => {
        // Markdown allows the URL to be wrapped as <path>; escapeHtml has already
        // turned those brackets into entities, and the greedy src group swallowed
        // them — unwrap here or every image renders with a src of "&lt;path&gt;".
        const clean = src.startsWith('&lt;') && src.endsWith('&gt;') ? src.slice(4, -4) : src
        return `<img src="${clean}" alt="${alt}" style="max-width:100%;">`
      })
      out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu, (_m, label, href) => {
        const clean = href.startsWith('&lt;') && href.endsWith('&gt;') ? href.slice(4, -4) : href
        return `<a href="${clean}" style="color:#576b95;text-decoration:none;">${label}</a>`
      })
      out = out.replace(/\*\*([^*]+)\*\*/gu, (_m, bold) => {
        const strongColor = currentTheme === undefined ? undefined : (currentTheme.strong ?? {}).color
        return strongColor === undefined
          ? `<strong>${bold}</strong>`
          : `<strong style="color:${strongColor};">${bold}</strong>`
      })
      out = out.replace(/(^|[^*])\*([^*\n]+)\*/gu, '$1<em>$2</em>')
      out = out.replace(/~~([^~]+)~~/gu, '<del>$1</del>')
      out = out.replace(/\u0000CODE(\d+)\u0000/gu, (_m, i) => {
        const code = escapeHtml(codes[Number(i)] ?? '')
        return `<code style="font-family:Consolas,Monaco,monospace;font-size:90%;line-height:inherit;background:rgba(27,31,35,0.05);padding:2px 4px;border-radius:3px;">${code}</code>`
      })
      return out
    }

    /** Split a markdown document into block-level chunks. */
    function blockify(source) {
      const lines = String(source ?? '')
        .replace(/\r\n?/gu, '\n')
        // Comments are invisible notes, never prose: drop them before block
        // parsing so a `<!-- ... -->` cannot leak into the WeChat body.
        .replace(/<!--[\s\S]*?-->/gu, '')
        .split('\n')
      const blocks = []
      let i = 0

      const isBlank = (line) => line.trim().length === 0

      while (i < lines.length) {
        const line = lines[i]

        if (isBlank(line)) {
          i += 1
          continue
        }

        // fenced code
        const fence = /^\s*(```|~~~)\s*([^\s`]*)\s*$/u.exec(line)
        if (fence !== null) {
          const marker = fence[1]
          const lang = fence[2] ?? ''
          const body = []
          i += 1
          while (i < lines.length && !new RegExp(`^\\s*${marker}\\s*$`, 'u').test(lines[i])) {
            body.push(lines[i])
            i += 1
          }
          i += 1
          blocks.push({ type: 'code', lang, text: body.join('\n') })
          continue
        }

        // horizontal rule
        if (/^\s*([-*_])\s*(?:\1\s*){2,}$/u.test(line)) {
          blocks.push({ type: 'hr' })
          i += 1
          continue
        }

        // heading
        const heading = /^(#{1,6})\s+(.*)$/u.exec(line)
        if (heading !== null) {
          blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] })
          i += 1
          continue
        }

        // blockquote (consecutive > lines)
        if (/^\s*>/u.test(line)) {
          const body = []
          while (i < lines.length && /^\s*>/u.test(lines[i])) {
            body.push(lines[i].replace(/^\s*>\s?/u, ''))
            i += 1
          }
          blocks.push({ type: 'quote', text: body.join('\n') })
          continue
        }

        // table
        if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/u.test(lines[i + 1])) {
          const split = (row) =>
            row
              .trim()
              .replace(/^\|/u, '')
              .replace(/\|$/u, '')
              .split('|')
              .map((cell) => cell.trim())
          const head = split(line)
          i += 2
          const rows = []
          while (i < lines.length && lines[i].includes('|') && !isBlank(lines[i])) {
            rows.push(split(lines[i]))
            i += 1
          }
          blocks.push({ type: 'table', head, rows })
          continue
        }

        // unordered list
        if (/^\s*[-*+]\s+/u.test(line)) {
          const items = []
          while (i < lines.length && /^\s*[-*+]\s+/u.test(lines[i])) {
            items.push(lines[i].replace(/^\s*[-*+]\s+/u, ''))
            i += 1
          }
          blocks.push({ type: 'ul', items })
          continue
        }

        // ordered list
        if (/^\s*\d+[.)]\s+/u.test(line)) {
          const items = []
          while (i < lines.length && /^\s*\d+[.)]\s+/u.test(lines[i])) {
            items.push(lines[i].replace(/^\s*\d+[.)]\s+/u, ''))
            i += 1
          }
          blocks.push({ type: 'ol', items })
          continue
        }

        // paragraph
        const body = []
        while (i < lines.length && !isBlank(lines[i]) && !/^\s*(#{1,6}\s|>|```|~~~|[-*+]\s|\d+[.)]\s)/u.test(lines[i])) {
          body.push(lines[i])
          i += 1
        }
        blocks.push({ type: 'p', text: body.join('\n') })
      }

      return blocks
    }

    /** Render inline `style` attributes from a declaration map. */
    const style = (declarations) =>
      Object.entries(declarations)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${key}:${value}`)
        .join(';') + ';'

    /**
     * WeChat themes.
     *
     * Every rule is emitted as an inline `style` on the element it belongs to,
     * because the Official Account editor discards `<style>` blocks and class
     * names on paste. `wrap` styles the outer section, the rest are per-element.
     * `counter: true` renders h2 as 一、二、三… like most 公众号 templates.
     *
     * Keys match the theme folder's `*.css` file stems: when such a file exists it
     * replaces the built-in palette of the same key, otherwise this built-in is
     * used so the editor works before any file is authored.
     */
    const THEMES = {
      classic: {
        label: '经典（蓝）',
        counter: true,
        wrap: { 'font-size': '16px', 'line-height': '1.75', color: '#3f3f3f', 'text-align': 'left', 'letter-spacing': '0.03em', 'word-break': 'break-word' },
        h1: { 'font-size': '1.35em', 'font-weight': 'bold', 'text-align': 'center', 'margin': '1.4em 0 1em', color: '#0F4C81' },
        h2: { 'font-size': '1.2em', 'font-weight': 'bold', 'text-align': 'center', display: 'table', margin: '1.8em auto 1em', padding: '0.1em 0.6em', background: '#0F4C81', color: '#ffffff', 'border-radius': '3px' },
        h3: { 'font-size': '1.08em', 'font-weight': 'bold', margin: '1.6em 0 0.8em', color: '#0F4C81', 'border-left': '4px solid #0F4C81', 'padding-left': '8px' },
        h4: { 'font-size': '1em', 'font-weight': 'bold', margin: '1.4em 0 0.7em', color: '#0F4C81' },
        p: { margin: '1.1em 0', 'letter-spacing': '0.05em' },
        quote: { margin: '1.2em 0', padding: '0.8em 1em', 'border-left': '4px solid #0F4C81', background: '#f7f7f7', color: '#666666', 'border-radius': '2px' },
        ul: { margin: '1em 0', 'padding-left': '1.4em' },
        ol: { margin: '1em 0', 'padding-left': '1.4em' },
        li: { margin: '0.4em 0', 'letter-spacing': '0.05em' },
        hr: { border: 'none', 'border-top': '1px dashed #d0d0d0', margin: '2em 0' },
        code: { font: '90% Consolas,Monaco,monospace', background: '#f6f8fa', display: 'block', padding: '1em', 'border-radius': '4px', overflow: 'auto', 'white-space': 'pre' },
        link: { color: '#576b95', 'text-decoration': 'none' },
        table: { 'border-collapse': 'collapse', width: '100%', margin: '1.2em 0', 'font-size': '0.95em' },
        th: { border: '1px solid #e5e5e5', padding: '0.5em 0.7em', background: '#f7f7f7', 'font-weight': 'bold', 'text-align': 'left' },
        td: { border: '1px solid #e5e5e5', padding: '0.5em 0.7em' },
      },
      grace: {
        label: '优雅（绿）',
        counter: false,
        wrap: { 'font-size': '15px', 'line-height': '1.9', color: '#333333', 'text-align': 'left', 'letter-spacing': '0.06em', 'word-break': 'break-word' },
        h1: { 'font-size': '1.3em', 'font-weight': 'normal', 'text-align': 'center', margin: '1.6em 0 1.2em', color: '#009874', 'letter-spacing': '0.15em' },
        h2: { 'font-size': '1.12em', 'font-weight': 'bold', margin: '2em 0 1em', 'padding-bottom': '0.35em', color: '#009874', 'border-bottom': '1px solid #b7e0d5' },
        h3: { 'font-size': '1em', 'font-weight': 'bold', margin: '1.6em 0 0.8em', color: '#009874' },
        h4: { 'font-size': '0.98em', 'font-weight': 'bold', margin: '1.4em 0 0.7em', color: '#444444' },
        p: { margin: '1.3em 0' },
        quote: { margin: '1.4em 0', padding: '0.6em 1em', 'border-left': '3px solid #009874', background: '#f4faf8', color: '#5c5c5c' },
        ul: { margin: '1.1em 0', 'padding-left': '1.4em' },
        ol: { margin: '1.1em 0', 'padding-left': '1.4em' },
        li: { margin: '0.5em 0' },
        hr: { border: 'none', 'border-top': '1px solid #eeeeee', margin: '2.2em 0' },
        code: { font: '90% Consolas,Monaco,monospace', background: '#f5f7f6', display: 'block', padding: '1em', 'border-radius': '4px', overflow: 'auto', 'white-space': 'pre' },
        link: { color: '#576b95', 'text-decoration': 'none' },
        table: { 'border-collapse': 'collapse', width: '100%', margin: '1.2em 0', 'font-size': '0.94em' },
        th: { border: '1px solid #d8ebe5', padding: '0.5em 0.7em', background: '#f4faf8', 'text-align': 'left' },
        td: { border: '1px solid #d8ebe5', padding: '0.5em 0.7em' },
      },
      simple: {
        label: '简洁（灰）',
        counter: false,
        wrap: { 'font-size': '16px', 'line-height': '1.8', color: '#333333', 'text-align': 'left', 'word-break': 'break-word' },
        h1: { 'font-size': '1.3em', 'font-weight': 'bold', margin: '1.4em 0 0.9em', color: '#111111' },
        h2: { 'font-size': '1.14em', 'font-weight': 'bold', margin: '1.8em 0 0.9em', color: '#111111' },
        h3: { 'font-size': '1.02em', 'font-weight': 'bold', margin: '1.5em 0 0.7em', color: '#111111' },
        h4: { 'font-size': '1em', 'font-weight': 'bold', margin: '1.3em 0 0.6em', color: '#333333' },
        p: { margin: '1em 0' },
        quote: { margin: '1.2em 0', padding: '0.6em 1em', 'border-left': '3px solid #cccccc', background: '#fafafa', color: '#666666' },
        ul: { margin: '1em 0', 'padding-left': '1.4em' },
        ol: { margin: '1em 0', 'padding-left': '1.4em' },
        li: { margin: '0.4em 0' },
        hr: { border: 'none', 'border-top': '1px solid #e8e8e8', margin: '2em 0' },
        code: { font: '90% Consolas,Monaco,monospace', background: '#f6f6f6', display: 'block', padding: '1em', 'border-radius': '4px', overflow: 'auto', 'white-space': 'pre' },
        link: { color: '#576b95', 'text-decoration': 'none' },
        table: { 'border-collapse': 'collapse', width: '100%', margin: '1.2em 0', 'font-size': '0.95em' },
        th: { border: '1px solid #e0e0e0', padding: '0.5em 0.7em', background: '#fafafa', 'text-align': 'left' },
        td: { border: '1px solid #e0e0e0', padding: '0.5em 0.7em' },
      },
    }

    /**
     * Theme in effect for the render pass, read by renderInline so `<strong>`
     * can carry the theme's emphasis colour. Set at the top of
     * renderWeChat; renderInline has nine call sites and no theme argument.
     */
    let currentTheme

    /**
     * Parse one editable theme stylesheet into the inline-style maps
     * `renderWeChat` consumes.
     *
     * The file uses plain CSS selectors — `wrap {}` for the outer section and
     * `h1 {}`, `p {}`, `quote {}`, `code {}`, `table {}`, `th {}`, `td {}`,
     * `link {}`, `hr {}`, `ul {}`, `ol {}`, `li {}`, `h2 {}` … for the
     * elements. One extra declaration is honoured: `counter: on|off` inside
     * `wrap {}` switches the 一、二、三 heading numbering. Properties are read
     * verbatim and later emitted inline, so any real CSS property works, and
     * `var()` should be avoided because WeChat does not resolve it on paste.
     *
     * @param css - stylesheet text.
     * @returns the theme maps, or `null` when no rule block could be read.
     */
    function parseThemeCss(css) {
      if (typeof css !== 'string' || css.trim().length === 0) return null
      const withoutComments = css.replace(/\/\*[\s\S]*?\*\//gu, '')
      const map = {}
      let counter = undefined
      let found = false
      const ruleRe = /([^{}]+)\{([^{}]*)\}/gu
      let rule = ruleRe.exec(withoutComments)
      while (rule !== null) {
        const selector = rule[1].trim()
        const body = rule[2]
        found = true
        const declarations = {}
        for (const piece of body.split(';')) {
          const colon = piece.indexOf(':')
          if (colon < 0) continue
          const key = piece.slice(0, colon).trim().toLowerCase()
          const value = piece.slice(colon + 1).trim()
          if (key.length === 0 || value.length === 0) continue
          if (key === 'counter') {
            counter = !/^(off|false|no|0)$/iu.test(value)
            continue
          }
          declarations[key] = value
        }
        // `wrap` may carry extra top-level selectors separated by commas.
        for (const single of selector.split(',')) {
          const key = single.trim().toLowerCase()
          if (key.length === 0) continue
          map[key] = { ...(map[key] ?? {}), ...declarations }
        }
        rule = ruleRe.exec(withoutComments)
      }
      if (!found || map.wrap === undefined) return null
      const label = map.wrap.label
      delete map.wrap.label
      const theme = {}
      for (const [key, value] of Object.entries(map)) theme[key] = value
      if (counter !== undefined) theme.counter = counter
      if (label !== undefined) theme.label = label
      return theme
    }

    /**
     * Render markdown to WeChat-paste-ready HTML.
     *
     * @param source - markdown text.
     * @param themeName - one of THEMES.
     * @param userThemes - optional theme-folder `*.css` overrides, keyed by file
     *   stem, replacing the built-in palette of the theme of the same name.
     * @returns one `<section>` carrying inline styles only.
     */
    function renderWeChat(source, themeName, userThemes) {
      const override = userThemes === undefined ? undefined : userThemes[themeName]
      const theme = override ?? THEMES[themeName] ?? THEMES.classic
      currentTheme = theme
      const blocks = blockify(source)
      const parts = []
      let sectionIndex = 0

      for (const block of blocks) {
        switch (block.type) {
          case 'heading': {
            const key = `h${block.level}`
            const base = theme[key] ?? theme.h4 ?? {}
            if (block.level === 2 && theme.counter) {
              sectionIndex += 1
              const label = CN_NUM[sectionIndex - 1] ?? String(sectionIndex)
              // A hand-written 「一、」/「1.」 heading keeps its own number; the
              // theme counter only supplies one when the author wrote none.
              const alreadyNumbered = /^\s*(?:[一二三四五六七八九十百]+|[0-9]+)\s*[、.．)）]/u.test(block.text)
              const heading = alreadyNumbered ? block.text : `${label}、${block.text}`
              parts.push(`<h2 style="${style(base)}">${renderInline(heading)}</h2>`)
            } else {
              parts.push(`<${key} style="${style(base)}">${renderInline(block.text)}</${key}>`)
            }
            break
          }
          case 'p':
            parts.push(`<p style="${style(theme.p)}">${renderInline(block.text).replace(/\n/gu, '<br>')}</p>`)
            break
          case 'quote':
            parts.push(`<blockquote style="${style(theme.quote)}">${blockify(block.text).map((inner) => (inner.type === 'p' ? `<p style="${style(theme.p)}margin:0.3em 0;">${renderInline(inner.text)}</p>` : '')).join('')}</blockquote>`)
            break
          case 'ul':
            parts.push(
              `<ul style="${style(theme.ul)}">${block.items.map((item) => `<li style="${style(theme.li)}">${renderInline(item)}</li>`).join('')}</ul>`,
            )
            break
          case 'ol':
            parts.push(
              `<ol style="${style(theme.ol)}">${block.items.map((item) => `<li style="${style(theme.li)}">${renderInline(item)}</li>`).join('')}</ol>`,
            )
            break
          case 'code': {
            const themeCode = { ...theme.code }
            parts.push(`<pre style="margin:1.2em 0;"><code style="${style(themeCode)}${style(theme.p)}">${escapeHtml(block.text)}</code></pre>`)
            break
          }
          case 'hr':
            parts.push(`<hr style="${style(theme.hr)}">`)
            break
          case 'table': {
            const head = block.head.map((cell) => `<th style="${style(theme.th)}">${renderInline(cell)}</th>`).join('')
            const rows = block.rows
              .map(
                (row) =>
                  `<tr>${row
                    .map((cell, index) => {
                      // Keep a narrow first column from being squeezed into one
                      // character per line (`分数段` rendering vertically). The
                      // hint only applies to short cells, so a long first cell
                      // still wraps normally.
                      const nowrap = index === 0 && cell.length <= 6 ? 'white-space:nowrap;' : ''
                      return `<td style="${style(theme.td)}${nowrap}">${renderInline(cell)}</td>`
                    })
                    .join('')}</tr>`,
              )
              .join('')
            parts.push(`<table style="${style(theme.table)}"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`)
            break
          }
          default:
            break
        }
      }

      return `<section style="${style(theme.wrap)}">${parts.join('\n')}</section>`
    }

    /**
     * WeChat paste fixes applied to ready HTML: images keep an inline width
     * instead of an attribute, and in-text anchor links lose their href because
     * the Official Account reader cannot follow them.
     */
    function wechatify(html) {
      return html
        .replace(/<img([^>]*?)\swidth="(\d+)"([^>]*)>/gu, (_m, before, width, after) => {
          const cleaned = `${before}${after}`.replace(/\sstyle="([^"]*)"/u, (_s, existing) => ` style="${existing};width:${width}px;"`)
          return `<img${cleaned} style="width:${width}px;">`.replace(/style="[^"]*"\s*style="/u, 'style="')
        })
        .replace(/<a([^>]*?)\shref="#[^"]*"([^>]*)>/gu, '<a$1$2>')
    }

    // ======================================================================
    // Tab bodies
    // ======================================================================

    const api = {
      get: (path) => fetch(path, { headers: { accept: 'application/json' } }).then((r) => r.json()),
      post: (path, body) =>
        fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        }).then((r) => r.json()),
    }

    const baseName = (file) => String(file ?? '').replace(/\.(md|markdown|css)$/iu, '')

    /** Imperative editor UI mounted inside one React host element. */
    function createEditor(host, options) {
      const { sessionId, inputActions } = options
      // 宿主没提供这个能力时为 undefined（老宿主/精简宿主），调用处都做了可选链。
      const openInSidebar = typeof options.openInSidebar === 'function' ? options.openInSidebar : undefined
      // 读取"编辑器此刻是否可见"：只在不可见时才需要主动弹出来。
      const isVisible = typeof options.isVisible === 'function' ? options.isVisible : () => true
      const AUTO_REVEAL_KEY = 'dsh.wechat-md.autoReveal'

      /** 用户是否希望"AI 改稿后自动弹出编辑器"，默认开。 */
      const readAutoReveal = () => {
        try {
          return window.localStorage.getItem(AUTO_REVEAL_KEY) !== 'off'
        } catch {
          return true
        }
      }

      const state = {
        file: options.initialFile ?? '',
        text: '',
        mtime: 0,
        diskText: '',
        status: '',
        tone: '#888888',
        view: 'split',
        theme: 'classic',
        userThemes: {},
        /** Bumped per theme fetch so a browser cache can never serve stale CSS. */
        themeRevision: 0,
        articles: [],
        themes: [],
        /** Workspace-relative folder the editor reads and writes. */
        articlesDir: '',
        /** Folders the workspace may choose from, from the Host. */
        articleDirs: [],
        dirty: false,
        /** 「AI 改稿后自动把侧边栏叫出来」，可在工具栏关掉。 */
        autoReveal: readAutoReveal(),
      }

      const el = (tag, props, children) => {
        const node = document.createElement(tag)
        if (props !== undefined) {
          for (const [key, value] of Object.entries(props)) {
            if (key === 'style') node.setAttribute('style', value)
            else if (key === 'text') node.textContent = String(value)
            else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
            else if (value !== undefined && value !== null) node.setAttribute(key, String(value))
          }
        }
        for (const child of children ?? []) if (child !== undefined && child !== null) node.append(child)
        return node
      }

      const styleText = {
        root: 'display:flex;flex-direction:column;height:100%;min-height:0;font:13px/1.6 system-ui,-apple-system,"Microsoft YaHei",sans-serif;color:inherit;',
        bar: 'display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid rgba(127,127,127,0.22);flex-wrap:wrap;',
        btn: 'border:1px solid rgba(127,127,127,0.35);background:transparent;color:inherit;border-radius:6px;padding:3px 9px;font-size:12px;cursor:pointer;line-height:1.6;',
        btnPrimary: 'border:1px solid rgba(127,127,127,0.35);background:rgba(127,127,127,0.16);color:inherit;border-radius:6px;padding:3px 9px;font-size:12px;cursor:pointer;font-weight:600;line-height:1.6;',
        select: 'border:1px solid rgba(127,127,127,0.35);background:transparent;color:inherit;border-radius:6px;padding:3px 6px;font-size:12px;max-width:180px;',
        status: 'font-size:11px;margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:45%;',
        panes: 'display:flex;flex:1 1 auto;min-height:0;',
        pane: 'flex:1 1 50%;min-width:0;display:flex;flex-direction:column;',
        textarea:
          'flex:1 1 auto;min-height:0;width:100%;box-sizing:border-box;border:0;outline:none;resize:none;padding:12px 14px;font:13px/1.75 ui-monospace,Consolas,Monaco,monospace;background:transparent;color:inherit;',
        previewWrap: 'flex:1 1 auto;min-height:0;overflow:auto;padding:14px 16px;background:#ffffff;color:#3f3f3f;',
        divider: 'width:1px;background:rgba(127,127,127,0.22);',
        empty: 'flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:20px;text-align:center;opacity:0.85;',
        ask: 'display:flex;gap:6px;padding:6px 8px;border-top:1px solid rgba(127,127,127,0.22);',
        askInput:
          'flex:1 1 auto;min-width:0;border:1px solid rgba(127,127,127,0.32);background:transparent;color:inherit;border-radius:6px;padding:5px 8px;font-size:12px;outline:none;',
      }

      const selectFile = el('select', { style: styleText.select, title: '选择文章' })
      const dirSelect = el('select', {
        style: styleText.select,
        title: '文章目录（每个工作区可用 .wechat-md/wechat-md.json 单独设置）',
      })
      const newButton = el('button', { style: styleText.btn, text: '新建', title: '新建文章' })
      const saveButton = el('button', { style: styleText.btnPrimary, text: '保存', title: '写回 .md 文件（Ctrl/Cmd+S）' })
      const reloadButton = el('button', { style: styleText.btn, text: '重载', title: '从磁盘重新读取' })
      const themeSelect = el('select', { style: styleText.select, title: '主题' })
      const viewButton = el('button', { style: styleText.btn, text: '预览', title: '切换视图' })
      const copyButton = el('button', { style: styleText.btn, text: '复制到公众号', title: '复制内联样式后的 HTML' })
      const statusEl = el('span', { style: styleText.status })

      const textarea = el('textarea', { style: styleText.textarea, spellcheck: 'false', placeholder: '# 标题\n\n正文……' })
      const previewWrap = el('div', { style: styleText.previewWrap })
      const previewFrame = el('iframe', {
        style: 'width:100%;height:100%;border:0;background:#ffffff;',
        sandbox: 'allow-same-origin',
        title: '公众号预览',
      })
      previewWrap.append(previewFrame)

      const leftPane = el('div', { style: styleText.pane }, [textarea])
      const rightPane = el('div', { style: styleText.pane }, [previewWrap])
      const divider = el('div', { style: styleText.divider })
      const panes = el('div', { style: styleText.panes }, [leftPane, divider, rightPane])

      const askInput = el('input', {
        style: styleText.askInput,
        placeholder: '让 AI 改这篇稿子，例如：帮我把第二段改短一点',
      })
      const askButton = el('button', { style: styleText.btn, text: '发给 AI', title: '把当前稿子作为上下文发给会话' })
      const askRow = el('div', { style: styleText.ask }, [askInput, askButton])

      /**
       * 「AI 改稿后自动弹出」的开关。
       *
       * 默认开：用户在聊天里让 AI 改稿，编辑器会自己蹦出来。
       * 但如果用户正在别处专注，这个行为会打断——所以给一个显式的关闭入口，
       * 选择记在 localStorage 里，跨会话保持。
       */
      const revealButton = el('button', {
        style: styleText.btn,
        text: state.autoReveal ? 'AI 改稿:自动弹出 ✓' : 'AI 改稿:自动弹出 ✕',
        title: '开启后：聊天里让 AI 改稿，编辑器会自动弹出到这篇稿子',
      })
      revealButton.addEventListener('click', () => {
        state.autoReveal = !state.autoReveal
        revealButton.textContent = state.autoReveal ? 'AI 改稿:自动弹出 ✓' : 'AI 改稿:自动弹出 ✕'
        try {
          window.localStorage.setItem(AUTO_REVEAL_KEY, state.autoReveal ? 'on' : 'off')
        } catch {
          /* 隐私模式下选择不持久化 */
        }
        setStatus(state.autoReveal ? '已开启：AI 改稿后会自动弹出' : '已关闭：AI 改稿后不打扰', '#1a7f37')
      })

      const emptyBox = el('div', { style: styleText.empty }, [
        el('div', { text: '还没有文章' }),
        el('button', { style: styleText.btnPrimary, text: '新建第一篇' }),
      ])
      emptyBox.querySelector('button').addEventListener('click', () => void createArticle())

      const toolbar = el('div', { style: styleText.bar }, [
        dirSelect,
        selectFile,
        newButton,
        saveButton,
        reloadButton,
        themeSelect,
        viewButton,
        copyButton,
        revealButton,
        statusEl,
      ])

      const root = el('div', { style: styleText.root }, [toolbar, panes, askRow])
      host.append(root)

      const setStatus = (text, tone) => {
        state.status = text
        state.tone = tone ?? '#888888'
        statusEl.textContent = text
        statusEl.style.color = state.tone
      }

      const applyView = () => {
        leftPane.style.display = state.view === 'preview' ? 'none' : 'flex'
        rightPane.style.display = state.view === 'source' ? 'none' : 'flex'
        divider.style.display = state.view === 'split' ? 'block' : 'none'
        leftPane.style.flex = state.view === 'split' ? '1 1 50%' : '1 1 100%'
        rightPane.style.flex = state.view === 'split' ? '1 1 50%' : '1 1 100%'
        viewButton.textContent = state.view === 'split' ? '仅原文' : state.view === 'source' ? '预览' : '双栏'
      }

      /**
       * Point local image references at the plugin's own file route.
       *
       * The preview document is built with `document.write`, so it has no base
       * URL and `../assets/x.png` cannot resolve — the preview would show a
       * broken-image icon. Sources that are already absolute URLs or data URIs
       * are left alone; everything else is resolved relative to the articles
       * folder, matching how the markdown file addresses its images.
       */
      const resolveImageSources = (html) =>
        html.replace(/(<img\b[^>]*?\ssrc=")([^"]*)(")/gu, (match, before, src, after) => {
          if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/iu.test(src)) return match
          const relative = state.articlesDir === '' ? src : `${state.articlesDir}/${src}`
          return `${before}/wechat-md/file?path=${encodeURIComponent(relative)}${after}`
        })

      const renderPreview = () => {
        const html = resolveImageSources(wechatify(renderWeChat(state.text, state.theme, state.userThemes)))
        const doc = previewFrame.contentDocument
        if (doc === null) return
        doc.open()
        doc.write(
          '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff;}body{padding:2px 4px;}img{max-width:100%;}</style></head><body>' +
            html +
            '</body></html>',
        )
        doc.close()
      }

      const markDirty = () => {
        state.dirty = state.text !== state.diskText
        saveButton.textContent = state.dirty ? '保存*' : '保存'
      }

      const renderSelects = () => {
        // 主题文件里的 `wrap { label: … }` 决定了下拉里显示的中文名。
        // 尚未缓存的主题后台补拉一次，回来后重跑本函数刷新文字。
        for (const file of state.themes) {
          const stem = String(file).replace(/\.css$/iu, '')
          if (state.userThemes[stem] === undefined) {
            loadThemeFile(stem).finally(() => renderSelects())
          }
        }
        dirSelect.replaceChildren()
        for (const dir of state.articleDirs) {
          const marks = `${dir.exists ? '' : '（将新建）'}${dir.count > 0 ? ` · ${dir.count}` : ''}`
          dirSelect.append(el('option', { value: dir.value, text: `${dir.label}${marks}` }))
        }
        if (state.articleDirs.length > 0) dirSelect.value = state.articlesDir
        selectFile.replaceChildren()
        for (const row of state.articles) {
          selectFile.append(el('option', { value: row.file, text: baseName(row.file) }))
        }
        if (state.file.length > 0) selectFile.value = state.file
        themeSelect.replaceChildren()
        // 先列内置主题，再把工作区主题文件夹里的 *.css 列上。
        // 主题文件与内置主题同名时视为整套覆盖（只显示一次）；
        // 自定义主题排在前面，方便优先看到自己调好的那几套。
        const themeNames = Object.keys(THEMES)
        for (const file of state.themes) {
          const stem = String(file).replace(/\.css$/iu, '')
          if (stem.length > 0 && !themeNames.includes(stem)) themeNames.unshift(stem)
        }
        for (const key of themeNames) {
          const builtin = THEMES[key]
          const fromFile = state.themes.some(
            (file) => String(file).replace(/\.css$/iu, '') === key,
          )
          const cached = state.userThemes[key]
          const cachedLabel = cached === undefined ? undefined : cached.label
          const label = cachedLabel
            ?? (builtin === undefined ? key : (builtin.label ?? key))
          themeSelect.append(
            el('option', { value: key, text: fromFile ? `${label}（主题文件）` : label }),
          )
        }
        if (themeNames.includes(state.theme)) {
          themeSelect.value = state.theme
        } else if (themeNames.length > 0) {
          // 当前主题已不可用（文件被删/被改名）：退回第一项并实际套用，
          // 否则下拉显示的主题与预览实际用的主题会不一致。
          state.theme = themeNames[0]
          themeSelect.value = state.theme
          run(() => loadThemeFile(state.theme), '切换主题')
        }
      }

      /**
       * Load one theme stylesheet from the workspace's theme folder.
       *
       * Always refetched with a cache-busting revision: the whole point of these
       * files is that the author edits the CSS and immediately sees the result,
       * so a browser-cached or memoised copy would silently ignore the edit.
       */
      const loadThemeFile = async (name) => {
        const file = state.themes.find((candidate) => candidate.replace(/\.css$/iu, '') === name)
        if (file === undefined) {
          delete state.userThemes[name]
          renderPreview()
          return
        }
        state.themeRevision += 1
        const result = await api.get(
          `/wechat-md/theme?file=${encodeURIComponent(file)}&r=${state.themeRevision}`,
        )
        if (result.ok !== true) {
          setStatus(`主题读取失败：${result.error ?? '未知'}`, '#c0392b')
          renderPreview()
          return
        }
        const parsed = parseThemeCss(result.text ?? '')
        if (parsed === null) {
          setStatus(`${file} 解析不了：需要 wrap {} 与 p {} 这类块`, '#c0392b')
          renderPreview()
          return
        }
        state.userThemes[name] = parsed
        renderPreview()
        setStatus(`已套用主题文件 ${file}`, '#1a7f37')
      }

      /**
       * Read one article from disk.
       *
       * `probe` sends the known mtime and lets the Host answer `unchanged`, which
       * is what the background poll wants. `force` always transfers the text and
       * always reports an outcome, so an explicit "重载" click can never be
       * optimised away into visible silence.
       */
      const loadArticle = async (file, options2) => {
        const query = new URLSearchParams({ file })
        const isProbe = options2?.probe === true
        const beforeMtime = state.mtime
        if (options2?.force !== true && isProbe && state.mtime > 0) {
          query.set('mtime', String(state.mtime))
        }
        const result = await api.get(`/wechat-md/article?${query.toString()}`)
        if (result.ok !== true) {
          if (result.error === 'not-found') setStatus('文件已不存在（可能被重命名）', '#c0392b')
          else setStatus(`读取失败：${result.error ?? '未知'}`, '#c0392b')
          return
        }
        if (result.unchanged === true) {
          setStatus('已是最新（磁盘无变化）', '#888888')
          return
        }
        state.file = file
        state.text = result.text ?? ''
        state.diskText = state.text
        state.mtime = result.mtime ?? 0
        textarea.value = state.text
        markDirty()
        renderPreview()

        // 「AI 改稿后自动把编辑器叫出来」。
        //
        // 宿主给标签页声明了 keepMounted，所以即使用户把侧边栏收起，这个编辑器仍然
        // 挂着、仍然在轮询磁盘。于是：聊天里让 AI 改某篇稿 → 文件变了 → 这里先于
        // 用户察觉 → 主动把侧边栏打开并定位到这篇。用户不需要再手动点侧边栏。
        //
        // 仅在"真正的外部改动"时触发：不是首次加载（beforeMtime 为 0）、不是用户
        // 自己保存（保存不走这条探测路径）、不是编辑器正被看着（那没必要打断），
        // 并且用户没有关掉这个自动行为。
        const externalChange = isProbe && beforeMtime > 0 && !options2?.initial
        if (
          externalChange &&
          options2?.announce === true &&
          options2?.reveal === true &&
          state.autoReveal !== false &&
          !isVisible()
        ) {
          openInSidebar?.(file)
        }

        if (options2?.announce === true) setStatus('磁盘有新版本，已刷新', '#1a7f37')
        else if (options2?.force === true) setStatus(`已从磁盘重载 ${baseName(file)}`, '#1a7f37')
        else setStatus(`${baseName(file)} · ${(state.text.length / 1024).toFixed(1)}KB`, '#1a7f37')
      }

      const saveArticle = async () => {
        if (state.file.length === 0) return
        const result = await api.post('/wechat-md/article', { file: state.file, text: state.text, mtime: state.mtime })
        if (result.ok === true) {
          state.diskText = state.text
          state.mtime = result.mtime ?? state.mtime
          markDirty()
          setStatus(`已保存 · ${new Date().toLocaleTimeString()}`, '#1a7f37')
          return
        }
        if (result.error === 'changed-on-disk') {
          setStatus('磁盘上已有别人改过的版本，请先「重载」', '#c0392b')
          return
        }
        setStatus(`保存失败：${result.error ?? '未知'}`, '#c0392b')
      }

      /**
       * Create a new article and open it.
       *
       * No `window.prompt`: a blocking dialog is unreliable inside an embedded
       * app view and, when it does nothing, produces exactly the "button does
       * not respond" symptom. The file is created immediately with a dated
       * default name and the caret is placed so the author can type the real
       * title as the document's H1.
       */
      async function createArticle() {
        setStatus('正在新建…', '#888888')
        try {
          const result = await api.post('/wechat-md/article/new', { title: '未命名文章' })
          if (result.ok !== true) {
            setStatus(`新建失败：${result.error ?? '未知'}`, '#c0392b')
            return
          }
          await refresh(true)
          await loadArticle(result.file)
          setStatus(`已新建 ${result.file} —— 直接改第一行标题即可`, '#1a7f37')
          textarea.focus()
          // Put the caret on the H1 line so typing replaces "未命名文章".
          const titleEnd = state.text.indexOf('\n')
          const caret = titleEnd > 0 ? titleEnd : state.text.length
          textarea.setSelectionRange(2, caret)
        } catch (error) {
          setStatus(`新建失败：${String(error?.message ?? error)}`, '#c0392b')
        }
      }

      const askAI = async () => {
        const instruction = askInput.value.trim()
        if (state.file.length === 0) return
        // The path must match the folder the plugin is actually reading, or the
        // agent would be sent to edit a different file.
        const target =
          state.articlesDir === '' ? state.file : `${state.articlesDir}/${state.file}`
        const prompt =
          `请编辑 \`${target}\`（这就是右侧栏编辑器里打开的稿子，`.concat(
          `改完直接写回该文件，编辑器会自动刷新，不要输出整篇全文）：\n\n`,
          instruction.length > 0 ? instruction : '请通读并发掘可改进之处，直接修改。',
        )
        if (typeof inputActions?.setDraft === 'function') {
          inputActions.setDraft(prompt)
          if (typeof inputActions.submit === 'function') inputActions.submit()
          askInput.value = ''
          setStatus('已把指令发给会话', '#1a7f37')
          return
        }
        try {
          await navigator.clipboard.writeText(prompt)
          setStatus('已复制指令，粘贴到聊天框发送', '#1a7f37')
        } catch {
          setStatus('无法自动发送，请手动复制', '#c0392b')
        }
        void sessionId
      }

      const refresh = async (announce) => {
        const stateResult = await api.get('/wechat-md/state')
        if (stateResult.ok !== true) {
          setStatus(`插件接口不通：${stateResult.error ?? '未知'}`, '#c0392b')
          return
        }
        const previousDir = state.articlesDir
        state.articlesDir = stateResult.articlesDir ?? ''
        state.articleDirs = stateResult.articleDirs ?? []
        state.articles = stateResult.articles ?? []
        state.themes = stateResult.themes ?? []
        // A folder change invalidates the open file and its mtime.
        if (previousDir !== state.articlesDir) {
          state.file = ''
          state.mtime = 0
        }
        // 打开编辑器时默认选中"最近改过"的那篇，而不是列表第一篇。
        // 用户的实际场景是"刚在改某篇稿子，想接着改"，按文件名排序反而每次都
        // 落在 01_ 开头的老稿子上。服务端已按修改时间倒序返回，这里取第一条。
        if (state.file.length === 0 && state.articles.length > 0) {
          const newest = state.articles.reduce(
            (best, row) => (row.mtime > best.mtime ? row : best),
            state.articles[0],
          )
          state.file = newest.file
        }
        if (state.file.length === 0 && state.articles.length === 0) {
          panes.style.display = 'none'
          askRow.style.display = 'none'
          if (root.contains(emptyBox) === false) root.insertBefore(emptyBox, askRow)
          // The folder picker stays visible so another folder can be chosen.
          renderSelects()
          setStatus(`${state.articlesDir || '工作区根目录'} 下还没有 .md 文件`, '#888888')
          void announce
          return
        }
        if (root.contains(emptyBox)) emptyBox.remove()
        panes.style.display = 'flex'
        askRow.style.display = 'flex'
        renderSelects()
      }

      /** Persist the chosen article folder for this workspace, then rescan. */
      const switchDir = async (dir) => {
        setStatus('正在切换目录…', '#888888')
        const result = await api.post('/wechat-md/config', { articlesDir: dir })
        if (result.ok !== true) {
          setStatus(`切换失败：${result.error ?? '未知'}`, '#c0392b')
          return
        }
        await refresh(true)
        if (state.file.length > 0) await loadArticle(state.file, { force: true })
        setStatus(`文章目录：${dir || '工作区根目录'}`, '#1a7f37')
      }

      // -- wiring -------------------------------------------------------------

      /**
       * Run one button action, surfacing any failure in the status line.
       *
       * Button handlers are async; without this a rejected promise would be an
       * unhandled rejection that the author only perceives as "the button does
       * nothing".
       */
      const run = (action, label) => {
        void (async () => {
          try {
            await action()
          } catch (error) {
            const detail = String(error?.message ?? error)
            setStatus(`${label}失败：${detail}`, '#c0392b')
            console.error(`[dsh-wechat-md] ${label} failed`, error)
          }
        })()
      }

      selectFile.addEventListener('change', () => {
        run(() => loadArticle(selectFile.value), '切换文章')
      })
      dirSelect.addEventListener('change', () => run(() => switchDir(dirSelect.value), '切换目录'))
      newButton.addEventListener('click', () => run(createArticle, '新建'))
      saveButton.addEventListener('click', () => run(saveArticle, '保存'))
      reloadButton.addEventListener('click', () => run(() => loadArticle(state.file, { force: true }), '重载'))
      viewButton.addEventListener('click', () => {
        state.view = state.view === 'split' ? 'source' : state.view === 'source' ? 'preview' : 'split'
        applyView()
      })
      themeSelect.addEventListener('change', () => {
        state.theme = themeSelect.value
        try {
          window.localStorage.setItem('dsh.wechat-md.theme', state.theme)
        } catch {
          /* private mode: the choice simply does not persist */
        }
        run(() => loadThemeFile(state.theme), '切换主题')
      })
      copyButton.addEventListener('click', () =>
        run(async () => {
          const html = wechatify(renderWeChat(state.text, state.theme, state.userThemes))
          try {
            const item = new window.ClipboardItem({
              'text/html': new Blob([html], { type: 'text/html' }),
              'text/plain': new Blob([state.text], { type: 'text/plain' }),
            })
            await navigator.clipboard.write([item])
            setStatus('已复制，粘贴到公众号后台即可', '#1a7f37')
          } catch {
            try {
              await navigator.clipboard.writeText(html)
              setStatus('已复制 HTML 源码（浏览器不支持富文本剪贴板）', '#1a7f37')
            } catch {
              setStatus('复制失败：剪贴板不可用', '#c0392b')
            }
          }
        }, '复制'),
      )
      textarea.addEventListener('input', () => {
        state.text = textarea.value
        markDirty()
        renderPreview()
      })
      textarea.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault()
          run(saveArticle, '保存')
        }
      })
      askButton.addEventListener('click', () => run(askAI, '发给 AI'))
      askInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          run(askAI, '发给 AI')
        }
      })

      // -- boot ---------------------------------------------------------------

      applyView()
      try {
        const saved = window.localStorage.getItem('dsh.wechat-md.theme')
        if (saved !== null && THEMES[saved] !== undefined) state.theme = saved
      } catch {
        /* ignore */
      }

      void (async () => {
        await refresh(true)
        // Apply the theme file before rendering the article, otherwise the first
        // paint uses the built-in palette and the saved choice only appears
        // after the author toggles the dropdown.
        await loadThemeFile(state.theme)
        if (state.file.length > 0) await loadArticle(state.file, { initial: true })
      })()

      // Poll for changes the agent (or any other writer) made on disk.
      // `reveal` 让这一轮轮询在发现外部改动时把编辑器叫到前台（AI 改稿场景）。
      const poll = window.setInterval(() => {
        if (state.file.length === 0) return
        if (state.dirty) return
        void loadArticle(state.file, { probe: true, announce: true, reveal: true })
      }, 2500)

      return () => {
        window.clearInterval(poll)
        root.remove()
      }
    }

    /** One React host per tab occurrence; the editor itself is plain DOM. */
    function WeChatMdBody(props) {
      const hostRef = react.useRef(null)
      const { tab } = props.useTabInfo()
      // 用 ref 暴露"当前是否可见"，避免闭包读到挂载时的旧值。
      const visibleRef = react.useRef(true)
      visibleRef.current = tab?.visible !== false
      react.useEffect(() => {
        const host = hostRef.current
        if (host === null) return undefined
        const dispose = createEditor(host, {
          sessionId: props.sessionId,
          inputActions: props.inputActions,
          initialFile: tab?.navigation?.params?.file,
          // 「在侧边栏打开」需要能主动把右侧栏展示出来；宿主没给这个能力时降级为 null。
          openInSidebar: props.openInSidebar,
          isVisible: () => visibleRef.current,
        })
        return dispose
      }, [props.sessionId, props.inputActions, tab])
      return react.createElement('div', { ref: hostRef, style: { height: '100%', minHeight: 0 } })
    }

    function WeChatMdTitle() {
      return react.createElement('span', null, '公众号排版')
    }

    /**
     * The tab type plus the guide card.
     *
     * `guide[].commandId` decides whether the 开始-panel card is actually
     * clickable: the guide body resolves the entry against the shortcut catalog
     * (`shortcuts.find(s => s.id === entry.commandId)`) and only wires an action
     * when one is found. So the command below and this id must stay in sync —
     * without it the card is inert and the user still has to hunt for the panel.
     */
    const OPEN_COMMAND_ID = 'wechat-md.open'

    function definition(t) {
      return {
        id: ID,
        kind: KIND,
        priority: 'extension',
        keepMounted: true,
        title: () => t('label'),
        guide: [
          {
            id: 'wechat-md',
            commandId: OPEN_COMMAND_ID,
            order: 40,
            title: () => t('guideTitle'),
            description: () => t('guideDesc'),
          },
        ],
      }
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)

      /**
       * 主动把右侧栏打开到这个插件，并定位到指定文章。
       *
       * 之前用户得手动点侧边栏、再手动从下拉里选文章，产品化上这是最后一环体验断点。
       * 宿主给了两个能力：`ctx.sidebarRight.openTab(kind, { params })` 打开我们的标签
       * 并把 params 带进标签页（正文用 `tab.navigation.params.file` 读它）；
       * `ctx.layout.openRightbar(track, fullscreen)` 把右侧栏真正展示出来。
       *
       * 两者任何一步不可用时只做降级，不抛错：侧边栏已开着的时候 openRightbar
       * 不需要调用，插件在别的宿主版本上也应当能继续用。
       */
      const openInSidebar = (file) => {
        let tabOpened = false
        try {
          const sidebar = ctx.get('sidebarRight')
          if (typeof sidebar?.openTab === 'function') {
            sidebar.openTab(KIND, file === undefined ? {} : { params: { file } })
            tabOpened = true
          }
        } catch (error) {
          console.error('[dsh-wechat-md] openTab failed', error)
        }
        try {
          const layout = ctx.get('layout')
          if (typeof layout?.openRightbar === 'function') layout.openRightbar()
        } catch (error) {
          console.error('[dsh-wechat-md] openRightbar failed', error)
        }
        return tabOpened
      }

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-wechat-md: dictionaries')
      ctx.effect(() => ctx.sidebarRightTabs.register(definition(t)), 'dsh-wechat-md: tab type')

      /**
       * 注册一个可被指南卡和快捷键共用的命令。
       *
       * 形状照抄宿主自带的 `workspace.files`：guide 卡只认 `commandId` + 快捷键目录里
       * 的同 id 条目；`resolve` 负责把"当前元素"解析成可执行动作（宿主负责当前会话
       * 的解析，插件不该自己猜）。
       */
      ctx.inject(['shortcuts'], (scoped) => {
        scoped.effect(
          () =>
            scoped.shortcuts.register({
              id: OPEN_COMMAND_ID,
              label: () => t('guideTitle'),
              aliases: ['wechat md', 'wechat-md', '公众号排版', 'gongzhonghao'],
              defaults: {
                'desktop:macos': { code: 'KeyM', modifiers: ['primary', 'shift'] },
                'desktop:windows': { code: 'KeyM', modifiers: ['primary', 'shift'] },
                'desktop:linux': { code: 'KeyM', modifiers: ['primary', 'shift'] },
                'web:macos': { code: 'KeyM', modifiers: ['primary', 'shift'] },
                'web:windows': { code: 'KeyM', modifiers: ['primary', 'shift'] },
                'web:linux': { code: 'KeyM', modifiers: ['primary', 'shift'] },
              },
              regions: ['page'],
              modals: [],
              resolve: ({ target: element }) => {
                const sidebar = ctx.get('sidebarRight') ?? ctx.sidebarRight
                const target = sidebar?.commandTarget?.(element)
                if (target === undefined) return { status: 'blocked', reason: t('guideDesc') }
                return {
                  status: 'handled',
                  run: () => {
                    // 优先走宿主推荐的 openTabFromTarget（它会带上当前会话），
                    // 老宿主没有这个方法时降级为普通 openTab。
                    let opened = false
                    try {
                      if (typeof sidebar.openTabFromTarget === 'function') {
                        sidebar.openTabFromTarget(KIND, target)
                        opened = true
                      }
                    } catch (error) {
                      console.error('[dsh-wechat-md] openTabFromTarget failed', error)
                    }
                    if (!opened) openInSidebar()
                    try {
                      ctx.get('layout')?.openRightbar?.()
                    } catch {
                      /* 侧边栏可能已经打开，忽略 */
                    }
                  },
                }
              },
            }),
          'dsh-wechat-md: open command',
        )
      })

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              { name: 'sidebar.right.pane.tab', key: ID, locale: NS },
              (props) => WeChatMdBody({ ...props, openInSidebar }),
            ),
          ),
        'dsh-wechat-md: tab body',
      )
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: ID }, WeChatMdTitle),
          ),
        'dsh-wechat-md: tab title',
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
