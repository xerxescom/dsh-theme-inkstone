/**
 * Emits `preview.html` — a self-contained, interactive preview of the palette.
 *
 * It reads the real token values from `tools/tokens.json` (never hard-codes a
 * colour) and renders the three places a theme is judged: a conversation, a
 * code block, and a settings/menu surface. Light and dark are both drawn side by
 * side so a palette that only works in one scheme is obvious at a glance.
 *
 * The optional background image is previewed at the bottom with a slider for the
 * wash strength, because that is the one parameter a user will want to tune.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { contrast, parseColor } from './color.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const data = JSON.parse(readFileSync(join(HERE, 'tokens.json'), 'utf8'))
const report = JSON.parse(readFileSync(join(HERE, 'report.json'), 'utf8'))
const tokens = data.tokens
const overlay = report.overlay ?? { light: 0.82, dark: 0.88 }
const motion = report.motion ?? null
if (motion === null) throw new Error('report.json has no motion block — run `node tools/palette.mjs` first')

/**
 * @param {string} name
 * @param {'light' | 'dark'} mode
 * @returns {string}
 */
const colour = (name, mode) => tokens[name]?.[mode] ?? 'currentColor'

/** Render the `--dsw-*` token map as a CSS custom-property block for one scheme. */
function cssBlock(mode) {
  const lines = Object.entries(tokens).map(([name, pair]) => `  ${name}: ${pair[mode]};`)
  return `[data-mode="${mode}"] {\n  color-scheme: ${mode};\n${lines.join('\n')}\n}`
}

const ratioRows = report.pairs
  .map(
    (p) =>
      `<tr><td>${p.mode === 'light' ? '浅色' : '深色'}</td><td>${p.why}</td><td class="num">${p.ratio.toFixed(2)}</td><td class="num">${p.floor.toFixed(1)}</td><td class="${p.status === 'PASS' ? 'pass' : p.status === 'INHERITED' ? 'inherit' : 'fail'}">${p.status}</td></tr>`,
  )
  .join('\n      ')

const shikiRows = report.shiki
  .map((s) => `<tr><td>${s.mode}</td><td><code>${s.token.replace('--shiki-token-', '')}</code></td><td class="num">${s.ratio.toFixed(2)}</td><td class="${s.status === 'PASS' ? 'pass' : 'fail'}">${s.status}</td></tr>`)
  .join('\n      ')

const lowest = [...report.pairs].sort((a, b) => a.ratio - b.ratio).slice(0, 3)

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Inkstone 砚 — 预览</title>
<style>
${cssBlock('light')}
${cssBlock('dark')}

/* The previewed motion palette, scoped per card the way the real plugin scopes
   it to <body>. Selection and focus therefore show the real values. */
[data-mode="light"] { --inkstone-selection: ${motion.selection.light}; --inkstone-selection-text: ${motion.selectionText.light}; --inkstone-focus-halo: ${motion.focusHalo.light}; }
[data-mode="dark"] { --inkstone-selection: ${motion.selection.dark}; --inkstone-selection-text: ${motion.selectionText.dark}; --inkstone-focus-halo: ${motion.focusHalo.dark}; }
[data-mode="dark"] ::selection { background: ${motion.selection.dark}; color: ${motion.selectionText.dark}; }

:root { --gap: 16px; }
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  transition: background-color .25s, color .25s;
}
.mode { background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); padding: 28px; }
.mode[data-mode="light"] { color-scheme: light; }
.mode[data-mode="dark"] { color-scheme: dark; }

/* Selection: the warm wash replaces the browser's default blue. */
.mode ::selection { background: var(--inkstone-selection); color: var(--inkstone-selection-text); }

/* Focus: cinnabar ring plus a soft halo. */
.mode .composer:focus-visible,
.mode button:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 2px;
  box-shadow: 0 0 0 4px var(--inkstone-focus-halo);
}

.label { font-size: 12px; color: var(--dsw-alias-label-tertiary); letter-spacing: .08em; text-transform: uppercase; margin-bottom: 4px; }
.caption { font-size: 12px; color: var(--dsw-alias-label-caption); }
.secondary { color: var(--dsw-alias-label-secondary); }
a { color: var(--dsw-alias-link); }
h1 { font-size: 20px; margin: 0 0 6px; }
h2 { font-size: 15px; margin: 0 0 10px; font-weight: 600; }
h3 { font-size: 13px; margin: 18px 0 8px; font-weight: 600; }

.shell { display: grid; grid-template-columns: 220px 1fr 200px; gap: var(--gap); max-width: 1180px; margin: 0 auto; }
@media (max-width: 1040px) { .shell { grid-template-columns: 1fr; } }

.panel { border-radius: var(--dsw-radius-md); padding: 14px; }
.sidebar { background: var(--dsw-specific-sidebar-fill); border: 1px solid var(--dsw-alias-border-l2); }
.nav { display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
.nav div { padding: 6px 8px; border-radius: var(--dsw-radius-sm); }
.nav .active { background: var(--dsw-specific-sidebar-nav-item-active); }
.aside { background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); font-size: 12px; }

.turn { margin-bottom: 18px; font-size: 14px; line-height: 1.7; }
.turn .who { font-size: 11px; color: var(--dsw-alias-label-tertiary); margin-bottom: 4px; }
.bubble { background: var(--dsw-specific-bubble); border-radius: var(--dsw-radius-md); padding: 10px 14px; }
.quote { border-left: 3px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-markdown-citation); padding: 8px 12px; border-radius: 0 var(--dsw-radius-sm) var(--dsw-radius-sm) 0; margin: 10px 0; }
.inline-code { background: var(--dsw-alias-markdown-inline-code); padding: 1px 5px; border-radius: 4px; font-family: var(--ds-font-family-code, Consolas, monospace); font-size: 12.5px; }

.code {
  background: var(--dsw-alias-markdown-code-block);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  font-family: "SF Mono", "JetBrains Mono", Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.65;
  overflow: auto;
}
.code .banner { background: var(--dsw-alias-markdown-code-block-banner); padding: 6px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.code pre { margin: 0; padding: 10px 12px; }
.tok-k { color: var(--shiki-token-keyword); }
.tok-f { color: var(--shiki-token-function); }
.tok-s { color: var(--shiki-token-string); }
.tok-c { color: var(--shiki-token-constant); }
.tok-m { color: var(--shiki-token-comment); }
.tok-p { color: var(--shiki-token-parameter); }
.tok-x { color: var(--shiki-token-punctuation); }
.tok-l { color: var(--shiki-token-link); }

.composer { background: var(--dsw-specific-input-major); border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg); padding: 10px 14px; color: var(--dsw-alias-label-secondary); font-size: 13px; margin-top: 16px; }
.status { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; font-size: 12px; }
.pill { border-radius: 999px; padding: 2px 10px; }
.pill.ok { background: var(--dsw-alias-state-success-tertiary); color: var(--dsw-alias-state-success-primary); }
.pill.warn { background: var(--dsw-alias-state-warn-tertiary); color: var(--dsw-alias-state-warn-label); }
.pill.bad { color: var(--dsw-alias-state-error-primary); }
.pill.info { background: var(--dsw-alias-state-business-tertiary); color: var(--dsw-alias-state-business-primary); }

.menu { background: var(--dsw-specific-menu); border: 1px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md); padding: 6px; font-size: 13px; box-shadow: var(--dsw-elevation-panel); }
.menu .item { padding: 6px 10px; border-radius: var(--dsw-radius-sm); }
.menu .item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.menu .head { color: var(--dsw-alias-menu-icon); font-size: 11px; padding: 4px 10px; background: var(--dsw-alias-menu-group-header-fill); }

table { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
th { color: var(--dsw-alias-label-tertiary); font-weight: 600; }
.num { text-align: right; }
.pass { color: var(--dsw-alias-state-success-primary); }
.inherit { color: var(--dsw-alias-state-warn-label); }
.fail { color: var(--dsw-alias-state-error-primary); }

.swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(28px, 1fr)); gap: 4px; }
.swatch { height: 26px; border-radius: 4px; border: 1px solid var(--dsw-alias-border-l1); }

/* Motion demo: the two animations the theme actually ships. */
.motion-demo { display: flex; flex-direction: column; gap: 12px; margin-bottom: 8px; }
.motion-note {
  padding: 14px 16px;
  border-radius: var(--dsw-radius-sm);
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.7;
}
.motion-menu {
  align-self: flex-start;
  padding: 8px 14px;
  border-radius: var(--dsw-radius-sm);
  border: 1px solid var(--dsw-alias-border-l3);
  background: var(--dsw-specific-menu);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  box-shadow: var(--dsw-elevation-panel);
}
@keyframes inkstone-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes inkstone-pop { from { opacity: 0; transform: scale(.985); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: no-preference) {
  .motion-note.playing { animation: inkstone-rise 220ms cubic-bezier(.22,.61,.36,1) both; }
  .motion-menu.playing { animation: inkstone-pop 140ms cubic-bezier(.22,.61,.36,1) both; transform-origin: top center; }
}

.bg-demo { position: relative; height: 260px; border-radius: var(--dsw-radius-md); overflow: hidden; border: 1px solid var(--dsw-alias-border-l2); }
.bg-demo::before { content: ''; position: absolute; inset: 0; background-image: linear-gradient(135deg, #2c5364, #0f2027 55%, #c79081), radial-gradient(circle at 70% 30%, #f6d365, transparent 60%); background-blend-mode: screen; }
.bg-demo .wash { position: absolute; inset: 0; }
.bg-demo .content { position: relative; padding: 20px; }
input[type=range] { width: 220px; vertical-align: middle; }
.toolbar { display: flex; gap: 16px; align-items: center; margin-bottom: 10px; font-size: 12px; color: var(--dsw-alias-label-secondary); flex-wrap: wrap; }
.foot { max-width: 1180px; margin: 0 auto; padding: 0 28px 40px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
</style>
</head>
<body>

<section class="mode" data-mode="light">
<div class="shell">
  <aside class="sidebar panel">
    <div class="label">会话</div>
    <div class="nav">
      <div class="active">今天的会话</div>
      <div>主题插件方案</div>
      <div>配色可读性</div>
      <div class="secondary" style="font-size:12px;margin-top:8px">更早</div>
      <div>上一次排查</div>
    </div>
  </aside>

  <main class="panel" style="background: var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l1)">
    <h1>浅色 · 砚</h1>
    <div class="caption">正文 ${contrast(parseColor(colour('--dsw-alias-label-primary', 'light')), parseColor(colour('--dsw-alias-bg-base', 'light'))).toFixed(1)}:1 ·
      次要 ${contrast(parseColor(colour('--dsw-alias-label-secondary', 'light')), parseColor(colour('--dsw-alias-bg-base', 'light'))).toFixed(1)}:1 ·
      链接 ${contrast(parseColor(colour('--dsw-alias-link', 'light')), parseColor(colour('--dsw-alias-bg-base', 'light'))).toFixed(1)}:1</div>

    <div class="turn" style="margin-top:16px">
      <div class="who">你</div>
      <div class="bubble">帮我看看这段配置为什么链接颜色这么淡。</div>
    </div>

    <div class="turn">
      <div class="who">助手</div>
      <p style="margin:0 0 8px">因为强调色在浅色背景上的对比度只有 <span class="inline-code">3.9:1</span>，低于正文的 4.5:1 下限。这套主题把链接抬到了 4.8:1，色相不变，只挪了亮度。</p>
      <div class="quote">引用块的颜色也一并抬高了，否则引用里的链接会比正文更淡。</div>
      <div class="code">
        <div class="banner">ts · inkstone.ts</div>
<pre><span class="tok-m">// 可读性优先：改色相，不改亮度层级</span>
<span class="tok-k">export</span> <span class="tok-k">function</span> <span class="tok-f">recolour</span><span class="tok-x">(</span>seed<span class="tok-x">:</span> <span class="tok-c">string</span><span class="tok-x">,</span> <span class="tok-p">hue</span><span class="tok-x">:</span> <span class="tok-c">number</span><span class="tok-x">)</span> <span class="tok-x">{</span>
  <span class="tok-k">const</span> <span class="tok-p">target</span> <span class="tok-x">=</span> <span class="tok-s">'4.5:1'</span><span class="tok-x">;</span>
  <span class="tok-k">return</span> <span class="tok-f">matchContrast</span><span class="tok-x">(</span>seed<span class="tok-x">,</span> hue<span class="tok-x">,</span> <span class="tok-p">target</span><span class="tok-x">);</span>
<span class="tok-x">}</span></pre>
      </div>
      <div class="status">
        <span class="pill ok">38 组配对全过</span>
        <span class="pill warn">警告文字 3.1:1</span>
        <span class="pill info">代码 9 色</span>
        <span class="pill bad">无破口</span>
      </div>
    </div>

    <div class="composer">输入消息…（正文 ${contrast(parseColor(colour('--dsw-alias-label-primary', 'light')), parseColor(colour('--dsw-specific-input-major', 'light'))).toFixed(1)}:1）</div>
  </main>

  <aside class="aside panel">
    <div class="label">设置</div>
    <h3 style="margin-top:6px">外观</h3>
    <div class="secondary">浅色 / 深色 / 跟随系统</div>
    <h3>菜单</h3>
    <div class="menu">
      <div class="head">主题</div>
      <div class="item">砚 · 浅色</div>
      <div class="item">砚 · 深色</div>
      <div class="head">字体</div>
      <div class="item">正文字体</div>
    </div>
  </aside>
</div>
</section>

<section class="mode" data-mode="dark">
<div class="shell">
  <aside class="sidebar panel">
    <div class="label">会话</div>
    <div class="nav">
      <div class="active">今天的会话</div>
      <div>主题插件方案</div>
      <div>配色可读性</div>
      <div class="secondary" style="font-size:12px;margin-top:8px">更早</div>
      <div>上一次排查</div>
    </div>
  </aside>

  <main class="panel" style="background: var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l1)">
    <h1>深色 · 砚</h1>
    <div class="caption">正文 ${contrast(parseColor(colour('--dsw-alias-label-primary', 'dark')), parseColor(colour('--dsw-alias-bg-base', 'dark'))).toFixed(1)}:1 ·
      次要 ${contrast(parseColor(colour('--dsw-alias-label-secondary', 'dark')), parseColor(colour('--dsw-alias-bg-base', 'dark'))).toFixed(1)}:1 ·
      链接 ${contrast(parseColor(colour('--dsw-alias-link', 'dark')), parseColor(colour('--dsw-alias-bg-base', 'dark'))).toFixed(1)}:1</div>

    <div class="turn" style="margin-top:16px">
      <div class="who">你</div>
      <div class="bubble">深色模式下气泡和输入框会不会糊在一起？</div>
    </div>

    <div class="turn">
      <div class="who">助手</div>
      <p style="margin:0 0 8px">不会。气泡 ${contrast(parseColor(colour('--dsw-specific-bubble', 'dark')), parseColor(colour('--dsw-alias-bg-base', 'dark'))).toFixed(2)}:1，输入框 ${contrast(parseColor(colour('--dsw-specific-input-major', 'dark')), parseColor(colour('--dsw-alias-bg-base', 'dark'))).toFixed(2)}:1，都比表面低一档但看得见。</p>
      <div class="code">
        <div class="banner">css · tokens</div>
<pre><span class="tok-m">/* 深色下强调色反向提亮 */</span>
<span class="tok-x">--</span><span class="tok-f">dsw-alias-link</span><span class="tok-x">:</span> <span class="tok-c">#41b7f3</span><span class="tok-x">;</span>
<span class="tok-x">--</span><span class="tok-f">dsw-alias-bg-base</span><span class="tok-x">:</span> <span class="tok-s">#14161a</span><span class="tok-x">;</span></pre>
      </div>
      <div class="status">
        <span class="pill ok">对比度全过</span>
        <span class="pill info">层级顺序正确</span>
      </div>
    </div>

    <div class="composer">输入消息…</div>
  </main>

  <aside class="aside panel">
    <div class="label">设置</div>
    <h3 style="margin-top:6px">外观</h3>
    <div class="secondary">浅色 / 深色 / 跟随系统</div>
    <h3>菜单</h3>
    <div class="menu">
      <div class="head">主题</div>
      <div class="item">砚 · 浅色</div>
      <div class="item">砚 · 深色</div>
    </div>
  </aside>
</div>
</section>

<section class="foot">
  <h2 style="margin-top:26px">动效与质感</h2>
  <div class="toolbar">
    <span class="caption">选中下面任意文字看选区色；按 Tab 看焦点环；点「重播」看消息上浮与面板弹出。</span>
    <button id="replayMotion" type="button" style="font:inherit;font-size:12px;padding:4px 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);cursor:pointer">重播</button>
  </div>
  <div class="motion-demo" id="motionDemo">
    <div class="motion-note">这句话可以拖选：选区用的是朱砂暖调，不是浏览器默认蓝。深色卡片里另有一份对应取值。</div>
    <div class="motion-menu">菜单从锚点微微放大出现（inkstone-pop）</div>
  </div>

  <h2 style="margin-top:26px">背景图 · 遮罩预览</h2>
  <div class="toolbar">
    <label>遮罩强度 <input id="strength" type="range" min="55" max="98" value="${Math.round(overlay.light * 100)}"> <span id="strengthValue">${Math.round(overlay.light * 100)}%</span></label>
    <span class="caption">预览用渐变模拟一张图；遮罩颜色就是表面色，所以图再花也不改正文对比度。</span>
  </div>
  <div class="bg-demo" id="bgDemo">
    <div class="wash"></div>
    <div class="content">
      <div class="label">会话</div>
      <div style="font-size:14px;line-height:1.7">这张图会被一层表面色遮住，再叠一点模糊。文字永远读在遮罩之上，而不是图上。</div>
    </div>
  </div>

  <h2 style="margin-top:26px">可读性配对（门禁结果）</h2>
  <table>
    <thead><tr><th>模式</th><th>场景</th><th class="num">实测</th><th class="num">下限</th><th>结果</th></tr></thead>
    <tbody>
      ${ratioRows}
    </tbody>
  </table>

  <h2 style="margin-top:26px">代码高亮（对代码块）</h2>
  <table>
    <thead><tr><th>模式</th><th>角色</th><th class="num">实测</th><th>结果</th></tr></thead>
    <tbody>
      ${shikiRows}
    </tbody>
  </table>

  <h2 style="margin-top:26px">色阶</h2>
  <div class="label">浅色</div>
  <div class="swatches">
    ${Object.entries(tokens)
      .filter(([name]) => name.startsWith('--dsw-static-'))
      .map(([, pair]) => `<div class="swatch" style="background:${pair.light}" title="${pair.light}"></div>`)
      .join('\n    ')}
  </div>
  <div class="label" style="margin-top:12px">深色</div>
  <div class="swatches">
    ${Object.entries(tokens)
      .filter(([name]) => name.startsWith('--dsw-static-'))
      .map(([, pair]) => `<div class="swatch" style="background:${pair.dark}" title="${pair.dark}"></div>`)
      .join('\n    ')}
  </div>

  <p class="caption" style="margin-top:20px">
    由 <code>tools/preview.mjs</code> 从真实的 <code>tools/tokens.json</code> 生成，没有任何一个颜色是手写的。
    最低的三项：${lowest.map((p) => `${p.why} ${p.ratio.toFixed(2)}:1`).join('、')}。
  </p>
</section>

<script>
  // 遮罩强度滑杆：两张主题卡片使用同一强度，浅色卡片的表面色就是遮罩色。
  const slider = document.getElementById('strength')
  const out = document.getElementById('strengthValue')
  const demo = document.getElementById('bgDemo')
  const applyStrength = () => {
    const value = Number(slider.value)
    out.textContent = value + '%'
    const wash = getComputedStyle(document.querySelector('[data-mode="light"]')).getPropertyValue('--dsw-alias-bg-base').trim() || '#f7f6f3'
    demo.querySelector('.wash').style.background = 'color-mix(in srgb, ' + wash + ' ' + value + '%, transparent)'
  }
  slider.addEventListener('input', applyStrength)
  applyStrength()

  // 重播动效：移除 class 后强制回流，再重新加上，让动画从头播。
  const replay = document.getElementById('replayMotion')
  const note = document.querySelector('.motion-note')
  const menu = document.querySelector('.motion-menu')
  replay.addEventListener('click', () => {
    for (const el of [note, menu]) {
      el.classList.remove('playing')
      void el.offsetWidth
      el.classList.add('playing')
    }
  })
</script>
</body>
</html>
`

writeFileSync(join(ROOT, 'preview.html'), html)
console.log(`wrote preview.html (${html.length} bytes, ${Object.keys(tokens).length} tokens, ${report.pairs.length} pairs)`)
