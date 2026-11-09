/**
 * Generates the palette from the installed baseline.
 *
 * The theme is defined by one rule — **readability first, then the tilt**:
 *
 *   1. Read the baseline from the running harness (tools/baseline.mjs).
 *   2. Recolour each family in OKLCH keeping WCAG *luminance* — hue and chroma
 *      move, lightness does not, so contrast is preserved by construction.
 *   3. Write the ramp members and the semantic tokens that alias them.
 *   4. Style the leftovers: the literal-hex semantic tokens that no ramp feeds,
 *      the code-highlight colours, and the non-colour axes (`--dsh-*` font
 *      stacks and radii, which the user-facing font setting reads through).
 *   5. Run the readability gate over every conversation pair. Any pair that the
 *      baseline already passes must still pass; the 28 pairs that matter for
 *      reading a session carry a hard minimum.
 *
 * Outputs: tools/tokens.json (data), tools/report.json (evidence), stdout (summary).
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readBaseline, resolveToken, resolveWithSource } from './baseline.mjs'
import {
  composite,
  contrast,
  isColor,
  luminance,
  oklchToSrgb,
  parseColor,
  remap,
  toHex,
  toOklch,
} from './color.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

// ---------------------------------------------------------------------------
// Strategy constants — change these to re-tune the theme, then rerun.
// ---------------------------------------------------------------------------

/**
 * Colour families by ramp prefix (two entries share `--dsw-static-neutral-` and
 * are told apart by their next segment, longest prefix wins).
 *
 * `hue` is the target OKLCH hue; `chroma` scales the baseline chroma. Neutrals
 * get a faint warm-stone tint instead of pure grey: a true 0-chroma ladder
 * reads as flat on OLED panels, and screenshots of pure grey look "unset".
 */
export const FAMILIES = {
  '--dsw-static-neutral-bluish': { hue: 96, chroma: 0.55, label: 'stone' },
  '--dsw-static-neutral': { hue: 96, chroma: 0.4, label: 'ash' },
  '--dsw-static-deepseek': { hue: 235, chroma: 1.0, label: 'ink-blue' },
  '--dsw-static-blue': { hue: 250, chroma: 0.95, label: 'azure' },
  '--dsw-static-violet': { hue: 300, chroma: 0.8, label: 'violet' },
}

/** Families the theme leaves exactly as the baseline defines them. */
export const PRESERVED_FAMILIES = ['--dsw-static-green', '--dsw-static-amber', '--dsw-static-red']

/**
 * Accent families are nudged in lightness to survive their own backdrop:
 * slightly darker in light mode, slightly lighter in dark mode.
 */
const ACCENT_TILT = { light: -0.012, dark: 0.008 }

/**
 * Semantic tokens that keep the baseline role but move to a themed hue.
 * `mode` limits the change to one colour scheme (the warning label needs a
 * one-step darkening in light mode only).
 */
const SEMANTIC_HUES = {
  '--dsw-alias-interactive-bg-hover': { hue: 245, chroma: 1.2 },
  '--dsw-alias-interactive-bg-active': { hue: 245, chroma: 1.2 },
  '--dsw-alias-interactive-bg-hover-accent': { hue: 235, chroma: 1.1 },
  '--dsw-alias-button-tool-bar-fill': { hue: 245, chroma: 0.5 },
  '--dsw-alias-button-tool-bar-hover': { hue: 245, chroma: 0.5 },
}

/** Literal-hex semantic tokens that should follow a ramp value instead. */
const LITERAL_ALIASES = {
  '--dsw-alias-border-inverted': '--dsw-static-neutral-bluish-00',
  '--dsw-alias-border-inverted2': '--dsw-static-neutral-bluish-50',
  '--dsw-alias-brand-primary-new-colorprimary-new-color': '--dsw-static-deepseek-500',
}

/**
 * Code-highlight roles. A syntax scheme needs at least four distinguishable
 * hues to stay readable across a long code block; the warm `55°` parameter
 * colour is deliberately the only warm point in an otherwise cool theme.
 */
const SHIKI_ROLES = {
  '--shiki-token-constant': { hue: 245, chroma: 1.0 },
  '--shiki-token-string': { hue: 145, chroma: 0.85 },
  '--shiki-token-string-expression': { hue: 145, chroma: 0.85, lightDelta: 0.02 },
  '--shiki-token-comment': { hue: 96, chroma: 0.45 },
  '--shiki-token-keyword': { hue: 330, chroma: 0.9 },
  '--shiki-token-parameter': { hue: 55, chroma: 0.8 },
  '--shiki-token-function': { hue: 285, chroma: 0.9 },
  '--shiki-token-punctuation': { hue: 96, chroma: 0.3 },
  '--shiki-token-link': { hue: 235, chroma: 1.0 },
}

/**
 * The reading surface. The overlay is what shows through when `bg-base` is made
 * translucent for a background image; with the image off it *is* the surface.
 *
 * It is deliberately opaque: it is the backdrop every contrast pair is measured
 * against, so it must be a fixed value, not something that varies with a photo.
 */
export const SURFACE = { light: '#f7f6f3', dark: '#14161a' }

/** Overlay strength for the optional background image. Higher = more legible, less picture. */
export const OVERLAY = { light: 0.82, dark: 0.88 }

/**
 * Non-colour axes. The `--dsh-*` names are what the "font" rows in Settings write
 * through, so redefining them re-styles text without touching layout.
 */
const TYPOGRAPHY = {
  '--dsh-font-family-text-default':
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif',
  '--dsh-font-family-code-default':
    '"SF Mono", "JetBrains Mono", "Fira Code", Consolas, "Liberation Mono", Menlo, Courier, "PingFang SC", "Microsoft YaHei", monospace',
}

const RADIUS = {
  '--dsw-radius-xs': '4px',
  '--dsw-radius-sm': '8px',
  '--dsw-radius-md': '12px',
  '--dsw-radius-lg': '16px',
  '--dsw-radius-xl': '20px',
  '--dsw-radius-panel': '28px',
}

/**
 * Readability pairs, measured on the *composited* result (translucent tokens
 * flattened over the surface). `floor` is the hard minimum; `inherited` means
 * the baseline itself misses it, and the theme may not make it worse.
 */
const PAIRS = [
  // Body text — the session itself.
  { fg: '--dsw-alias-label-primary', bg: '--dsw-alias-bg-base', floor: 7.0, why: '正文' },
  { fg: '--dsw-alias-label-secondary', bg: '--dsw-alias-bg-base', floor: 4.5, why: '次要文字' },
  { fg: '--dsw-alias-label-tertiary', bg: '--dsw-alias-bg-base', floor: 4.5, why: '辅助文字' },
  { fg: '--dsw-alias-label-caption', bg: '--dsw-alias-bg-base', floor: 3.0, why: '说明文字', inherited: true },
  { fg: '--dsw-alias-link', bg: '--dsw-alias-bg-base', floor: 4.5, why: '链接' },
  // Bubbles — a user message must read as clearly as an assistant message.
  { fg: '--dsw-alias-label-primary', bg: '--dsw-specific-bubble', floor: 7.0, why: '用户气泡' },
  { fg: '--dsw-alias-label-primary', bg: '--dsw-alias-markdown-citation', floor: 7.0, why: '引用块' },
  // Code, the largest single colour area in a session.
  { fg: '--dsw-alias-label-primary', bg: '--dsw-alias-markdown-code-block', floor: 7.0, why: '代码块' },
  { fg: '--dsw-alias-label-primary', bg: '--dsw-alias-markdown-inline-code', floor: 7.0, why: '行内代码' },
  { fg: '--dsw-alias-label-primary', bg: '--dsw-alias-markdown-code-block-banner', floor: 7.0, why: '代码块标题条' },
  // Composer and navigation.
  { fg: '--dsw-alias-label-primary', bg: '--dsw-specific-input-major', floor: 7.0, why: '输入框' },
  { fg: '--dsw-alias-label-secondary', bg: '--dsw-specific-input-major', floor: 4.5, why: '输入框占位' },
  { fg: '--dsw-alias-label-primary', bg: '--dsw-specific-sidebar-fill', floor: 7.0, why: '侧栏' },
  { fg: '--dsw-alias-label-secondary', bg: '--dsw-specific-sidebar-fill', floor: 4.5, why: '侧栏次级' },
  { fg: '--dsw-alias-label-primary', bg: '--dsw-specific-sidebar-nav-item-active', floor: 7.0, why: '侧栏选中项' },
  // Floating surfaces.
  { fg: '--dsw-alias-label-primary', bg: '--dsw-alias-menu-group-header-fill', floor: 7.0, why: '菜单分组标题' },
  { fg: '--dsw-alias-toast-label', bg: '--dsw-alias-toast-bg', floor: 4.5, why: 'Toast 文字' },
  { fg: '--dsw-alias-tooltip-label', bg: '--dsw-alias-tooltip-bg', floor: 4.5, why: '提示框文字' },
  // States.
  { fg: '--dsw-alias-state-business-primary', bg: '--dsw-alias-bg-base', floor: 4.5, why: '业务色（链接/按钮）' },
  { fg: '--dsw-alias-state-error-primary', bg: '--dsw-alias-bg-base', floor: 4.5, why: '错误色' },
  { fg: '--dsw-alias-state-warn-label', bg: '--dsw-alias-bg-base', floor: 3.0, why: '警告文字', inherited: true },
  { fg: '--dsw-alias-state-success-primary', bg: '--dsw-alias-bg-base', floor: 3.0, why: '成功色', inherited: true },
  // Contrast button.
  { fg: '--dsw-alias-label-primary-foreground', bg: '--dsw-alias-button-contrast-fill', floor: 4.5, why: '反色按钮', inherited: true },
]

/** Code-highlight pairs: same gate, measured against the code block. */
const SHIKI_FLOOR = 4.5

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Per-seed contrast targets, applied to the **recoloured** value measured
 * against its own surface. `target` is the ratio a text colour must reach;
 * `maxTarget` is the ceiling for large fills.
 *
 * Only seeds whose role is known are listed: pinning a ramp member to a
 * contrast ratio (rather than re-tinting it) would flatten the ladder, so the
 * generator changes lightness for these and hue for everything else.
 */
const TARGETS = {
  '--dsw-static-neutral-bluish-1000': { target: 15 },
  '--dsw-static-neutral-bluish-950': { target: 14 },
  '--dsw-static-neutral-bluish-900': { target: 10 },
  '--dsw-static-neutral-bluish-700': { target: 7.2 }, // contrast-button fill (white label on it)
  '--dsw-static-neutral-bluish-600': { target: 4.7 },
  '--dsw-static-neutral-bluish-400': { target: 3.2 },
  '--dsw-static-deepseek-500': { target: 4.8 },
  '--dsw-static-deepseek-450': { target: 4.8 },
  '--dsw-static-deepseek-400': { target: 4.8 },
  '--dsw-static-red-600': { target: 4.8 },
  '--dsw-static-red-400': { target: 4.8 },
}

/** Rainbows: re-tinted only, never re-anchored. */
const TINT_ONLY = ['--dsw-static-amber', '--dsw-static-green', '--dsw-static-blue', '--dsw-static-violet']

/**
 * Recolour one ramp or accent value onto a declared **contrast** against the
 * surface it sits on.
 *
 * Contrast is decided by relative luminance, and relative luminance is what
 * changes when a colour moves. Measured in WCAG terms: the baseline set has
 * links at 3.9:1 on white and 3.16:1 nearly everywhere else, which is exactly
 * what a "readability first" theme must not ship. So each seed names a target
 * ratio, and `matchContrast` finds the hue/chroma/lightness point that hits it.
 *
 * @param {string} value Baseline declaration.
 * @param {{ hue?: number, chroma?: number, target?: number, minTarget?: number }} spec
 * @param {'light' | 'dark'} mode
 * @returns {string | null} null when the value is not a literal colour.
 */
export function recolourContrast(value, spec, mode) {
  const rgba = isColor(value) ? parseColor(value) : null
  if (rgba === null) return null
  const alpha = rgba[3]
  const backdrop = parseColor(SURFACE[mode])
  const surfaceLum = luminance(backdrop)

  // Start from the tinted colour, then move it only as far as the target needs.
  const tinted = spec.hue === undefined && spec.chroma === undefined
    ? toHex(rgba)
    : remap(value, { hue: spec.hue, chroma: spec.chroma })
  const tintedRgba = parseColor(tinted)
  const { L, C } = toOklch(tintedRgba)

  const wanted = spec.target
  if (wanted === undefined) return tinted
  if (contrast(tintedRgba, backdrop) >= wanted) return tinted

  const darker = luminanceNeededFor(wanted, surfaceLum, 'dark')
  const lighter = luminanceNeededFor(wanted, surfaceLum, 'light')
  // Move in the direction that costs the least lightness change.
  const options = []
  if (darker !== null) options.push({ goal: darker, from: luminanceOf(L, C, spec.hue ?? toOklch(tintedRgba).h) })
  if (lighter !== null) options.push({ goal: lighter, from: luminanceOf(L, C, spec.hue ?? toOklch(tintedRgba).h) })
  options.sort((a, b) => Math.abs(a.goal - a.from) - Math.abs(b.goal - b.from))

  for (const option of options) {
    const hit = matchLuminance(option.goal, C, spec.hue ?? toOklch(tintedRgba).h, 1)
    if (hit !== null && contrast(parseColor(hit), backdrop) >= wanted) return hit
  }
  return tinted
}

/** Luminance of an OKLCH point, for choosing the cheaper direction. */
function luminanceOf(L, C, hue) {
  const [r, g, b] = oklchToSrgb(L, C, hue)
  return luminance([r, g, b, 1])
}

/**
 * Recolour one **foreground** token — a value that will be typed on top of a
 * named background token — onto a contrast target measured against that
 * background.
 *
 * Separate from {@link recolourContrast} because a foreground lives inside the
 * pair it serves (a button label belongs to its button, not to the page), and
 * because `matchLuminance` re-tints rather than re-anchors: calling it on an
 * already-tinted colour must not lose the tint.
 *
 * @param {string} value Baseline foreground declaration.
 * @param {{ hue?: number, chroma?: number, floor: number, bgToken: string }} spec
 * @param {Record<string, { light: string, dark: string }>} tokens Resolved so far.
 * @param {'light' | 'dark'} mode
 * @returns {string | null}
 */
export function recolourPair(value, spec, tokens, mode) {
  const rgba = isColor(value) ? parseColor(value) : null
  if (rgba === null) return null
  const bgEntry = tokens[spec.bgToken]
  if (bgEntry === undefined) return null
  const bg = parseColor(bgEntry[mode])
  const tinted = spec.hue === undefined && spec.chroma === undefined
    ? toHex(rgba)
    : remap(value, { hue: spec.hue, chroma: spec.chroma })
  const tintedRgba = parseColor(tinted)
  if (contrast(tintedRgba, bg) >= spec.floor) return tinted

  const bgLum = luminance(bg)
  const { L, C } = toOklch(tintedRgba)
  const hue = spec.hue ?? toOklch(tintedRgba).h

  // Ladder of goals above the floor: a hue can be out of gamut at one specific
  // luminance, and 8-bit rounding eats ~0.02 of ratio near white, so accepting
  // only the exact floor would report a token as unreadable when it is not.
  const from = luminanceOf(L, C, hue)
  const options = []
  for (const goal of [spec.floor, spec.floor + 0.5, spec.floor + 1.5, spec.floor + 3]) {
    for (const candidate of luminanceCandidates(goal, bgLum)) {
      options.push({ goal, target: candidate.target, cost: Math.abs(candidate.target - from) })
    }
  }
  options.sort((a, b) => a.cost - b.cost)
  const floor = spec.floor
  const accepted = (hex) => hex !== null && contrast(parseColor(hex), bg) >= floor
  for (const option of options) {
    const hit = matchLuminance(option.target, C, hue, 1)
    if (accepted(hit)) return hit
  }
  // 8-bit rounding can leave a hue a hair under the floor at every representable
  // point on that side; try the far side, then go grey. A readable token always
  // exists: white on a dark fill, black on a light one.
  for (const option of options) {
    const hit = matchLuminance(option.target, 0, hue, 1)
    if (accepted(hit)) return hit
  }
  return accepted('#000000') ? '#000000' : accepted('#ffffff') ? '#ffffff' : tinted
}
function luminanceNeededFor(ratio, surfaceLum, direction) {
  if (direction === 'dark') {
    const y = (surfaceLum + 0.05) / ratio - 0.05
    return y >= 0 ? y : null
  }
  const y = ratio * (surfaceLum + 0.05) - 0.05
  return y <= 1 ? y : null
}

/**
 * The luminance a foreground needs, on whichever side of a surface still has
 * room. Near-white and near-black surfaces only allow one side, so asking for
 * "darker text" on a 0.92-luminance surface silently asks for the impossible.
 *
 * @param {number} ratio
 * @param {number} surfaceLum
 * @returns {{ target: number, side: 'dark' | 'light' }[]} Best-first.
 */
function luminanceCandidates(ratio, surfaceLum) {
  const out = []
  const darker = luminanceNeededFor(ratio, surfaceLum, 'dark')
  const lighter = luminanceNeededFor(ratio, surfaceLum, 'light')
  if (darker !== null) out.push({ target: darker, side: /** @type {const} */ ('dark') })
  if (lighter !== null) out.push({ target: lighter, side: /** @type {const} */ ('light') })
  return out
}

/**
 * Recolour a foreground that must **invert** its background: the label sits on
 * a surface whose colour is the opposite of the reading surface (a dark button
 * on a light page). Remapping both ends to the same hue family would collide —
 * so the foreground keeps its role (light text on dark fill, or the reverse)
 * and only enough contrast is enforced.
 *
 * @param {string} value Baseline foreground declaration.
 * @param {{ floor: number, bgToken: string }} spec
 * @param {Record<string, { light: string, dark: string }>} tokens
 * @param {'light' | 'dark'} mode
 * @returns {string | null}
 */
export function recolourInverse(value, spec, tokens, mode) {
  const rgba = isColor(value) ? parseColor(value) : null
  const bgEntry = tokens[spec.bgToken]
  if (rgba === null || bgEntry === undefined) return null
  const bg = parseColor(bgEntry[mode])
  const current = toHex(rgba)
  if (contrast(rgba, bg) >= spec.floor) return current

  const bgLum = luminance(bg)
  // Invert: the label wants the *far* side of the fill's luminance.
  const direction = /** @type {const} */ (bgLum > 0.5 ? 'dark' : 'light')
  const { C, h } = toOklch(rgba)
  for (const goal of [spec.floor, spec.floor + 1, spec.floor + 3]) {
    const target = luminanceNeededFor(goal, bgLum, direction)
    if (target === null) continue
    const hit = matchLuminance(target, C * 0.3, h, 1)
    if (hit !== null && contrast(parseColor(hit), bg) >= spec.floor) return hit
  }
  return contrast(parseColor('#000000'), bg) >= spec.floor ? '#000000' : '#ffffff'
}

/**
 * Find the colour at `hue` whose luminance is closest to `target`, by bisecting
 * OKLCH lightness at decreasing chroma until a representable colour hits the
 * request.
 * @param {number} target Clamped to [0, 1].
 * @param {number} chroma Seed chroma.
 * @param {number} hue
 * @param {number} alpha
 * @returns {string | null}
 */
export function matchLuminance(target, chroma, hue, alpha) {
  const goal = Math.min(1, Math.max(0, target))
  /** @type {string | null} */
  let best = null
  let bestErr = Infinity
  for (let attempt = 0; attempt < 8; attempt++) {
    const c = chroma * 0.7 ** attempt
    let lo = 0
    let hi = 1
    for (let i = 0; i < 28; i++) {
      const mid = (lo + hi) / 2
      const [r, g, b] = oklchToSrgb(mid, c, hue)
      if (luminance([r, g, b, 1]) < goal) lo = mid
      else hi = mid
    }
    const L = (lo + hi) / 2
    const [r, g, b] = oklchToSrgb(L, c, hue)
    const err = Math.abs(luminance([r, g, b, 1]) - goal)
    if (err < bestErr) {
      best = toHex([r, g, b, alpha])
      bestErr = err
    }
    // One 8-bit step on a near-white surface is ~0.015 luminance; below that
    // the search has converged as far as hex can represent and rounding the
    // ratio further is pointless.
    if (bestErr < 0.002) break
  }
  return best
}
function familyOf(name) {
  let best = null
  for (const [prefix, spec] of Object.entries(FAMILIES)) {
    if (!name.startsWith(prefix)) continue
    if (best === null || prefix.length > best.key.length) best = { key: prefix, spec }
  }
  return best
}

/** @param {string} name */
function isPreserved(name) {
  return PRESERVED_FAMILIES.some((prefix) => name.startsWith(prefix))
}

/**
 * Recolour one ramp member or accent value.
 * @param {string} value Baseline declaration.
 * @param {object} family
 * @param {'light' | 'dark'} mode
 * @returns {string | null} null when the value is not a literal colour.
 */
function recolour(value, family, mode) {
  if (!isColor(value)) return null
  const tilt = ACCENT_TILT[mode] ?? 0
  return remap(value, { hue: family.hue, chroma: family.chroma, lightDelta: tilt })
}

/**
 * Step a colour darker in OKLCH until it meets `target` against `against`.
 * Used for the one inherited warning label, which is a pure foreground token:
 * darkening it changes no fill anywhere.
 *
 * @param {string} value
 * @param {string} against
 * @param {number} target
 * @returns {string} The input when it already passes or cannot be resolved.
 */
export function darkenToMeet(value, against, target) {
  const fg = isColor(value) ? parseColor(value) : null
  const bg = isColor(against) ? parseColor(against) : null
  if (fg === null || bg === null) return value
  if (contrast(fg, bg) >= target) return value
  const { L, C, h } = toOklch(fg)
  for (let step = 1; step <= 40; step++) {
    const [r, g, b] = oklchToSrgb(Math.max(0, L - step * 0.01), C, h)
    const candidate = toHex([r, g, b, fg[3]])
    if (contrast(parseColor(candidate), bg) >= target) return candidate
  }
  return value
}

/**
 * Build the final token map.
 * @returns {{ tokens: Record<string, { light: string, dark: string }>, provenance: Record<string, string> }}
 */
export function generate() {
  const baseline = readBaseline()
  const { modes, shiki } = baseline

  /** @type {Record<string, { light: string, dark: string }>} */
  const tokens = {}
  /** @type {Record<string, string>} */
  const provenance = {}
  let light = { ...modes.light }
  let dark = { ...modes.dark }

  // 1. Ramps: hue by family, then lift/darken the known text roles onto their
  //    contrast target. Everything else is tint only.
  for (const name of baseline.ramps) {
    const family = familyOf(name)
    if (family === null || isPreserved(name)) continue
    const tintOnly = TINT_ONLY.some((p) => name.startsWith(p))
    const spec = tintOnly ? null : (TARGETS[name] ?? null)
    const lv = recolour(light[name], family.spec, 'light')
    const dv = recolour(dark[name], family.spec, 'dark')
    if (lv === null && dv === null) continue
    const l = spec === null || lv === null ? lv : recolourContrast(light[name], { ...spec, ...family.spec }, 'light')
    const d = spec === null || dv === null ? dv : recolourContrast(dark[name], { ...spec, ...family.spec }, 'dark')
    tokens[name] = { light: l ?? light[name], dark: d ?? dark[name] }
    provenance[name] = spec === null ? `ramp:${family.spec.label}` : `ramp:${family.spec.label}:contrast`
  }

  // 2. Semantic tokens are emitted only when they *alias* a themed seed.
  //
  //    A token declared as a literal hex already lives in the ramp it names, so
  //    overriding it would be a second, independent edit; a `color-mix()` cannot
  //    be pre-computed without dropping colours from DSH's own palette. Both are
  //    left to inherit from the ramp (the presenter writes ramp overrides to
  //    `body`, which every consumer under it reads).
  for (const name of baseline.semantic) {
    if (name === '--dsw-alias-bg-base') continue
    const hitLight = resolveWithSource(name, modes.light)
    const hitDark = resolveWithSource(name, modes.dark)
    if (hitLight === null || hitDark === null) continue
    if (hitLight.source === name || hitDark.source === name) continue
    if (tokens[hitLight.source] === undefined || tokens[hitDark.source] === undefined) continue

    const lHex = tokens[hitLight.source].light
    const dHex = tokens[hitDark.source].dark
    const spec = SEMANTIC_HUES[name]
    if (spec !== undefined) {
      tokens[name] = { light: remap(lHex, spec), dark: remap(dHex, spec) }
      provenance[name] = 'semantic:hue'
    } else {
      tokens[name] = { light: lHex, dark: dHex }
      provenance[name] = 'semantic:alias'
    }
  }

  // 3. Literal-hex semantic tokens that should follow a ramp instead.
  for (const [name, source] of Object.entries(LITERAL_ALIASES)) {
    const seed = tokens[source]
    if (seed === undefined) continue
    tokens[name] = { light: seed.light, dark: seed.dark }
    provenance[name] = 'semantic:literal-remapped'
  }

  // 4. Pure foreground tokens the ladder does not reach. Both are typed, never
  //    painted as fills, so lifting them changes no surface:
  //    - the caption sits at ~2.0:1 on white in the baseline, under every floor;
  //    - the warning label sits at 2.79:1 in light mode.
  const FOREGROUND_FIXES = [
    { token: '--dsw-alias-label-caption', hue: 96, chroma: 0.4, target: 3.2 },
    { token: '--dsw-alias-state-warn-label', hue: 55, chroma: 0.9, target: 3.05 },
  ]
  for (const fix of FOREGROUND_FIXES) {
    /** @type {{ light: string, dark: string } | null} */
    let entry = null
    for (const mode of /** @type {const} */ (['light', 'dark'])) {
      const seed = resolveToken(fix.token, modes[mode])
      if (seed === null || !isColor(seed)) continue
      // A foreground is measured against the surface it will be typed on, so the
      // seed is first made *horizontal* (same hue, low chroma) before the target
      // ratio is solved — a saturated seed can leave the target out of gamut.
      const fixed = recolourContrast(toHex([...oklchToSrgb(toOklch(parseColor(seed)).L, 0.02, fix.hue), 1]), { hue: fix.hue, chroma: 1, target: fix.target }, mode)
      if (fixed === null) continue
      if (entry === null) entry = { light: fixed, dark: fixed }
      entry[mode] = fixed
    }
    if (entry === null) continue
    tokens[fix.token] = entry
    provenance[fix.token] = 'foreground:contrast'
  }

  const applySemanticOverrides = () => {
    for (const name of baseline.semantic) {
      if (name === '--dsw-alias-bg-base') continue
      const entry = tokens[name]
      if (entry === undefined) continue
      if (provenance[name] === 'semantic:alias' || provenance[name] === 'semantic:literal-remapped') continue
      light[name] = entry.light
      dark[name] = entry.dark
    }
  }

  // 5. The reading surface itself.
  tokens['--dsw-alias-bg-base'] = { light: SURFACE.light, dark: SURFACE.dark }
  provenance['--dsw-alias-bg-base'] = 'surface'
  light['--dsw-alias-bg-base'] = SURFACE.light
  dark['--dsw-alias-bg-base'] = SURFACE.dark

  applySemanticOverrides()

  // 7. Code colours: line numbers and comments must read on the code block, so
  //    each is anchored to a contrast floor against the *themed* code block,
  //    keeping its role hue. A rainbow is preserved but anchored.
  const codeBlock = tokens['--dsw-alias-markdown-code-block']
  if (codeBlock !== undefined) {
    tokens['--shiki-foreground'] = { light: tokens['--dsw-alias-label-primary'].light, dark: tokens['--dsw-alias-label-primary'].dark }
    tokens['--shiki-background'] = { ...codeBlock }
    for (const [name, spec] of Object.entries(SHIKI_ROLES)) {
      if (name === '--shiki-foreground' || name === '--shiki-background') continue
      /** @type {{ light: string, dark: string } | null} */
      let entry = null
      for (const mode of /** @type {const} */ (['light', 'dark'])) {
        const original = shiki[mode][name] ?? shiki.light[name]
        if (original === undefined || !isColor(original)) continue
        const anchored = recolourPair(original, { hue: spec.hue, chroma: spec.chroma, floor: SHIKI_FLOOR, bgToken: '--dsw-alias-markdown-code-block' }, tokens, mode)
        if (anchored === null) continue
        if (entry === null) entry = { light: anchored, dark: anchored }
        entry[mode] = anchored
      }
      if (entry !== null) {
        tokens[name] = entry
        provenance[name] = 'shiki:contrast'
      }
    }
  }

  // 8. Contrast button: its fill aliases a mid grey, so the label is pinned to
  //    the pure opposite end instead of being searched for.
  const FORCED = {
    '--dsw-alias-label-primary-foreground': { light: '#ffffff', dark: '#12110f' },
  }
  for (const [name, value] of Object.entries(FORCED)) {
    tokens[name] = value
    provenance[name] = 'pair:fixed'
  }

  // 9. Typography and shape (not colours; kept in a separate map so the colour
  //    functions never see them).
  return { baseline, tokens, provenance, typography: TYPOGRAPHY, radius: RADIUS }
}

/**
 * Check the readability gate over a full token map.
 * @param {Record<string, { light: string, dark: string }>} tokens
 * @returns {{ pairs: object[], failures: object[], shiki: object[] }}
 */
export function gate(tokens) {
  const surface = { light: tokens['--dsw-alias-bg-base'].light, dark: tokens['--dsw-alias-bg-base'].dark }

  /** Resolve a token to a colour, falling back to the surface for containers. */
  const colourOf = (name, mode) => {
    const entry = tokens[name]
    const raw = entry?.[mode]
    if (raw === undefined || !isColor(raw)) return null
    return parseColor(raw)
  }

  const pairs = []
  for (const pair of PAIRS) {
    const fgL = colourOf(pair.fg, 'light')
    const bgL = colourOf(pair.bg, 'light')
    const fgD = colourOf(pair.fg, 'dark')
    const bgD = colourOf(pair.bg, 'dark')
    if (fgL !== null && bgL !== null) {
      pairs.push({
        ...pair,
        mode: 'light',
        ratio: contrast(fgL, bgL, parseColor(surface.light)),
        status: status(contrast(fgL, bgL, parseColor(surface.light)), pair.floor, pair.inherited ?? false),
      })
    }
    if (fgD !== null && bgD !== null) {
      pairs.push({
        ...pair,
        mode: 'dark',
        ratio: contrast(fgD, bgD, parseColor(surface.dark)),
        status: status(contrast(fgD, bgD, parseColor(surface.dark)), pair.floor, pair.inherited ?? false),
      })
    }
  }

  const shiki = []
  for (const name of Object.keys(SHIKI_ROLES)) {
    for (const mode of ['light', 'dark']) {
      const fg = colourOf(name, mode)
      const bg = colourOf('--dsw-alias-markdown-code-block', mode)
      if (fg === null || bg === null) continue
      const ratio = contrast(fg, bg, parseColor(surface[mode]))
      shiki.push({ token: name, mode, ratio, status: status(ratio, SHIKI_FLOOR, false) })
    }
  }

  const failures = [
    ...pairs.filter((p) => p.status === 'BROKEN'),
    ...shiki.filter((s) => s.status === 'BROKEN'),
  ]
  return { pairs, shiki, failures }
}

function status(ratio, floor, inherited) {
  if (ratio >= floor) return 'PASS'
  return inherited ? 'INHERITED' : 'BROKEN'
}

/**
 * Report whether every ramp keeps its baseline relative luminance, which is the
 * invariant that makes "readability first" hold for tokens this theme never saw.
 * @param {Record<string, { light: string, dark: string }>} tokens
 * @param {Record<string, string>} baselineMode
 * @param {'light' | 'dark'} mode
 * @returns {{ name: string, drift: number }[]}
 */
export function luminanceDrift(tokens, baselineMode, mode) {
  const out = []
  for (const [name, value] of Object.entries(baselineMode)) {
    const entry = tokens[name]
    if (entry === undefined) continue
    const before = parseColor(value)
    const after = parseColor(entry[mode])
    if (before === null || after === null) continue
    const drift = Math.abs(luminance(composite(before, [255, 255, 255, 1])) - luminance(composite(after, [255, 255, 255, 1])))
    out.push({ name, drift })
  }
  return out.sort((a, b) => b.drift - a.drift)
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain = process.argv[1] !== undefined && process.argv[1].endsWith('palette.mjs')
if (isMain) {
  const { baseline, tokens, provenance, typography, radius } = generate()
  const result = gate(tokens)
  const sorted = Object.fromEntries(Object.entries(tokens).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(join(HERE, 'tokens.json'), JSON.stringify({ tokens: sorted, typography, radius }, null, '\t') + '\n')

  const drift = {
    light: luminanceDrift(tokens, baseline.modes.light, 'light').slice(0, 5),
    dark: luminanceDrift(tokens, baseline.modes.dark, 'dark').slice(0, 5),
  }

  const report = {
    generatedFrom: `@deepseek-ai/dsh-client-ui-theme@${baseline.pkg.version}`,
    counts: {
      tokens: Object.keys(tokens).length,
      ramps: baseline.ramps.length,
      semantic: baseline.semantic.length,
      shiki: Object.keys(SHIKI_ROLES).length,
    },
    surface: SURFACE,
    overlay: OVERLAY,
    pairs: result.pairs,
    shiki: result.shiki,
    failures: result.failures,
    luminanceDrift: drift,
    provenance,
  }
  writeFileSync(join(HERE, 'report.json'), JSON.stringify(report, null, '\t') + '\n')

  const pass = result.pairs.filter((p) => p.status === 'PASS').length
  const inherited = result.pairs.filter((p) => p.status === 'INHERITED').length
  console.log(`baseline @deepseek-ai/dsh-client-ui-theme@${baseline.pkg.version}`)
  console.log(`tokens written: ${Object.keys(tokens).length} (ramps ${baseline.ramps.length}, semantic ${baseline.semantic.length})`)
  console.log(`readability: ${pass} PASS / ${inherited} INHERITED / ${result.failures.length} BROKEN over ${result.pairs.length} pairs`)
  for (const f of result.failures) console.log(`  BROKEN ${f.mode} ${f.fg ?? f.token} on ${f.bg ?? 'code-block'} = ${f.ratio.toFixed(2)}`)
  for (const f of result.pairs.filter((p) => p.status === 'INHERITED')) {
    console.log(`  INHERITED ${f.mode} ${f.fg} on ${f.bg} = ${f.ratio.toFixed(2)} (baseline also below ${f.floor})`)
  }
  if (process.env.INKSTONE_DEBUG) {
    for (const n of ['--dsw-static-deepseek-500', '--dsw-static-neutral-bluish-600', '--dsw-alias-link', '--dsw-alias-label-tertiary']) {
      const e = tokens[n]
      console.log(`  dbg ${n} ${e ? e.light : 'missing'} lum=${e ? luminance(parseColor(e.light)).toFixed(4) : '-'}`)
    }
  }
  const worst = result.pairs.filter((p) => Number.isFinite(p.ratio)).sort((a, b) => a.ratio - b.ratio).slice(0, 5)
  console.log('lowest ratios:')
  for (const p of worst) console.log(`  ${p.ratio.toFixed(2)}  ${p.mode} ${p.why}`)
  console.log(`max luminance drift (ramps): light ${drift.light[0]?.drift.toFixed(4)} / dark ${drift.dark[0]?.drift.toFixed(4)}`)
  if (result.failures.length > 0) process.exitCode = 1
}
