/**
 * Inkstone palette generator.
 *
 * Reads the authoritative baseline palette straight out of the installed
 * dsh-client-ui-theme bundle (design_platform.css is inlined there as a JS
 * string), remaps the raw --dsw-static-* ramps in OKLCH while preserving
 * perceptual lightness, re-derives every declared token through the real CSS
 * var() chain (including alias-to-alias references), and verifies contrast on
 * the final, resolved colours.
 *
 * Two properties of the baseline drive the design:
 *
 *   1. The raw --dsw-static-* ladder is SHARED between the light and dark
 *      palettes — only the alias layer changes which end of the ladder it
 *      points at. So the neutral ladder must stay mode-invariant here too, or
 *      it stops being one ladder.
 *   2. The alias layer is where mode-specific meaning lives, so accent colours
 *      need opposite corrections per mode: darker against the light palette,
 *      lighter against the dark one.
 *
 * Output: tokens.json (the map handed to ctx.theme.overrideTokens), ramps.json
 * (resolved palettes for the preview), report.json (the verification record),
 * and a contrast report on stdout.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readBaseline } from './dsh-baseline.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------- sRGB / OKLCH

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)

function hexToRgb(hex) {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  if (h.length === 8) h = h.slice(0, 6) // drop alpha; the ramps are opaque
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
}
const rgbToHex = ([r, g, b]) =>
  '#' + [r, g, b].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')

function rgbToOklab([r, g, b]) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b)
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}
function oklabToRgb([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(linearToSrgb)
}
const inGamut = (rgb) => rgb.every((v) => v >= -0.0005 && v <= 1.0005)
const rgbToOklch = (rgb) => {
  const [L, a, b] = rgbToOklab(rgb)
  return { L, C: Math.hypot(a, b), h: (Math.atan2(b, a) * 180) / Math.PI }
}
/** Re-emit in OKLCH, shrinking chroma until the result fits sRGB. */
function oklchToHex(L, C, hDeg) {
  let c = C
  for (let i = 0; i < 40; i++) {
    const rad = (hDeg * Math.PI) / 180
    const rgb = oklabToRgb([L, c * Math.cos(rad), c * Math.sin(rad)])
    if (inGamut(rgb)) return { hex: rgbToHex(rgb), clipped: i > 0 }
    c *= 0.97
  }
  const rad = (hDeg * Math.PI) / 180
  return { hex: rgbToHex(oklabToRgb([L, c * Math.cos(rad), c * Math.sin(rad)])), clipped: true }
}

// --------------------------------------------------------- WCAG contrast ratio

const relLuminance = (hex) => {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a, b) => {
  const [x, y] = [relLuminance(a), relLuminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

// -------------------------------------------------- baseline: parse the bundle

const { staticsLight, staticsDark, declLight, declDark, bundlePath } = readBaseline(
  process.argv[2] === undefined ? undefined : process.argv[2],
)

// ------------------------------------------------------------ the remap policy

/**
 * Only the neutral and accent families move. Semantic state hues (amber /
 * green / red) keep their meaning and stay at baseline: re-hueing "warning"
 * is not theming, it is miscommunication.
 *
 * The chroma curve tapers at both ends so pure white stays clean and the
 * darkest surfaces stay near-black, while the mid range carries the mineral
 * cast that makes the palette read as a palette.
 */
const chromaCurve = (L) => 0.019 * Math.sin(Math.PI * Math.min(1, Math.max(0, L))) ** 0.8

const FAMILIES = {
  'neutral-bluish': { hue: 168, chroma: (L) => chromaCurve(L) },
  neutral: { hue: 168, chroma: (L) => chromaCurve(L) * 0.8 },
  deepseek: { hue: 178, chroma: (L, base) => base * 0.94, tilted: true },
  blue: { hue: 198, chroma: (L, base) => base * 0.88, tilted: true },
}

/** See the header: accents need opposite corrections per mode. */
const ACCENT_TILT = { light: -0.075, dark: +0.02 }
const tiltL = (L, delta) => Math.min(1, Math.max(0, L + delta * Math.sin(Math.PI * Math.min(1, Math.max(0, L))) ** 0.7))

function familyOf(name) {
  if (!name.startsWith('--dsw-static-')) return null
  const rest = name.slice('--dsw-static-'.length)
  if (rest.startsWith('neutral-bluish-')) return 'neutral-bluish'
  if (rest.startsWith('neutral-')) return 'neutral'
  if (rest.startsWith('deepseek-')) return 'deepseek'
  if (rest.startsWith('blue-')) return 'blue'
  return null
}

const remapLog = []
function remapStatics(statics, mode) {
  const out = {}
  for (const [name, value] of Object.entries(statics)) {
    const family = familyOf(name)
    if (family === null || !value.startsWith('#')) { out[name] = value; continue }
    const base = rgbToOklch(hexToRgb(value))
    const policy = FAMILIES[family]
    const L = policy.tilted ? tiltL(base.L, ACCENT_TILT[mode]) : base.L
    const { hex, clipped } = oklchToHex(L, policy.chroma(L, base.C), policy.hue)
    out[name] = hex
    remapLog.push({ name, mode, from: value, to: hex, L: base.L, Lnew: L, clipped })
  }
  return out
}

const nextLight = remapStatics(staticsLight, 'light')
const nextDark = remapStatics(staticsDark, 'dark')

// -------------------------------------------------- semantic layer resolution

/**
 * Resolve a declared token to a concrete colour: chase var() through statics
 * and through other declared tokens, with a cycle guard. Tokens that do not
 * resolve to a colour (fonts, shadows, gradients) come back verbatim and are
 * left alone.
 */
function makeResolver(statics, decls) {
  const cache = new Map()
  const resolve = (name, seen) => {
    if (cache.has(name)) return cache.get(name)
    if (seen.has(name)) throw new Error('var() cycle at ' + name)
    const raw = decls[name]
    if (raw === undefined) return undefined
    seen.add(name)
    let value = raw
    const whole = /^var\(\s*(--dsw-[a-z0-9-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(raw.trim())
    if (whole !== null) {
      const [, ref, fallback] = whole
      const inner = statics[ref] !== undefined ? statics[ref] : resolve(ref, seen)
      if (inner !== undefined) value = inner
      else if (fallback !== undefined) value = fallback.trim()
      else value = raw
    }
    seen.delete(name)
    cache.set(name, value)
    return value
  }
  return (name) => {
    const v = resolve(name, new Set())
    return v === undefined ? undefined : (v.startsWith('#') || v.includes('(') ? v : v)
  }
}

const baseResolveLight = makeResolver(staticsLight, declLight)
const baseResolveDark = makeResolver(staticsDark, declDark)
const nextResolveLight = makeResolver(nextLight, declLight)
const nextResolveDark = makeResolver(nextDark, declDark)

/** Every non-static token the theme stylesheet declares, resolved per mode. */
function resolveSemantic(statics, decls, resolve) {
  const out = {}
  for (const name of Object.keys(decls)) {
    if (name.startsWith('--dsw-static-')) continue
    out[name] = resolve(name)
  }
  return out
}
const baseSemanticLight = resolveSemantic(staticsLight, declLight, baseResolveLight)
const baseSemanticDark = resolveSemantic(staticsDark, declDark, baseResolveDark)
const nextSemanticLight = resolveSemantic(nextLight, declLight, nextResolveLight)
const nextSemanticDark = resolveSemantic(nextDark, declDark, nextResolveDark)

const isColor = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v.trim())

// ------------------------------------------------------- contrast verification

/** Readability pairs that must not regress. `min` is a floor, not a target. */
const PAIRS = [
  ['label-primary', 'bg-base', 4.5, 'body text on the app background'],
  ['label-primary', 'bg-layer-2', 4.5, 'body text on a raised panel'],
  ['label-primary', 'specific-bubble', 4.5, 'body text inside a reply bubble'],
  ['label-secondary', 'bg-base', 4.5, 'secondary text on the app background'],
  ['label-tertiary', 'bg-base', 3.0, 'tertiary text on the app background'],
  ['label-caption', 'bg-base', 3.0, 'captions / timestamps'],
  ['label-primary-foreground', 'brand-primary', 4.5, 'text on a primary button'],
  ['label-primary-foreground', 'button-info-fill', 4.5, 'text on an accent button'],
  ['link', 'bg-base', 4.5, 'links'],
  ['state-warn-label', 'bg-base', 3.0, 'warning text'],
  ['state-error-primary', 'bg-base', 3.0, 'error text'],
  ['state-success-primary', 'bg-base', 3.0, 'success text'],
  ['state-business-primary', 'bg-base', 4.5, 'accent / business text'],
  ['label-secondary', 'specific-sidebar-fill', 4.5, 'sidebar navigation text'],
]

const tokenName = (short) => (short.startsWith('specific-') ? '--dsw-' + short : '--dsw-alias-' + short)

/**
 * A pair is judged on two axes, because the baseline is not a clean control:
 * some pairs already sit below any reasonable floor in the shipped theme.
 * Those are recorded as inherited. What this theme must not do is push a pair
 * that passed into failing.
 */
function report(mode, baseline, next) {
  const rows = []
  for (const [fg, bg, min, why] of PAIRS) {
    const bf = baseline[tokenName(fg)], bb = baseline[tokenName(bg)]
    const nf = next[tokenName(fg)], nb = next[tokenName(bg)]
    if (!isColor(bf) || !isColor(bb) || !isColor(nf) || !isColor(nb)) {
      rows.push({ mode, fg, bg, why, skipped: true })
      continue
    }
    const before = contrast(bf, bb)
    const after = contrast(nf, nb)
    rows.push({
      mode, fg, bg, why, before, after, min,
      state: after >= min ? 'pass' : before >= min ? 'BROKEN' : 'inherited',
      drop: before - after,
    })
  }
  return rows
}

const rows = [
  ...report('light', baseSemanticLight, nextSemanticLight),
  ...report('dark', baseSemanticDark, nextSemanticDark),
]

// The shared neutral ladder must stay shared.
const NEUTRAL_DIVERGENCE_ALLOWED = new Set(['--dsw-static-neutral-bluish-60'])
const divergence = Object.keys(nextLight).filter((name) => {
  const family = familyOf(name)
  return family !== null && !FAMILIES[family].tilted &&
    nextLight[name] !== nextDark[name] && !NEUTRAL_DIVERGENCE_ALLOWED.has(name)
})
if (divergence.length > 0) throw new Error('shared neutral ladder diverged: ' + divergence.join(', '))

// ------------------------------------------------------------------- emission

/**
 * Two layers go out, on purpose:
 *
 *   - the raw static ramps, which make the theme independent of how many
 *     semantic tokens a given DSH build declares (anything derived from the
 *     ladder follows for free);
 *   - every semantic token whose resolved colour actually changed, so the
 *     palette is stated explicitly rather than left to a var() chain.
 *
 * Tokens the design system never declares are deliberately NOT invented here.
 */
const tokens = {}
for (const [name, value] of Object.entries(nextLight)) {
  if (familyOf(name) === null) continue
  if (value === staticsLight[name]) continue
  tokens[name] = { light: value, dark: nextDark[name] }
}
const semanticEmitted = []
for (const name of new Set([...Object.keys(declLight), ...Object.keys(declDark)])) {
  if (name.startsWith('--dsw-static-')) continue
  const l = nextSemanticLight[name] ?? nextSemanticDark[name]
  const d = nextSemanticDark[name] ?? nextSemanticLight[name]
  const bl = baseSemanticLight[name] ?? baseSemanticDark[name]
  const bd = baseSemanticDark[name] ?? baseSemanticLight[name]
  if (!isColor(l) || !isColor(d)) continue          // fonts, shadows, gradients
  if (l === bl && d === bd) continue                 // unchanged by the remap
  tokens[name] = { light: l, dark: d }
  semanticEmitted.push(name)
}

writeFileSync(join(HERE, 'tokens.json'), JSON.stringify(tokens, null, 2) + '\n')
writeFileSync(join(HERE, 'ramps.json'), JSON.stringify({
  light: nextLight,
  dark: nextDark,
  aliasLight: nextSemanticLight,
  aliasDark: nextSemanticDark,
}, null, 2) + '\n')

// -------------------------------------------------- the surface that is consumed

/**
 * A theme is only as complete as the tokens components actually read, and that
 * set is larger than the one the theme stylesheet declares: component packages
 * own part of it. Scanning the installed bundles gives an honest coverage
 * number instead of an assumed one.
 */
const AI_ROOT = bundlePath.replace(/\\/g, '/').split('/').slice(0, -3).join('/')

function walkClientBundles(dir, out = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const entry of entries) {
    const p = join(dir, entry)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walkClientBundles(p, out)
    else if (p.endsWith('client.js')) out.push(p)
  }
  return out
}

const consumed = new Set()
for (const file of walkClientBundles(AI_ROOT)) {
  const text = readFileSync(file, 'utf8')
  for (const m of text.matchAll(/var\(\s*(--dsw-[a-z0-9-]+)/g)) consumed.add(m[1])
}

/**
 * Three buckets, because "not recoloured" hides three different situations:
 * token the theme changes; token the theme leaves alone because it carries no
 * colour (typography, elevation, shadows, masks, corner radius — declared by
 * the theme package's other stylesheets); and token the design system never
 * declares at all, which the README says themes must not invent values for.
 *
 * `allDeclared` is scanned from every stylesheet in the theme package, not just
 * design_platform.css, so the middle bucket is not mistaken for the last one.
 */
const allDeclared = new Set(
  [...readFileSync(bundlePath, 'utf8').matchAll(/(--dsw-[a-z0-9-]+)\s*:/g)].map((m) => m[1]),
)
const changedSet = new Set(Object.keys(tokens))
const buckets = { recoloured: [], nonColour: [], omitted: [] }
for (const name of [...consumed].sort()) {
  if (changedSet.has(name)) buckets.recoloured.push(name)
  else if (allDeclared.has(name)) buckets.nonColour.push(name)
  else buckets.omitted.push(name)
}

// ------------------------------------------------------------------- reporting

const clipped = remapLog.filter((r) => r.clipped)
console.log(`ramp members remapped: ${remapLog.length / 2} per mode (${clipped.length} instances needed a chroma reduction to stay in sRGB)`)
console.log(`semantic tokens re-derived: ${Object.keys(declLight).length - Object.keys(staticsLight).length} per mode`)
console.log(`override map: ${Object.keys(tokens).length} tokens (${Object.keys(tokens).length - semanticEmitted.length} ramps + ${semanticEmitted.length} semantic)`)
console.log('')
console.log(`consumed in the installed bundles: ${consumed.size} tokens`)
console.log(`  recoloured by this theme:        ${buckets.recoloured.length}`)
console.log(`  left alone, carry no colour:     ${buckets.nonColour.length} (typography, elevation, shadows, masks, radius)`)
console.log(`  left alone, never declared:      ${buckets.omitted.length} (the design system omits these on purpose)`)
console.log('')
const ramp = (statics, prefix) => Object.entries(statics)
  .filter(([k]) => k.startsWith('--dsw-static-' + prefix))
  .sort(([a], [b]) => Number(a.split('-').pop().replace(/\D/g, '')) - Number(b.split('-').pop().replace(/\D/g, '')))
  .map(([, v]) => v).join(' ')
console.log('stone ladder (shared)  : ' + ramp(nextLight, 'neutral-bluish-'))
console.log('jade  ladder (light)   : ' + ramp(nextLight, 'deepseek-'))
console.log('jade  ladder (dark)    : ' + ramp(nextDark, 'deepseek-'))
console.log('')
console.log('CONTRAST (baseline -> inkstone)')
for (const r of rows.filter((x) => !x.skipped)) {
  const tag = r.state === 'pass' ? '' : r.state === 'inherited' ? '  [below floor at baseline too]' : '  <<< BROKEN'
  const lower = r.state === 'pass' && r.drop > 0.15 ? '  (lower)' : ''
  console.log(`  ${r.mode.padEnd(5)} ${(r.fg + ' on ' + r.bg).padEnd(38)} ${r.before.toFixed(2).padStart(6)} -> ${r.after.toFixed(2).padStart(6)}  min ${r.min}${tag}${lower}`)
}
const broken = rows.filter((r) => r.state === 'BROKEN')
const inherited = rows.filter((r) => r.state === 'inherited')
console.log('')
console.log(broken.length === 0
  ? `no pair was pushed below its floor (${inherited.length} pair(s) were already below it in the baseline)`
  : `${broken.length} PAIR(S) BROKEN BY THIS THEME`)

writeFileSync(join(HERE, 'report.json'), JSON.stringify({
  generatedFrom: bundlePath,
  palette: {
    overrideTokens: Object.keys(tokens).length,
    ramps: Object.keys(tokens).length - semanticEmitted.length,
    semantic: semanticEmitted.length,
    chromaReductions: clipped.length,
  },
  coverage: {
    consumed: consumed.size,
    recoloured: buckets.recoloured.length,
    untouchedNonColour: buckets.nonColour,
    untouchedOmitted: buckets.omitted,
  },
  contrast: rows.filter((r) => !r.skipped).map((r) => ({
    mode: r.mode, pair: `${r.fg} on ${r.bg}`, why: r.why,
    before: Number(r.before.toFixed(2)), after: Number(r.after.toFixed(2)),
    min: r.min, state: r.state,
  })),
}, null, 2) + '\n')
