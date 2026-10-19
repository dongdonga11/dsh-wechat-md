# dsh-wechat-md

> DSH 右侧栏里的**公众号 markdown 编辑器**：写稿、预览、一键复制到公众号后台，和聊天里的 AI 共用同一个 `.md` 文件。

[English](README.en.md) · MIT

---

## 它解决什么问题

公众号后台的编辑器不吃 markdown，也不吃 `<style>` 和 class——粘进去样式就没了。这个插件把右侧栏变成一个公众号专用的 md 编辑器：

- **左边写 markdown，右边实时预览**：公众号的真实排版效果
- **复制到公众号**：把样式逐元素内联后写进富文本剪贴板，粘进后台不掉样式
- **文章就是普通 `.md` 文件**：AI 在聊天里用普通文件工具改同一个文件，编辑器 2.5 秒轮询自动刷新
- **发给 AI**：把当前稿子路径加你的指令送进会话，让 AI 直接改这篇
- **AI 改完，编辑器自己弹出来**：编辑器收起后仍在轮询，发现当前这篇被外部改动（也就是 AI 改稿）就自动打开右侧栏并定位到它，不用再手动点侧边栏、手动选文章

因为文章是唯一真相源（single source of truth），编辑器、AI、你手动编辑三者不会各写各的。

## 特性

| | |
|---|---|
| 零运行时依赖 | 服务端只用 Node 内置模块；浏览器端手写 markdown 渲染器，无 JSX、无打包器、无编译 |
| 公众号粘贴兼容 | 样式全部内联；`<img width>` 转内联 `width`；正文锚点丢 `href`；不使用 `var()` |
| 三套内置主题 | `classic`（经典蓝，h2 自动编号 一、二、三）、`grace`（优雅绿）、`simple`（简洁灰） |
| 自定义主题 | 工作区放一个 `*.css`，文件名与内置主题同名即整套替换 |
| 目录可切换 | 下拉切换文章目录，选择按工作区持久化 |
| 主动调起 | 指南卡可点、`Ctrl/Cmd+Shift+M` 直达、AI 改稿后自动弹出（可关） |
| 默认最近稿 | 打开编辑器默认选中修改时间最新的那篇，不是列表第一篇 |
| 乐观并发 | 保存时带 mtime，磁盘上被 AI 改过就返回冲突而不是静默覆盖 |
| 路径守卫 | 所有读写都被约束在工作区内，图片路由只放行图片扩展名 |

### 怎么把它叫出来

| 方式 | 操作 |
|---|---|
| 指南卡 | 「开始」面板里点「公众号排版」卡片 |
| 快捷键 | `Ctrl/Cmd + Shift + M` |
| AI 改稿自动弹 | 在聊天里让 AI 改当前这篇稿，编辑器检测到磁盘变化后自动出现 |
| 手动 | 右侧栏标签栏里点「公众号排版」 |

自动弹出只对**外部改动**生效：首次加载、你自己保存、以及你正看着编辑器时都不会触发。
不想要这个行为，点工具栏上的 `AI 改稿:自动弹出` 关掉即可（选择会记住）。

## 环境要求

- Node.js **>= 20**（开发与验证环境为 24.18.0）
- 一个可用的 DSH 宿主，且已启用 Web 服务
- peer 依赖：`@deepseek-ai/cordis`（`~4.0.4`）、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-sidebar-right`、`react >= 18`

> 宿主 profile 若设置了 `autoInstallPeers: false`（DSH 的默认），peer 不会自动安装，需要由 profile 自身提供这些包。

## 安装

### 一条命令（推荐）

```bash
dsh plugin --profile desktop add github:dongdonga11/dsh-wechat-md
```

就这一条。它会做三件事：

1. 把插件装进 `desktop` 这个 profile
2. **自动把它注册进该 profile 的 `dsh.profile.bundles`**——不需要手改任何配置文件
3. 下次启动 DSH，右侧栏就多出一个「公众号排版」标签

> 没有发布到 npm，所以用 `github:` 简写而不是包名。这样会走内部的 `npm pack`，
> 只装 `package.json` 的 `files` 白名单里的文件（7 个，约 32KB），不会把仓库里的
> 历史备份等杂项一起拉下来——所以**不要**改用 GitHub 的 tar.gz 直链。

安装完成后重启 DSH，然后确认插件活着：

```bash
curl http://127.0.0.1:19387/wechat-md/ping
# {"ok":true,"plugin":"dsh-wechat-md","root":"D:\\你的工作区"}
```

看到 `{"ok":true,...}` 就成了。

### 装到哪个 profile

**必须装在有右侧栏 UI 的 profile 里**（桌面版默认就是）。装到一个没有右侧栏的
profile 时，插件进程起不来，启动日志里会看到：

```
web boot: 1 entry did not activate
dsh-wechat-md: pending (waiting for services: sidebarRight, sidebarRightTabs)
```

翻译成人话：它一直在等"右侧栏"这个服务，而那个 profile 里根本没有右侧栏。
所以撞到 `waiting for services` 时，先看你的 profile 有没有右侧栏，而不是怀疑插件坏了。

### 手动安装（一般不需要）

想手工维护依赖时，在 DSH profile 目录（例如 `~/.dsh/profiles/desktop`）里：

**1. 加依赖**

```json
{
  "dependencies": {
    "dsh-wechat-md": "github:dongdonga11/dsh-wechat-md"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-wechat-md"]
    }
  }
}
```

本地调试插件本身时，依赖可以指到工作副本：`"dsh-wechat-md": "link:D:/path/to/dsh-wechat-md"`。

**2. 装依赖**

```bash
pnpm install
```

**3. 重启 DSH**，右侧栏会出现「公众号排版」标签页。

`cordis.patch.yml` 里的 loader 行由包自身的 `dsh.bundle.patch` 声明，不需要手写：

```yaml
- insert:
    - id: wechat-md
      name: dsh-wechat-md
```

## 配置

### 文章目录与主题目录

编辑器会在工作区里找一个放文章的目录，优先级：

1. **显式配置**：`<工作区>/.wechat-md/wechat-md.json`（在界面上切换目录会自动写入）

   ```json
   { "articlesDir": "运营/articles", "themesDir": "运营/themes" }
   ```

2. **已有约定**：按顺序取第一个真实存在的
   - 文章：`运营/articles` → `articles` → `文章` → `content` → `posts`
   - 主题：`运营/themes` → `themes` → `主题`
   - 另外任何一级子目录下的 `<名字>/articles` 也会出现在下拉里
3. **历史默认**：`运营/articles`、`运营/themes`（不存在则创建）

界面上最左边的下拉可以随时切换文章目录，选择会写回 `.wechat-md/wechat-md.json`。

### 固定工作区

这个插件不是 Session 作用域的，而 DSH Host 同时服务多个 Session，所以它**无法可靠地判断"你此刻在看哪个工作区"**。默认它会按 `sessions` → `cwd` → 工作区注册表 → 进程 cwd 逐个猜，猜错就会打开别的项目。

要固定住，二选一：

| 方式 | 用法 |
|---|---|
| 环境变量 | `DSH_WECHAT_MD_ROOT=D:\dongzhiAI` |
| 文件 | 往 `$DSH_HOME/wechat-md-root.txt` 写一行绝对路径 |

pin 的优先级最高，且每次请求都会重新读取（不受 5 秒缓存影响）。

### 在哪配置什么

| 配置项 | 位置 | 谁读它 |
|---|---|---|
| `articlesDir` / `themesDir` | `<工作区>/.wechat-md/wechat-md.json` | 插件（服务端） |
| 固定工作区 | `DSH_WECHAT_MD_ROOT` 或 `$DSH_HOME/wechat-md-root.txt` | 插件（服务端） |
| 当前主题 | `localStorage['dsh.wechat-md.theme']` | 插件（浏览器端） |

## HTTP 接口

全部同源 JSON，共 7 条。请求体上限 8 MB。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/wechat-md/ping` | 存活探测，返回当前解析出的工作区 `root` |
| GET | `/wechat-md/state` | 文章列表 + 主题列表 + 目录候选 + 当前配置 |
| GET | `/wechat-md/article?file=&mtime=` | 读一篇文章；`mtime` 命中时返回 `{unchanged:true}` 且不传正文 |
| POST | `/wechat-md/article` | 写一篇文章；带正数 `mtime` 时启用乐观并发（冲突返回 `409 changed-on-disk`） |
| POST | `/wechat-md/article/new` | 新建文章，文件名 = `YYYY-MM-DD-<slug>.md` |
| GET/POST | `/wechat-md/theme` | 读 / 写一个主题样式表 |
| GET/POST | `/wechat-md/config` | 读 / 改文章与主题目录；非 POST 一律按读处理 |
| GET | `/wechat-md/file?path=` | 预览用：按工作区相对路径返回图片（扩展名白名单） |

状态码：`400` 路径非法 · `404` 不存在 · `405` 方法不允许 · `409` 并发冲突 · `413` 请求体过大 · `415` 非图片扩展名。

## 自定义主题

在主题目录放一个 `<名字>.css`，名字与内置主题相同则整套替换内置调色，不同则新增一个下拉项。选择器就是元素名，声明会被逐条内联到对应元素上：

```css
/* wrap 是外层 section；这里的 label 决定下拉里显示的中文名 */
wrap {
  label: 我的主题;
  font-size: 16px;
  line-height: 1.8;
  color: #333333;
  counter: on;          /* on 时 h2 自动加「一、二、三」 */
}

h1 { font-size: 1.3em; text-align: center; color: #0F4C81 }
h2 { font-size: 1.14em; font-weight: bold; color: #0F4C81 }
h3 { font-size: 1.02em; font-weight: bold; color: #111111 }
h4 { font-size: 1em;    font-weight: bold; color: #333333 }

p    { margin: 1em 0; letter-spacing: 0.03em }
li   { margin: 0.4em 0 }
quote{ margin: 1.2em 0; padding: 0.6em 1em; border-left: 3px solid #cccccc; background: #fafafa }
code { font: 90% Consolas,Monaco,monospace; background: #f6f6f6; padding: 1em }
table{ border-collapse: collapse; width: 100% }
th   { border: 1px solid #e0e0e0; padding: 0.5em 0.7em; background: #fafafa }
td   { border: 1px solid #e0e0e0; padding: 0.5em 0.7em }
hr   { border: none; border-top: 1px solid #e8e8e8; margin: 2em 0 }
link { color: #576b95; text-decoration: none }
strong { color: #c0392b }   /* 可选：给加粗指定颜色 */
```

注意：

- 属性会被**原样内联**，所以任何真实 CSS 属性都能用
- **不要用 `var()`**——公众号后台粘贴时不解析它
- 不需要 `wrap {}` 以外的任何块，但**必须有 `wrap {}`**，否则文件会被判为解析失败
- 主题文件**每次切换都会重新拉取**（带 cache-busting），改完直接切一下就能看到效果

## 测试

```bash
npm test
```

75 个测试，全部基于 Node 内置 `node:test`，**零测试依赖**：

| 文件 | 覆盖 |
|---|---|
| `test/client.smoke.test.mjs` | 模块加载器契约、`apply()` 注册的槽位与字典 |
| `test/client.unit.test.mjs` | markdown 渲染、公众号粘贴修正、主题 CSS 解析 |
| `test/routes.test.mjs` | 7 条路由、乐观并发、原子写、**路径逃逸安全用例** |

两点说明：

- `lib/client.js` 是一个 IIFE，没有导出、也**没有为测试留钩子**。测试通过 `test/helpers.mjs` 从源码里按声明切片再求值来拿到内部纯函数，不修改生产代码，也不在测试里重写一份逻辑。
- `npm test` 走的是 `test/run.mjs`，不是直接 `node --test`。原因是"把所有测试放进一个进程"所需的选项在 Node 各版本拼写不同，而且 Node 20 根本没有：

  | 版本 | 单进程选项 |
  |---|---|
  | Node 20 | **没有**（runner 自动退回默认的多进程隔离） |
  | Node 22.8+ | `--experimental-test-isolation=none` |
  | Node 23+ / 24 | `--test-isolation=none` |

  runner 会按运行时能力选拼写，选不到就退回不带该 flag 的 `node --test`。已验证 Node 20.20.2 / 22.14.0 / 24.18.0 三个版本均 **75/75 通过**。CI 上不需要这个 flag（不受沙箱限制）；本地加上它只是为了让受限沙箱能跑。

## 已知限制

按当前行为如实记录，都是可复现的：

1. **段落/代码块/引用内段落的行高靠外层继承**
   `wrap` 上声明了 `line-height`（classic 1.75 / grace 1.9 / simple 1.8），但 `p`、`code`、以及引用块里的 `<p>` 没有各自的 `line-height`。公众号的校验器对继承来的行高一向不信任，会报 `line-height-overlapping`。
   当前继承值本身是安全的（16px×1.75=28px，远大于字号），要彻底消除告警需要给内置主题补上各元素的 `line-height`——这会改变所有已发布文章的 HTML，所以没有擅自动。`test/client.unit.test.mjs` 里有一条测试专门钉住这个现状。

2. **标题里含连续两个点会让「新建」失败**
   `slugify` 会剥掉 Windows 非法字符但保留 `.`，于是标题 `../../etc/passwd` 生成的候选文件名含有 `..`，被路径守卫判定为越权，接口返回 `400 bad path`，界面显示「新建失败」。没有安全问题（守卫正是拦住它的原因），但确实用不了。同样被测试钉住。

3. **固定工作区的 pin 未必生效**
   在一次实测中，运行中的实例 `/wechat-md/ping` 返回的 `root` 是 `D:\个人经营`，而 `$DSH_HOME/wechat-md-root.txt` 里写的是 `D:\dongzhiAI`。可能是运行中的进程早于 pin 文件写入，也可能 pin 路径存在缺陷，尚未定位。在依赖 pin 之前，先请求一次 `/wechat-md/ping` 确认 `root` 是你要的目录。

4. **mtime 精度不足时，改动检测可能漏判**
   读文章的 `unchanged` 短路由和保存时的 409 冲突守卫，都靠比较 mtime 判断"文件变没变"，容差 1ms。但文件系统的时间戳刻度往往粗于 1ms（NTFS 约 15ms），所以**同一个刻度内的两次写入具有完全相同的 mtime**：磁盘内容明明变了，接口却会回 `unchanged: true`、不传正文。后果是编辑器 2.5 秒轮询可能持续显示旧稿，且覆盖 AI 在同一刻度内的改写不会被判为冲突。
   要真正消除，得把"变没变"的判据从 mtime 换成内容哈希，或在 mtime 之外同时比对字节大小。两条路径的行为都被 `test/routes.test.mjs` 里的 `FINDING` 用例钉住（在刻度足够细的文件系统上会自动跳过断言并留痕）。

## 安全模型

- 所有文件读写都经过 `resolveInside()` / `resolveWorkspaceFile()`：拒绝绝对路径、`..`、`\0`，解析后再次校验必须落在根目录内。
- 图片路由 `/wechat-md/file` 只放行 `png/jpg/jpeg/gif/webp/bmp/svg`。
- 写操作优先走宿主的 `ctx.fs` + `sandboxPolicy`（原子替换、沙箱策略仍是权威），拿不到时退回本地"临时文件 + rename"的原子写。
- **信任边界**：这些接口没有鉴权，假定"同源即可信"。因为只监听本机、且读取被限制在工作区内的图片，风险可接受；但任何能访问该 host 的页面理论上都能读到你工作区里的图片。

## 许可证

[MIT](LICENSE) © 2026 dsh-wechat-md contributors
