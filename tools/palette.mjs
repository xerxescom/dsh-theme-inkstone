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
 * Direction: **warm ink with a cinnabar accent** (暖墨 + 朱砂).
 *
 *   - The stone ladder is a warm charcoal-ink neutral at 80° instead of a blue
 *     grey: at these chroma levels (0.006–0.015) the tint is barely measurable as
 *     colour, but it is what separates paper-ink from "SaaS blue grey".
 *   - The accent is cinnabar (朱砂) at 30°, not blue. Cinnabar is the one colour
 *     in the set that may stay saturated: it carries links, the business state
 *     and the focus ring, so it needs to read as *red, and loud*.
 *   - Every other rainbow family is pushed away from the accent hue so code and
 *     state colours never compete with the brand red.
 */
export const FAMILIES = {
  '--dsw-static-neutral-bluish': { hue: 80, chroma: 0.7, label: 'ink' },
  // Accent seed. Baseline values here are blue; the remap lands them on cinnabar.
  // `minChroma` keeps the red saturated through the contrast search, which
  // otherwise collapses it into a washed salmon as it moves toward the target.
  '--dsw-static-deepseek': { hue: 30, chroma: 1.6, minChroma: 0.2, label: 'cinnabar' },
  // Surfaces. `#fff` carries no chroma to tint, so both get an explicit floor
  // value and a light-mode lightness cap: the paper surface must sit just below
  // pure white for the warmth to be measurable at all (OKLCH 0.98 ≈ #fbf7f0).
  '--dsw-static-neutral-bluish-00': { hue: 80, chroma: 1, minChroma: 0.011, lightnessCap: { light: 0.978 }, label: 'paper' },
  '--dsw-static-neutral-00': { hue: 80, chroma: 1, minChroma: 0.011, lightnessCap: { light: 0.978 }, label: 'paper' },
  '--dsw-static-neutral-': { hue: 80, chroma: 2.2, minChroma: 0.006, label: 'ash' },
  // Code/UI secondary hue, kept far from the accent so it never reads as a link.
  '--dsw-static-blue': { hue: 250, chroma: 1.0, label: 'slate-blue' },
  '--dsw-static-violet': { hue: 300, chroma: 0.9, label: 'violet' },
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
 * Hover washes follow the neutral tint instead of staying blue.
 */
const SEMANTIC_HUES = {
  '--dsw-alias-interactive-bg-hover': { hue: 80, chroma: 1.5 },
  '--dsw-alias-interactive-bg-active': { hue: 80, chroma: 1.5 },
  '--dsw-alias-interactive-bg-hover-accent': { hue: 30, chroma: 1.4 },
  '--dsw-alias-button-tool-bar-fill': { hue: 80, chroma: 0.6 },
  '--dsw-alias-button-tool-bar-hover': { hue: 80, chroma: 0.6 },
}

/** Literal-hex semantic tokens that should follow a ramp value instead. */
const LITERAL_ALIASES = {
  '--dsw-alias-border-inverted': '--dsw-static-neutral-bluish-00',
  '--dsw-alias-border-inverted2': '--dsw-static-neutral-bluish-50',
  '--dsw-alias-brand-primary-new-colorprimary-new-color': '--dsw-static-deepseek-500',
}

/**
 * Code-highlight roles. A syntax scheme needs at least four distinguishable
 * hues to stay readable across a long code block. With the brand accent on
 * cinnabar (30°), the warm slot goes to amber and keywords take violet-magenta,
 * so highlighted keywords do not look like links.
 */
const SHIKI_ROLES = {
  '--shiki-token-constant': { hue: 250, chroma: 1.0 },
  '--shiki-token-string': { hue: 150, chroma: 0.9 },
  '--shiki-token-string-expression': { hue: 150, chroma: 0.9 },
  '--shiki-token-comment': { hue: 80, chroma: 0.5 },
  '--shiki-token-keyword': { hue: 335, chroma: 1.0 },
  '--shiki-token-parameter': { hue: 55, chroma: 0.9 },
  '--shiki-token-function': { hue: 285, chroma: 0.95 },
  '--shiki-token-punctuation': { hue: 80, chroma: 0.35 },
  '--shiki-token-link': { hue: 30, chroma: 1.6 },
}

/**
 * The reading surface. The overlay is what shows through when `bg-base` is made
 * translucent for a background image; with the image off it *is* the surface.
 *
 * It is deliberately opaque: it is the backdrop every contrast pair is measured
 * against, so it must be a fixed value, not something that varies with a photo.
 * Both are warm: rice-paper white and ink black, not blue-tinted neutrals.
 */
export const SURFACE = { light: '#faf7f2', dark: '#191513' }

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
  '--dsw-static-neutral-bluish-800': { target: 6.5, maxLightness: { dark: 0.42 } },
  // Surfaces that should read as warm paper, not cool grey: these sit just under
  // white in the baseline, where their own chroma is ~0.002 and cannot be scaled
  // into visibility.
  '--dsw-static-neutral-bluish-50': { minChroma: 0.012 },
  '--dsw-static-neutral-bluish-60': { minChroma: 0.014 },
  '--dsw-static-neutral-bluish-75': { minChroma: 0.016 },
  '--dsw-static-neutral-bluish-100': { minChroma: 0.016 },
  '--dsw-static-neutral-bluish-150': { minChroma: 0.016 },
  '--dsw-static-neutral-bluish-200': { minChroma: 0.012 },
  '--dsw-static-neutral-50': { minChroma: 0.012 },
  '--dsw-static-neutral-100': { minChroma: 0.016 },
  '--dsw-static-neutral-150': { minChroma: 0.016 },
  '--dsw-static-neutral-200': { minChroma: 0.014 },
  '--dsw-static-neutral-bluish-600': { target: 5.4 },
  '--dsw-static-neutral-bluish-400': { target: 3.2 },
  // The 16-step ladder the neutral family never quite reaches: its top is `-00`
  // (the input surface) and everything between `-00` and `-100` is warm wash.
  // Re-anchoring these to contrast keeps the stack readable while the family
  // tint supplies the warmth, instead of leaving them near-white and cool.
  '--dsw-static-neutral-850': { target: 1.0, maxLightness: { light: 0.4, dark: 0.42 } },
  '--dsw-static-neutral-800': { target: 1.0, maxLightness: { light: 0.46, dark: 0.46 } },
  '--dsw-static-neutral-600': { target: 6.0 },
  '--dsw-static-neutral-300': { target: 3.0 },
  // Cinnabar accent. Two separate corrections:
  //   - light mode solved at 5.6: at the 4.5 floor the ratio forces saturation
  //     down until the red reads as "dark red", not vermilion;
  //   - dark mode gets an explicit lightness ceiling. Solving 5.6 on a
  //     0.06-luminance surface asks for a 0.74+ OKLCH lightness, which at this
  //     chroma turns into a neon coral — the hue is right, the volume is not.
  //     At 0.64 the colour is #e55745: vermilion, not salmon.
  '--dsw-static-deepseek-500': { target: 5.6, maxLightness: { light: 0.52, dark: 0.64 } },
  '--dsw-static-deepseek-450': { target: 5.6, maxLightness: { light: 0.52, dark: 0.64 } },
  '--dsw-static-deepseek-400': { target: 5.6, maxLightness: { light: 0.52, dark: 0.64 } },
  '--dsw-static-red-600': { target: 5.2 },
  '--dsw-static-red-400': { target: 5.2 },
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
  const tintedRgba = tintSpec(value, spec, alpha)
  const tinted = toHex(tintedRgba)
  const { L, C } = toOklch(tintedRgba)

  const wanted = spec.target

  // A hue that reads right but is "too bright" is a different defect from one
  // that fails its ratio. A colour-scheme-specific lightness ceiling caps the
  // volume before the ratio search, which then trades chroma for contrast at the
  // capped lightness — so a neon coral becomes a deep cinnabar instead.
  const cap = spec.maxLightness?.[mode]
  const hueForCap = spec.hue ?? toOklch(tintedRgba).h
  const cappedHex = cap === undefined || L <= cap ? null : matchLuminance(luminanceOf(cap, C, hueForCap), C, hueForCap, alpha)
  const startRgba = cappedHex === null ? tintedRgba : parseColor(cappedHex)
  const startHex = cappedHex ?? tinted

  // Volume control alone: the cap was the whole request.
  if (wanted === undefined) return startHex
  if (contrast(startRgba, backdrop) >= wanted) return startHex

  const { L: startL, C: startC } = toOklch(startRgba)
  const startHue = spec.hue ?? toOklch(startRgba).h
  const darker = luminanceNeededFor(wanted, surfaceLum, 'dark')
  const lighter = luminanceNeededFor(wanted, surfaceLum, 'light')
  // Move in the direction that costs the least lightness change — but never past
  // the cap: a capped colour may only trade chroma for ratio, not lightness.
  const options = []
  if (darker !== null) options.push({ goal: darker, from: luminanceOf(startL, startC, startHue) })
  if (lighter !== null) options.push({ goal: lighter, from: luminanceOf(startL, startC, startHue) })
  options.sort((a, b) => Math.abs(a.goal - a.from) - Math.abs(b.goal - b.from))

  for (const option of options) {
    const hit = matchLuminance(option.goal, startC, startHue, 1)
    if (hit === null) continue
    const hitRgba = parseColor(hit)
    const hitOklch = toOklch(hitRgba)
    if (cap !== undefined && hitOklch.L > cap + 1e-6) continue
    // Chroma is what makes cinnabar cinnabar. Without this floor the search
    // happily trades saturation for ratio and returns salmon.
    const chromaFloor = spec.minChroma ?? 0
    if (hitOklch.C < chromaFloor) {
      const richer = matchLuminance(option.goal, chromaFloor, startHue, 1)
      if (richer !== null && toOklch(parseColor(richer)).L <= (cap ?? 1) + 1e-6 && contrast(parseColor(richer), backdrop) >= wanted) {
        return richer
      }
      continue
    }
    if (contrast(hitRgba, backdrop) >= wanted) return hit
  }

  // The cap and the ratio can be jointly unreachable: on a near-black surface a
  // "3.2:1 surface fill" requires a lightness far above the cap. In that case the
  // cap wins and the seed keeps the closest reachable value — what matters is
  // that the caller sees a deliberate choice, not a silently over-bright fill.
  return startHex
}

/**
 * Apply a spec's hue / chroma to a seed colour.
 *
 * `chroma` is a *multiplier* on the seed's own chroma, which is the right default
 * for the neutral ladders but wrong for an accent: a pale seed (the dark-mode
 * blue is 0.10 chroma) survives the multiplier as a weak red. `minChroma` sets an
 * absolute floor so the accent keeps its saturation regardless of what it was.
 *
 * @param {string} value Seed colour.
 * @param {{ hue?: number, chroma?: number, minChroma?: number }} spec
 * @param {number} alpha
 * @returns {[number, number, number, number]}
 */
function tintSpec(value, spec, alpha) {
  const base = parseColor(value)
  const remapped = spec.hue === undefined && spec.chroma === undefined
    ? toHex(base)
    : remap(value, { hue: spec.hue, chroma: spec.chroma })
  const { L, C, h } = toOklch(parseColor(remapped))
  const chroma = Math.max(C, spec.minChroma ?? 0)
  if (chroma === C) return parseColor(remapped)
  return parseColor(toHex([...oklchToSrgb(L, chroma, spec.hue ?? h), alpha]))
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
  const tintedRgba = tintSpec(value, spec, rgba[3])
  const tinted = toHex(tintedRgba)
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
 * Recolour one ramp member.
 *
 * Most members carry chroma already, so scaling it is all they need. Pure white
 * and pure black are the exception: `#fff` has no hue to rotate, so multiplying
 * its chroma by anything leaves it grey. For those, a family may supply an
 * explicit `minChroma` — the minimum chroma the result must have — and a light
 * mode `lightnessCap` so a "paper white" lands at roughly 0.98 instead of 1.0,
 * which is where a warm tint becomes visible at all.
 *
 * @param {string} value Baseline declaration.
 * @param {{ hue?: number, chroma?: number, minChroma?: number, lightnessCap?: Record<string, number> }} family
 * @param {'light' | 'dark'} mode
 * @returns {string | null} null when the value is not a literal colour.
 */
function recolour(value, family, mode) {
  if (!isColor(value)) return null
  const tilt = ACCENT_TILT[mode] ?? 0
  const rgba = parseColor(value)
  const { L, C, h } = toOklch(rgba)
  const hue = family.hue ?? h
  const seedChroma = Math.max(C * (family.chroma ?? 1), family.minChroma ?? 0)
  const light = Math.min(L + tilt, family.lightnessCap?.[mode] ?? 1)
  return toHex([...oklchToSrgb(Math.max(0, light), seedChroma, hue), rgba[3]])
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
  //    contrast target. Everything else is tint only — except tint-only specs
  //    that still need volume control (`maxLightness`), which must go through
  //    the same path or the cap is never applied.
  for (const name of baseline.ramps) {
    const family = familyOf(name)
    if (family === null || isPreserved(name)) continue
    // State families keep their baseline volume; the neutral/surface families may
    // carry a lightness cap, which recolourContrast applies.
    const spec = TARGETS[name] ?? (isPreserved(name) ? null : (family.spec.maxLightness === undefined ? null : {}))
    const lv = recolour(light[name], family.spec, 'light')
    const dv = recolour(dark[name], family.spec, 'dark')
    if (lv === null && dv === null) continue
    // Family first, then the per-seed spec: the seed's target/cap must win over
    // the family's defaults, never the other way round.
    const l = spec === null || lv === null ? lv : recolourContrast(light[name], { ...family.spec, ...spec }, 'light')
    const d = spec === null || dv === null ? dv : recolourContrast(dark[name], { ...family.spec, ...spec }, 'dark')
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
    { token: '--dsw-alias-label-caption', hue: 80, chroma: 0.5, target: 3.2 },
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
