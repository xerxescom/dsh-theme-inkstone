/**
 * Validates the shipped artifacts without re-deriving them.
 *
 * The palette generator is the only thing allowed to invent a colour; this
 * script's job is to prove the files on disk agree with each other, with the
 * installed DSH, and with the promises the theme makes. Everything here is a
 * property that a hand edit — or a DSH upgrade that moved the token surface —
 * could plausibly break, and that would otherwise only show up as a subtly
 * wrong colour in the browser.
 *
 * Run with `node tools/check.mjs`.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readBaseline, declaredTokens } from './dsh-baseline.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const failures = []
const checks = []
function check(description, run) {
  try {
    const detail = run()
    checks.push({ description, detail: detail ?? '' })
  } catch (error) {
    failures.push({ description, message: error instanceof Error ? error.message : String(error) })
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const tokensRaw = readFileSync(join(HERE, 'tokens.json'), 'utf8')
const tokens = JSON.parse(tokensRaw)
const report = JSON.parse(readFileSync(join(HERE, 'report.json'), 'utf8'))
const clientSource = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')
const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')

// -------------------------------------------------------------- the token map

check('token names are valid --dsw-* custom properties', () => {
  const names = Object.keys(tokens)
  assert(names.length > 0, 'tokens.json is empty')
  const bad = names.filter((n) => !/^--dsw-[a-z0-9-]+$/.test(n))
  assert(bad.length === 0, `malformed token names: ${bad.join(', ')}`)
  return `${names.length} tokens`
})

check('no duplicate keys (JSON.parse would hide them)', () => {
  const seen = new Map()
  const duplicates = []
  for (const m of tokensRaw.matchAll(/^\s*"(--dsw-[a-z0-9-]+)":/gm)) {
    if (seen.has(m[1])) duplicates.push(m[1])
    seen.set(m[1], true)
  }
  assert(duplicates.length === 0, `duplicate keys: ${[...new Set(duplicates)].join(', ')}`)
  return `${seen.size} unique keys`
})

check('every token carries a light and a dark colour', () => {
  const problems = []
  for (const [name, pair] of Object.entries(tokens)) {
    if (pair === null || typeof pair !== 'object') { problems.push(`${name}: not an object`); continue }
    const keys = Object.keys(pair).sort().join(',')
    if (keys !== 'dark,light') { problems.push(`${name}: keys are ${keys}`); continue }
    for (const mode of ['light', 'dark']) {
      const value = pair[mode]
      if (typeof value !== 'string' || value.trim() === '') { problems.push(`${name}.${mode}: empty`); continue }
      if (!/^#[0-9a-f]{3,8}$/i.test(value) && !/^(rgb|hsl|oklch|color)\(/i.test(value)) {
        problems.push(`${name}.${mode}: not a colour (${value})`)
      }
    }
  }
  assert(problems.length === 0, problems.slice(0, 5).join('; '))
  return 'all pairs complete and colour-shaped'
})

check('no session-specific paths baked into the palette', () => {
  const suspicious = tokensRaw.match(/[A-Za-z]:[\\/]|\/Users\/|\/home\//g)
  assert(suspicious === null, `found a path in tokens.json: ${suspicious?.[0]}`)
  return 'portable'
})

// ------------------------------------------------- against the installed DSH

check('every token this theme sets still exists in the installed DSH', () => {
  const baseline = readBaseline()
  const declared = declaredTokens(baseline)
  const unknown = Object.keys(tokens).filter((n) => !declared.has(n))
  assert(
    unknown.length === 0,
    `these tokens are not declared by the installed DSH (typo, or the token surface moved): ${unknown.slice(0, 8).join(', ')}`,
  )
  return `verified against ${baseline.bundlePath.split(/[\\/]/).slice(-3).join('/')}`
})

check('the verification report has no broken contrast pair', () => {
  const broken = report.contrast.filter((r) => r.state === 'BROKEN')
  assert(broken.length === 0, broken.map((r) => `${r.mode} ${r.pair} (${r.before} -> ${r.after})`).join('; '))
  const inherited = report.contrast.filter((r) => r.state === 'inherited').length
  return `${report.contrast.length} pairs checked, ${inherited} below floor at baseline too`
})

check('the report was generated from the palette on disk', () => {
  assert(
    report.palette.overrideTokens === Object.keys(tokens).length,
    `report.json says ${report.palette.overrideTokens} tokens, tokens.json has ${Object.keys(tokens).length} — rerun tools/palette.mjs`,
  )
  return `${report.palette.ramps} ramps + ${report.palette.semantic} semantic`
})

// ------------------------------------------------------------- the client half

check('lib/client.js is syntactically valid', () => {
  assert(existsSync(join(ROOT, 'lib/client.js')), 'lib/client.js is missing')
  // Compiles the bundle without running it: window is never touched at parse time.
  new Function(clientSource)
  return `${clientSource.length} bytes`
})

check('lib/client.js embeds exactly the palette on disk', () => {
  const embedded = new Set([...clientSource.matchAll(/["'](--dsw-[a-z0-9-]+)["']:\s*\{/g)].map((m) => m[1]))
  const expected = new Set(Object.keys(tokens))
  const missing = [...expected].filter((n) => !embedded.has(n))
  const extra = [...embedded].filter((n) => !expected.has(n))
  assert(missing.length === 0, `embedded bundle is stale, missing ${missing.length} token(s): ${missing.slice(0, 5).join(', ')} — rerun tools/build-client.mjs`)
  assert(extra.length === 0, `embedded bundle has ${extra.length} token(s) not in tokens.json: ${extra.slice(0, 5).join(', ')}`)
  return `${embedded.size} tokens embedded`
})

check('the client half requests the theme service and cleans up after itself', () => {
  assert(/const inject = \["theme"\]/.test(clientSource), 'inject does not require the theme service')
  assert(/overrideTokens\(SOURCE, TOKENS\)/.test(clientSource), 'the palette is never handed to overrideTokens')
  assert(/ctx\.effect\(/.test(clientSource), 'the override disposer is not registered with ctx.effect — unloading would leak the layer')
  return 'inject + effect + overrideTokens present'
})

// ------------------------------------------------------------- packaging

check('package.json, the patch layer, and the bundle agree on one identity', () => {
  const patchName = /name:\s*'([^']+)'/.exec(patch)?.[1]
  const patchId = /id:\s*([^\s]+)/.exec(patch)?.[1]
  const clientId = /id:\s*"([^"]+)"/.exec(clientSource)?.[1]
  assert(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'package.json does not declare dsh.bundle.patch')
  assert(patchName === pkg.name, `patch inserts "${patchName}" but the package is "${pkg.name}"`)
  assert(clientId === pkg.name, `client bundle registers as "${clientId}" but the package is "${pkg.name}"`)
  assert(patchId !== undefined && patchId.length > 0, 'patch row has no id')
  return `${pkg.name} (patch row ${patchId})`
})

check('the declared entry points exist and are wired for the web client', () => {
  assert(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform is not "web"')
  assert(Array.isArray(pkg.dsh.client.inject), 'dsh.client.inject is missing')
  assert(
    pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-theme'),
    'dsh.client.inject does not load the theme package first',
  )
  for (const [key, target] of Object.entries(pkg.exports ?? {})) {
    if (typeof target !== 'string' || !target.startsWith('./')) continue
    assert(existsSync(join(ROOT, target)), `export "${key}" points at a missing file: ${target}`)
  }
  return Object.keys(pkg.exports).join(', ')
})

// ------------------------------------------------------------------- verdict

for (const c of checks) console.log(`  ok   ${c.description}${c.detail ? `  —  ${c.detail}` : ''}`)
for (const f of failures) console.log(`  FAIL ${f.description}\n         ${f.message}`)
console.log('')
if (failures.length > 0) {
  console.log(`${failures.length} check(s) failed`)
  process.exitCode = 1
} else {
  console.log(`all ${checks.length} checks passed`)
}
