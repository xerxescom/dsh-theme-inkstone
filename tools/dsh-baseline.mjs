/**
 * Locates the installed DSH theme bundle and parses the two palettes out of it.
 *
 * `design_platform.css` is inlined into `dsh-client-ui-theme`'s client bundle
 * as a JavaScript string, and it is the only authoritative source for the
 * baseline palette: the token values a theme has to remap, and the var() chains
 * that connect the semantic layer to the raw ramps. Both the palette generator
 * and the artifact checker read it through here so the parsing rules live in
 * one place.
 */
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const THEME_PACKAGE = '@deepseek-ai/dsh-client-ui-theme'

/**
 * Find the installed theme package. Resolution order matters: the copy the
 * running profile actually loads is the one a theme must agree with, so module
 * resolution wins over any hard-coded global-install path.
 *
 * @returns absolute path to the theme package's client bundle.
 */
export function findThemeBundle() {
  try {
    const require = createRequire(import.meta.url)
    const manifest = require.resolve(`${THEME_PACKAGE}/package.json`)
    return join(dirname(manifest), 'lib', 'client.js')
  } catch { /* fall through to the configured install */ }

  const candidates = [
    process.env.DSH_THEME_BUNDLE,
    process.env.APPDATA && join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'),
    process.env.DSH_HOME && join(process.env.DSH_HOME, 'profiles/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'),
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    `cannot locate ${THEME_PACKAGE} — install it, or point DSH_THEME_BUNDLE at its lib/client.js`,
  )
}

/** The CSS variable name pattern both palettes are written in. */
const DECLARATION = /(--dsw-[a-z0-9-]+)\s*:\s*([^;]+)/g

/**
 * Read and split the baseline stylesheet.
 *
 * The sheet is four brace-blocks in a fixed order: the raw static palette and
 * the semantic layer, each once for the light palette and once for the dark
 * one. Static values are mode-independent apart from a single step, which is a
 * property of the design system this generator has to respect rather than
 * paper over.
 *
 * @param bundlePath - path to a `dsh-client-ui-theme` client bundle; resolved when omitted.
 * @returns both palettes, keyed by layer and mode.
 */
export function readBaseline(bundlePath = findThemeBundle()) {
  const source = readFileSync(bundlePath, 'utf8')
  const marker = 'design_platform_css_default = "'
  const anchor = source.indexOf(marker)
  if (anchor < 0) {
    throw new Error(`design_platform.css not found in ${bundlePath} — unexpected bundle layout`)
  }
  let end = anchor + marker.length
  while (source[end] !== '"' || source[end - 1] === '\\') end++
  const css = source.slice(anchor + marker.length, end)

  const blocks = [...css.matchAll(/(body(?:\[data-ds-dark-theme\])?)\{([^}]*)\}/g)].map((m) => ({
    selector: m[1],
    decls: Object.fromEntries([...m[2].matchAll(DECLARATION)].map((d) => [d[1], d[2].trim()])),
  }))
  if (blocks.length !== 4) throw new Error(`expected 4 css blocks in ${bundlePath}, got ${blocks.length}`)

  const [staticsLight, staticsDark, declLight, declDark] = blocks.map((b) => b.decls)
  if (staticsLight['--dsw-static-neutral-bluish-950'] === undefined) {
    throw new Error('block 0 is not the static palette — the sheet layout changed')
  }
  if (declLight['--dsw-alias-bg-base'] === undefined) {
    throw new Error('block 2 is not the light semantic layer — the sheet layout changed')
  }

  return { bundlePath, staticsLight, staticsDark, declLight, declDark }
}

/** Every token name the baseline declares, across both layers and modes. */
export function declaredTokens(baseline) {
  return new Set([
    ...Object.keys(baseline.staticsLight),
    ...Object.keys(baseline.staticsDark),
    ...Object.keys(baseline.declLight),
    ...Object.keys(baseline.declDark),
  ])
}
