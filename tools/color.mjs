/**
 * Colour primitives shared by every script in tools/.
 *
 * One module so that palette.mjs (which generates), check.mjs (which verifies)
 * and the preview renderers cannot disagree about what a colour is. Two rules
 * the whole toolchain depends on:
 *
 *   1. "Is this a colour?" is decided by a tolerant parser, not a hex-only
 *      regex. A hex-only test silently drops any baseline value that upstream
 *      switches to rgb()/oklch() — the palette would quietly shrink while the
 *      report still looked clean.
 *   2. Every parsed colour keeps its alpha. DSW uses alpha heavily for borders
 *      and masks (#0000001a, #ffffff0f); dropping it turns hairlines opaque.
 *
 * Pure functions only: no file system, no DOM. That is what lets check.mjs
 * re-derive the same numbers palette.mjs wrote.
 */

/** Named colours the baseline actually uses, plus the CSS keywords worth having. */
const NAMED = {
  transparent: [0, 0, 0, 0],
  black: [0, 0, 0, 1],
  white: [255, 255, 255, 1],
}

/**
 * Parse a hex colour in #rgb / #rgba / #rrggbb / #rrggbbaa form.
 * @param {string} text
 * @returns {[number, number, number, number] | null} sRGB 0–255 + alpha 0–1, or null.
 */
function parseHex(text) {
  const m = /^#([0-9a-f]{3,8})$/i.exec(text.trim())
  if (m === null) return null
  let hex = m[1]
  if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join('')
  if (hex.length !== 6 && hex.length !== 8) return null
  const n = (i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return [n(0), n(1), n(2), hex.length === 8 ? n(3) / 255 : 1]
}

/**
 * Split the argument list of a functional colour.
 * Handles `a b c / alpha`, `a, b, c, alpha` and `a b c / 20%`, and returns the
 * alpha slot separately so the numeric arguments and the alpha never collide.
 * @param {string} inner
 * @returns {{ values: string[], alpha: string | null }}
 */
function functionalArgs(inner) {
  const slash = inner.indexOf('/')
  if (slash >= 0) {
    return {
      values: inner.slice(0, slash).split(/[\s,]+/).filter((s) => s.length > 0),
      alpha: inner.slice(slash + 1).trim(),
    }
  }
  const parts = inner.split(/[\s,]+/).filter((s) => s.length > 0)
  return parts.length === 4
    ? { values: parts.slice(0, 3), alpha: parts[3] }
    : { values: parts, alpha: null }
}

/**
 * Parse a CSS colour string into sRGB + alpha.
 *
 * Supported: hex (3/4/6/8), rgb()/rgba(), hsl()/hsla(), oklch(), color(srgb …),
 * named transparent/black/white. Returns null for anything else — callers treat
 * null as "not a colour", never as "black".
 *
 * @param {string} text
 * @returns {[number, number, number, number] | null}
 */
export function parseColor(text) {
  if (typeof text !== 'string') return null
  const value = text.trim()
  if (value === '') return null
  const named = NAMED[value.toLowerCase()]
  if (named !== undefined) return [...named]

  const hex = parseHex(value)
  if (hex !== null) return hex

  const fn = /^([a-z]+)\((.*)\)$/i.exec(value)
  if (fn === null) return null
  const name = fn[1].toLowerCase()
  const parsed = functionalArgs(fn[2])
  const args = parsed.values
  const num = (i, fallback) => (i < args.length ? Number.parseFloat(args[i]) : fallback)
  const pct = (i, fallback) => {
    if (i >= args.length) return fallback
    const raw = args[i]
    return raw.endsWith('%') ? Number.parseFloat(raw) / 100 : Number.parseFloat(raw)
  }
  const alphaOf = (fallback) => {
    if (parsed.alpha === null) return fallback
    return parsed.alpha.endsWith('%') ? Number.parseFloat(parsed.alpha) / 100 : Number.parseFloat(parsed.alpha)
  }

  if (name === 'rgb' || name === 'rgba') {
    // Modern syntax may mix percentages; support both, and the / alpha form.
    const rgb = [0, 1, 2].map((i) => {
      const raw = args[i]
      if (raw === undefined) return 0
      return raw.endsWith('%') ? (Number.parseFloat(raw) / 100) * 255 : Number.parseFloat(raw)
    })
    const alpha = alphaOf(1)
    return [clamp(rgb[0], 0, 255), clamp(rgb[1], 0, 255), clamp(rgb[2], 0, 255), clamp(alpha, 0, 1)]
  }

  if (name === 'hsl' || name === 'hsla') {
    const h = num(0, 0)
    const s = pct(1, 0)
    const l = pct(2, 0)
    const alpha = alphaOf(1)
    const [r, g, b] = hslToSrgb(h, s, l)
    return [r, g, b, clamp(alpha, 0, 1)]
  }

  if (name === 'oklch') {
    const L = pct(0, 0)
    const C = num(1, 0)
    const h = num(2, 0)
    const alpha = alphaOf(1)
    const [r, g, b] = oklchToSrgb(L, C, h)
    return [r, g, b, clamp(alpha, 0, 1)]
  }

  if (name === 'color' && args[0] === 'srgb') {
    const rgb = [1, 2, 3].map((i) => pct(i, 0) * 255)
    const alpha = alphaOf(1)
    return [clamp(rgb[0], 0, 255), clamp(rgb[1], 0, 255), clamp(rgb[2], 0, 255), clamp(alpha, 0, 1)]
  }

  return null
}

/**
 * True when the string is a colour this toolchain can reason about.
 * @param {string} text
 * @returns {boolean}
 */
export function isColor(text) {
  return parseColor(text) !== null
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

function hslToSrgb(h, s, l) {
  const hh = ((h % 360) + 360) % 360
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1))
  const m = l - c / 2
  const seg = Math.floor(hh / 60) % 6
  const table = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][seg]
  return table.map((v) => clamp((v + m) * 255, 0, 255))
}

// ---------------------------------------------------------------------------
// sRGB ↔ OKLCH
// ---------------------------------------------------------------------------

function srgbToLinear(c) {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

function linearToSrgb(v) {
  return 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)
}

/** @typedef {{ L: number, C: number, h: number }} Oklch */

/**
 * Convert sRGB (0–255) to OKLCH. Alpha is ignored: geometry lives in hue/lightness.
 * @param {[number, number, number, number]} rgba
 * @returns {Oklch} L 0–1, C 0–~0.4, h 0–360.
 */
export function toOklch(rgba) {
  const [r, g, b] = rgba.slice(0, 3).map(srgbToLinear)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const Lc = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const ac = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bc = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  const C = Math.sqrt(ac * ac + bc * bc)
  const h = ((Math.atan2(bc, ac) * 180) / Math.PI + 360) % 360
  return { L: Lc, C, h }
}

const inGamut = (v) => v >= -0.0005 && v <= 1.0005

/**
 * Convert OKLCH back to sRGB. Out-of-gamut requests reduce chroma until the
 * colour fits, preserving lightness and hue — the same rule palette.mjs
 * documents, so generated values are always representable.
 * @param {number} L 0–1
 * @param {number} C
 * @param {number} hDeg
 * @returns {[number, number, number]} sRGB 0–255.
 */
export function oklchToSrgb(L, C, hDeg) {
  let c = Math.max(0, C)
  const h = (hDeg * Math.PI) / 180
  for (let i = 0; i < 64; i++) {
    const ac = c * Math.cos(h)
    const bc = c * Math.sin(h)
    const l = (L + 0.3963377774 * ac + 0.2158037573 * bc) ** 3
    const m = (L - 0.1055613458 * ac - 0.0638541728 * bc) ** 3
    const s = (L - 0.0894841775 * ac - 1.291485548 * bc) ** 3
    const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    const b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
    if (inGamut(r) && inGamut(g) && inGamut(b)) {
      return [clamp(linearToSrgb(r), 0, 255), clamp(linearToSrgb(g), 0, 255), clamp(linearToSrgb(b), 0, 255)]
    }
    c = c <= 1e-4 ? 0 : c * 0.96
  }
  // Fully desaturated: the grey at this lightness is always in gamut.
  const v = linearToSrgb(L)
  return [clamp(v, 0, 255), clamp(v, 0, 255), clamp(v, 0, 255)]
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Serialise sRGB + alpha to the shortest hex the browser accepts.
 * @param {[number, number, number, number]} rgba
 * @returns {string}
 */
export function toHex(rgba) {
  const [r, g, b, a = 1] = rgba
  const hx = (v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')
  const base = `#${hx(r)}${hx(g)}${hx(b)}`
  return a >= 1 ? base : base + hx(a * 255)
}

/**
 * Flatten a translucent colour over an opaque backdrop (source-over).
 * @param {[number, number, number, number]} fg
 * @param {[number, number, number, number]} bg Must be opaque for a meaningful result.
 * @returns {[number, number, number, number]}
 */
export function composite(fg, bg) {
  const a = fg[3] ?? 1
  return [
    fg[0] * a + bg[0] * (1 - a),
    fg[1] * a + bg[1] * (1 - a),
    fg[2] * a + bg[2] * (1 - a),
    1,
  ]
}

// ---------------------------------------------------------------------------
// WCAG contrast
// ---------------------------------------------------------------------------

/**
 * WCAG 2.x relative luminance of an opaque sRGB colour.
 * @param {[number, number, number, number]} rgba
 * @returns {number} 0–1
 */
export function luminance(rgba) {
  const [r, g, b] = rgba.slice(0, 3).map((c) => srgbToLinear(c))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * WCAG contrast ratio between two colours. Translucent foregrounds are first
 * flattened over `backdrop` (default: the backdrop argument itself when opaque),
 * because a ratio against an invisible backdrop measures nothing.
 *
 * @param {[number, number, number, number]} fg
 * @param {[number, number, number, number]} bg
 * @param {[number, number, number, number] | null} [backdrop] What shows through `bg`'s alpha.
 * @returns {number}
 */
export function contrast(fg, bg, backdrop = null) {
  const back = backdrop === null ? bg : composite(bg, backdrop)
  const fop = composite(fg, back)
  const l1 = luminance(fop)
  const l2 = luminance(back)
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Apply a hue shift and chroma multiplier in OKLCH while preserving lightness,
 * which is the core operation of this theme: colours move, readability does not.
 *
 * @param {string} value Colour in any supported syntax.
 * @param {{ hue?: number, chroma?: number, lightDelta?: number }} opts
 * @returns {string} Hex in the same alpha as the input.
 */
export function remap(value, opts) {
  const rgba = parseColor(value)
  if (rgba === null) return value
  const { L, C, h } = toOklch(rgba)
  const hue = opts.hue ?? h
  const chroma = C * (opts.chroma ?? 1)
  const light = clamp(L + (opts.lightDelta ?? 0), 0, 1)
  const [r, g, b] = oklchToSrgb(light, chroma, hue)
  return toHex([r, g, b, rgba[3]])
}
