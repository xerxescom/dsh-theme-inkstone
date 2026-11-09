/**
 * Reads the authoritative theme baseline out of the *installed* DeepSeek
 * Harness, so the palette is always derived from the running design system
 * rather than from a copy that rots in this repository.
 *
 * The baseline is inlined as JS string literals in
 * `dsh-client-ui-theme/lib/client.js`; the `STYLES` table at the bottom of that
 * bundle names the sheets, and each name maps to a `var <role>_css_default = "…"`
 * literal above it. The loader:
 *
 *   1. locates the package (env override → known install roots),
 *   2. reads the bundle and the STYLES table,
 *   3. cuts each sheet into blocks with brace matching (not a regex: the
 *      strings contain nested at-rules),
 *   4. merges the `body` / `:root` blocks into one light map and
 *      `body[data-ds-dark-theme]` into one dark map per sheet.
 *
 * Every step fails loudly. A silent "no tokens found" is the one outcome that
 * would produce a broken palette which still passes its own checks.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const PKG = '@deepseek-ai/dsh-client-ui-theme'
const BUNDLE = join('lib', 'client.js')

/** The stylesheets `base.css`'s user font settings are read through. */
const SHEET_FILES = ['base.css', 'design-platform.css', 'shiki.css']

/**
 * Candidate install locations, most specific first. `DSH_UI_THEME_DIR` wins so a
 * CI job or a non-standard install can point at the bundle it actually ships.
 * @returns {string[]}
 */
function candidateRoots() {
  const roots = []
  if (process.env.DSH_UI_THEME_DIR) roots.push(process.env.DSH_UI_THEME_DIR)
  if (process.env.DSH_INSTALL_DIR) roots.push(join(process.env.DSH_INSTALL_DIR, 'node_modules', PKG))
  if (process.env.APPDATA) {
    const npmGlobal = join(process.env.APPDATA, 'npm', 'node_modules')
    roots.push(join(npmGlobal, '@deepseek-ai', 'dsh', 'node_modules', PKG))
    roots.push(join(npmGlobal, PKG))
  }
  if (process.env.DSH_HOME) roots.push(join(process.env.DSH_HOME, 'profiles', 'web', 'node_modules', PKG))
  return roots
}

/**
 * Locate the installed `dsh-client-ui-theme` package.
 * @returns {{ dir: string, version: string }}
 */
export function locateThemePackage() {
  const tried = []
  for (const root of candidateRoots()) {
    tried.push(root)
    const bundle = join(root, BUNDLE)
    const manifest = join(root, 'package.json')
    if (!existsSync(bundle) || !existsSync(manifest)) continue
    return { dir: root, version: JSON.parse(readFileSync(manifest, 'utf8')).version }
  }
  throw new Error(
    `cannot find ${PKG} (looked in:\n  ${tried.join('\n  ')}\n) — set DSH_UI_THEME_DIR to the package directory`,
  )
}

/**
 * Read the `var(--name)` reference of a declaration, if it is one.
 * @param {string} value
 * @returns {string | null}
 */
export function varRef(value) {
  const m = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(value.trim())
  return m === null ? null : m[1]
}

/**
 * Cut a stylesheet into `{ selector, decls }` blocks by brace matching.
 * @param {string} css
 * @returns {{ selector: string, decls: Record<string, string> }[]}
 */
export function parseSheets(css) {
  /** @type {{ selector: string, decls: Record<string, string> }[]} */
  const blocks = []
  /** @type {{ selector: string, body: string }[]} */
  const stack = []
  let buffer = ''
  for (const ch of css) {
    if (ch === '{') {
      // A selector may itself be wrapped in an at-rule; keep the inner-most one.
      const selector = buffer.trim()
      stack.push({ selector: selector.includes('@') ? selector.slice(selector.lastIndexOf('@')) : selector, body: '' })
      buffer = ''
    } else if (ch === '}') {
      const top = stack.pop()
      if (top !== undefined && stack.length === 0) {
        blocks.push({ selector: top.selector, decls: parseDeclarations(top.body + buffer) })
      } else if (top !== undefined) {
        // Nested block: fold its declarations into the parent selector.
        stack[stack.length - 1].body += `;${top.body}${buffer}`
      }
      buffer = ''
    } else if (stack.length > 0) {
      stack[stack.length - 1].body += ch
    } else {
      buffer += ch
    }
  }
  return blocks.filter((b) => !b.selector.startsWith('@'))
}

/**
 * @param {string} text
 * @returns {Record<string, string>}
 */
function parseDeclarations(text) {
  const decls = {}
  for (const m of text.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+)/gi)) decls[m[1]] = m[2].trim()
  return decls
}

/**
 * Resolve a token through `var()` aliases down to a literal value.
 *
 * Resolution stops at the last token name it walked through, so the caller can
 * tell which seed actually produced the value. An alias cycle is an error, not
 * null: the design system on disk is then not what this toolchain was written
 * against.
 *
 * @param {string} name
 * @param {Record<string, string>} mode Declarations for one colour scheme.
 * @returns {{ value: string, source: string } | null} Source is the first name whose literal value was used.
 */
export function resolveWithSource(name, mode) {
  const seen = new Set()
  let current = name
  for (;;) {
    const value = mode[current]
    if (value === undefined) return null
    const ref = varRef(value)
    if (ref === null) return { value, source: current }
    if (seen.has(ref)) throw new Error(`alias cycle: ${[...seen, ref].join(' → ')}`)
    seen.add(ref)
    current = ref
  }
}

/**
 * Resolve a token through `var()` aliases down to a literal value.
 * @param {string} name
 * @param {Record<string, string>} mode Declarations for one colour scheme.
 * @returns {string | null} Literal value, or null when the token is absent.
 */
export function resolveToken(name, mode) {
  const hit = resolveWithSource(name, mode)
  return hit === null ? null : hit.value
}

/**
 * Pull the stylesheet literal a STYLES entry refers to.
 * @param {string} source Bundle source.
 * @param {string} identifier JS identifier, e.g. `design_platform_css_default`.
 * @returns {string}
 */
function readSheetLiteral(source, identifier) {
  const anchor = `${identifier} = "`
  const at = source.indexOf(anchor)
  if (at < 0) throw new Error(`stylesheet literal ${identifier} not found — the bundle layout changed`)
  const start = at + anchor.length
  let out = ''
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (ch === '\\') {
      // Only \" and \\ occur in CSS; anything else is kept verbatim.
      const next = source[i + 1]
      out += next === '"' || next === '\\' ? next : `\\${next}`
      i += 1
      continue
    }
    if (ch === '"') return out
    out += ch
  }
  throw new Error(`unterminated stylesheet literal ${identifier}`)
}

const MODE_SELECTORS = {
  light: ['body', ':root'],
  dark: ['body[data-ds-dark-theme]'],
}

/**
 * Merge one colour scheme's declarations across blocks.
 * @param {{ selector: string, decls: Record<string, string> }[]} blocks
 * @param {'light' | 'dark'} mode
 * @returns {Record<string, string>}
 */
function modeDeclarations(blocks, mode) {
  const merged = {}
  for (const block of blocks) {
    if (!MODE_SELECTORS[mode].includes(block.selector)) continue
    Object.assign(merged, block.decls)
  }
  return merged
}

/**
 * Read the whole baseline: ramps, semantic aliases, code-highlight colours and
 * the non-colour properties this theme touches (font stacks).
 *
 * @returns {{
 *   pkg: { dir: string, version: string },
 *   modes: { light: Record<string, string>, dark: Record<string, string> },
 *   shiki: { light: Record<string, string>, dark: Record<string, string> },
 *   ramps: string[],
 *   semantic: string[],
 * }}
 */
export function readBaseline() {
  const pkg = locateThemePackage()
  const source = readFileSync(join(pkg.dir, BUNDLE), 'utf8')

  const sheets = {}
  for (const file of SHEET_FILES) {
    sheets[file] = readSheetLiteral(source, file.replace(/[.-]/g, '_') + '_default')
  }

  const designBlocks = parseSheets(sheets['design-platform.css'])
  const modes = {
    light: modeDeclarations(designBlocks, 'light'),
    dark: modeDeclarations(designBlocks, 'dark'),
  }

  const ramps = Object.keys(modes.light).filter((n) => n.startsWith('--dsw-static-')).sort()
  const darkRamps = Object.keys(modes.dark).filter((n) => n.startsWith('--dsw-static-')).sort()
  if (ramps.length === 0) throw new Error('design-platform.css declares no --dsw-static-* ramps')
  if (JSON.stringify(ramps) !== JSON.stringify(darkRamps)) {
    throw new Error('light and dark ramps diverge — this theme assumes one shared ramp table')
  }

  const semantic = Object.keys(modes.light).filter((n) => !n.startsWith('--dsw-static-')).sort()
  if (semantic.length === 0) throw new Error('design-platform.css declares no semantic tokens')

  const shikiBlocks = parseSheets(sheets['shiki.css'])
  const shiki = {
    light: modeDeclarations(shikiBlocks, 'light'),
    dark: modeDeclarations(shikiBlocks, 'dark'),
  }
  if (Object.keys(shiki.light).length === 0) throw new Error('shiki.css declares no --shiki-* colours')

  return { pkg, sheets, modes, shiki, ramps, semantic }
}

/**
 * Directory holding every installed `@deepseek-ai/*` client package.
 * @param {string} installRoot
 * @returns {string}
 */
export function nodeModulesRoot(installRoot) {
  return installRoot.replace(/node_modules[\\/]@deepseek-ai[\\/][^\\/]+$/, 'node_modules')
}

/**
 * Read one installed client package's bundle, or null when absent.
 * @param {string} installRoot
 * @param {string} pkgName
 * @returns {string | null}
 */
export function readClientBundle(installRoot, pkgName) {
  const file = join(nodeModulesRoot(installRoot), '@deepseek-ai', pkgName, BUNDLE)
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

/**
 * @param {string} installRoot
 * @returns {string[]}
 */
export function clientPackages(installRoot) {
  try {
    return readdirSync(join(nodeModulesRoot(installRoot), '@deepseek-ai'))
      .filter((name) => name.startsWith('dsh-client-'))
      .sort()
  } catch {
    return []
  }
}
