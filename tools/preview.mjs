/**
 * Renders ramps.json into a self-contained preview page: the real token names
 * with the real generated values, wired into a mock of the surfaces DSH
 * actually builds (sidebar, bubbles, composer, menus, markdown, states).
 *
 * The point is to judge the palette in context rather than as a row of
 * swatches, so every block below consumes the same token a real component
 * consumes.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ramps = JSON.parse(readFileSync(join(HERE, 'ramps.json'), 'utf8'))
const tokens = JSON.parse(readFileSync(join(HERE, 'tokens.json'), 'utf8'))

const cssVars = (statics, aliases) =>
  [
    ...Object.entries(statics).map(([k, v]) => `  ${k}: ${v};`),
    ...Object.entries(aliases).map(([k, v]) => `  ${k}: ${v};`),
  ].join('\n')

const SPECIFIC_DARK = {
  '--dsw-specific-bubble': ramps.aliasDark['--dsw-specific-bubble'],
  '--dsw-specific-bubble-highlight': ramps.aliasDark['--dsw-specific-bubble-highlight'],
  '--dsw-specific-input-major': ramps.aliasDark['--dsw-specific-input-major'],
  '--dsw-specific-sidebar-fill': ramps.aliasDark['--dsw-specific-sidebar-fill'],
  '--dsw-specific-sidebar-nav-item-active': ramps.aliasDark['--dsw-specific-sidebar-nav-item-active'],
  '--dsw-specific-sidebar-nav-item-active-accent': ramps.aliasDark['--dsw-specific-sidebar-nav-item-active-accent'],
  '--dsw-specific-sidebar-nav-item-hover': ramps.aliasDark['--dsw-specific-sidebar-nav-item-hover'],
  '--dsw-specific-menu': ramps.aliasDark['--dsw-specific-menu'],
  '--dsw-specific-selector': ramps.aliasDark['--dsw-specific-selector'],
  '--dsw-specific-tip': ramps.aliasDark['--dsw-specific-tip'],
}

const ROLES = [
  ['bg-base', 'app background'],
  ['bg-layer-1', 'panel'],
  ['bg-layer-2', 'raised'],
  ['bg-layer-3', 'menu'],
  ['label-primary', 'body text'],
  ['label-secondary', 'secondary'],
  ['label-tertiary', 'tertiary'],
  ['label-caption', 'caption'],
  ['brand-primary', 'brand / primary button'],
  ['link', 'link'],
  ['state-business-primary', 'accent'],
  ['state-success-primary', 'success'],
  ['state-warn-primary', 'warn'],
  ['state-error-primary', 'error'],
  ['border-l2', 'border'],
]

const frame = (mode, title) => {
  const statics = ramps[mode]
  const aliases = ramps['alias' + mode[0].toUpperCase() + mode.slice(1)]
  const roleSwatches = ROLES.map(([token, label]) => {
    const value = aliases['--dsw-alias-' + token]
    return `<div class="sw"><span class="chip" style="background:${value}"></span><b>${token}</b><code>${value}</code><i>${label}</i></div>`
  }).join('\n')

  return `
<section class="frame ${mode}" ${mode === 'dark' ? 'data-ds-dark-theme' : ''}>
  <style>
  .frame.${mode} {
${cssVars(statics, aliases)}
    background: var(--dsw-alias-bg-base);
    color: var(--dsw-alias-label-primary);
  }
  </style>
  <h2>${title}</h2>
  <div class="app">
    <aside class="sidebar">
      <div class="brand"><span class="mark"></span> dsh</div>
      <nav>
        <a class="nav">会话</a>
        <a class="nav active">墨玉主题 <span class="accentbar"></span></a>
        <a class="nav">文件</a>
        <a class="nav">设置</a>
      </nav>
    </aside>
    <main class="main">
      <header class="header">
        <b>Inkstone palette review</b>
        <span class="tag">theme</span>
        <span class="tag accent">v1</span>
      </header>
      <div class="stream">
        <div class="bubble assistant">
          <p>已按 OKLCH 保亮度重映射中性阶，并把强调色按模式做了明度倾斜。</p>
          <p>链接见 <a class="link" href="#">docs/web-styling.md</a>，行内代码 <code class="inline">ctx.theme.overrideTokens</code>。</p>
          <pre class="code"><span class="cm">// 覆盖原始色阶，alias 层自动重导出</span>
ctx.theme.<b>overrideTokens</b>(<span class="str">'inkstone'</span>, tokens)</pre>
          <table>
            <tr><th>模式</th><th>bg-base</th><th>link</th></tr>
            <tr><td>light</td><td><code class="inline">${aliases['--dsw-alias-bg-base']}</code></td><td><code class="inline">${aliases['--dsw-alias-link']}</code></td></tr>
            <tr><td>dark</td><td><code class="inline">${ramps.aliasDark['--dsw-alias-bg-base']}</code></td><td><code class="inline">${ramps.aliasDark['--dsw-alias-link']}</code></td></tr>
          </table>
        </div>
        <div class="bubble user"><p>对比度验证过了吗？</p></div>
        <div class="bubble assistant">
          <p class="ok">✓ 无回退</p>
          <p class="warn">! 3 项低于阈值，但基线也一样</p>
          <p class="err">✕ 未发现新问题</p>
        </div>
      </div>
      <div class="composer">
        <div class="input"><span class="ph">回复…</span><span class="selector">deepseek-flash</span></div>
        <button class="primary">发送</button>
        <button class="info">工具</button>
      </div>
      <div class="overlays">
        <div class="menu"><div class="mi">复制</div><div class="mi hl">引用</div><div class="mi">删除</div></div>
        <div class="tip">Tooltip</div>
        <div class="toast">已安装</div>
        <div class="scroll"><span></span></div>
      </div>
    </main>
  </div>
  <div class="swatches">${roleSwatches}</div>
  <p class="note">核心色阶 · bluish ramp: ${Object.entries(statics)
    .filter(([k]) => k.startsWith('--dsw-static-neutral-bluish-'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => `<span class="ramp" style="background:${v}"></span>`)
    .join('')}</p>
  <p class="note">青玉 · accent ramp: ${Object.entries(statics)
    .filter(([k]) => k.startsWith('--dsw-static-deepseek-'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => `<span class="ramp" style="background:${v}"></span>`)
    .join('')}</p>
</section>`
}

const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>Inkstone palette preview</title>
<style>
  body { margin: 0; background: #6b7280; font: 13px/1.6 -apple-system, "Segoe UI", system-ui, sans-serif; }
  .frame { padding: 20px 24px 28px; }
  .frame h2 { margin: 0 0 14px; font-size: 15px; letter-spacing: .04em; text-transform: uppercase; opacity: .7; }
  .app { display: flex; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; overflow: hidden; }
  .sidebar { width: 148px; flex: none; background: var(--dsw-specific-sidebar-fill); border-right: 1px solid var(--dsw-alias-border-l1); padding: 10px 8px; }
  .brand { display: flex; align-items: center; gap: 6px; font-weight: 600; padding: 4px 6px 12px; }
  .mark { width: 14px; height: 14px; border-radius: 50%; background: var(--dsw-alias-brand-primary); }
  nav { display: grid; gap: 2px; }
  .nav { position: relative; display: block; padding: 6px 8px; border-radius: 6px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
  .nav.active { background: var(--dsw-specific-sidebar-nav-item-active); color: var(--dsw-alias-label-primary); font-weight: 600; }
  .accentbar { position: absolute; inset-inline-start: 0; top: 6px; bottom: 6px; width: 3px; border-radius: 2px; background: var(--dsw-specific-sidebar-nav-item-active-accent); }
  .main { flex: 1; padding: 0 0 14px; }
  .header { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
  .stream { padding: 14px 16px 0; display: grid; gap: 10px; }
  .bubble { border-radius: 10px; padding: 9px 12px; max-width: 92%; }
  .bubble p { margin: 0 0 6px; }
  .bubble p:last-child { margin-bottom: 0; }
  .bubble.assistant { background: var(--dsw-specific-bubble); color: var(--dsw-alias-label-primary); }
  .bubble.user { background: var(--dsw-specific-bubble-highlight); justify-self: end; }
  .link { color: var(--dsw-alias-link); }
  code.inline { background: var(--dsw-alias-markdown-inline-code); border-radius: 4px; padding: 1px 4px; font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; }
  pre.code { margin: 8px 0; padding: 9px 11px; border-radius: 8px; background: var(--dsw-alias-markdown-code-block); border: 1px solid var(--dsw-alias-border-l1); font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
  pre.code .cm { color: var(--dsw-alias-label-tertiary); }
  pre.code .str { color: var(--dsw-alias-state-business-primary); }
  pre.code b { color: var(--dsw-alias-link); font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 12px; }
  th, td { text-align: start; padding: 4px 6px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
  th { color: var(--dsw-alias-label-tertiary); font-weight: 500; }
  .ok { color: var(--dsw-alias-state-success-primary); margin: 0; }
  .warn { color: var(--dsw-alias-state-warn-label); margin: 0; }
  .err { color: var(--dsw-alias-state-error-primary); margin: 0; }
  .tag { padding: 1px 7px; border-radius: 20px; font-size: 11px; background: var(--dsw-alias-markdown-tag); color: var(--dsw-alias-label-secondary); }
  .tag.accent { background: var(--dsw-alias-state-business-tertiary); color: var(--dsw-alias-state-business-primary); }
  .composer { display: flex; gap: 8px; align-items: center; padding: 14px 16px 0; }
  .input { flex: 1; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 9px 11px; border-radius: 10px; background: var(--dsw-specific-input-major); border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-tertiary); }
  .selector { background: var(--dsw-specific-selector); border-radius: 6px; padding: 2px 7px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
  button { border: 0; border-radius: 8px; padding: 9px 16px; font: inherit; font-weight: 600; cursor: default; }
  button.primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
  button.info { background: var(--dsw-alias-button-info-fill); color: #fff; }
  .overlays { position: relative; display: flex; gap: 10px; padding: 14px 16px 0; height: 78px; }
  .menu { background: var(--dsw-specific-menu); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 4px; font-size: 12px; box-shadow: 0 6px 18px rgb(0 0 0 / .18); }
  .mi { padding: 3px 12px 3px 8px; border-radius: 5px; color: var(--dsw-alias-label-secondary); }
  .mi.hl { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
  .tip { align-self: start; background: var(--dsw-alias-tooltip-bg); color: var(--dsw-alias-label-primary-inverted); border-radius: 6px; padding: 4px 9px; font-size: 11.5px; }
  .toast { align-self: start; background: var(--dsw-alias-toast-bg); color: var(--dsw-alias-label-primary-inverted); border-radius: 8px; padding: 5px 11px; font-size: 12px; }
  .scroll { width: 9px; align-self: stretch; border-radius: 5px; background: var(--dsw-alias-scrollbar-bg-l1); position: relative; }
  .scroll span { position: absolute; inset: 8px 0 22px; border-radius: 5px; background: var(--dsw-alias-scrollbar-hover-l1); }
  .swatches { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px 14px; margin-top: 16px; }
  .sw { display: flex; align-items: center; gap: 7px; font-size: 11px; }
  .sw .chip { width: 16px; height: 16px; border-radius: 4px; flex: none; border: 1px solid var(--dsw-alias-border-l3); }
  .sw b { font-weight: 500; }
  .sw code { color: var(--dsw-alias-label-tertiary); font-family: ui-monospace, Consolas, monospace; }
  .sw i { color: var(--dsw-alias-label-caption); font-style: normal; }
  .note { display: flex; align-items: center; gap: 2px; margin: 10px 0 0; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
  .note .ramp { width: 26px; height: 15px; border-radius: 3px; display: inline-block; }
</style></head>
<body>
${frame('light', 'Light — 砚石 / 青玉')}
${frame('dark', 'Dark — 砚石 / 青玉')}
</body></html>`

writeFileSync(join(HERE, '..', 'preview.html'), html)
console.log('wrote preview.html')
console.log('override tokens:', Object.keys(tokens).length)
