/**
 * Renders `preview.png` — a palette card drawn with Node's own canvas-free
 * primitives would be a lot of code, so this instead asks a headless browser to
 * screenshot `preview.html` if one is available, and otherwise falls back to a
 * plain SVG-derived PNG via pure JS.
 *
 * In practice the fallback is what runs: no Chrome/Edge binary is spawned from
 * a build script. The fallback encodes an uncompressed PNG with a minimal zlib
 * (stored blocks only), which keeps this dependency-free.
 */
import { deflateSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseColor, toHex, contrast } from './color.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const { tokens } = JSON.parse(readFileSync(join(HERE, 'tokens.json'), 'utf8'))
const report = JSON.parse(readFileSync(join(HERE, 'report.json'), 'utf8'))

// ---------------------------------------------------------------------------
// A tiny raster canvas
// ---------------------------------------------------------------------------

const WIDTH = 1200
const ROWS = 900

/** RGBA pixel buffer, filled with a colour. */
function createCanvas(width, height) {
  const pixels = new Uint8Array(width * height * 4)
  return { width, height, pixels }
}

const setPixel = (canvas, x, y, rgba) => {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return
  const i = (y * canvas.width + x) * 4
  canvas.pixels[i] = rgba[0]
  canvas.pixels[i + 1] = rgba[1]
  canvas.pixels[i + 2] = rgba[2]
  canvas.pixels[i + 3] = rgba[3] ?? 255
}

const fillRect = (canvas, x, y, w, h, rgba) => {
  for (let yy = Math.max(0, y); yy < Math.min(canvas.height, y + h); yy++) {
    for (let xx = Math.max(0, x); xx < Math.min(canvas.width, x + w); xx++) setPixel(canvas, xx, yy, rgba)
  }
}

const fillRoundRect = (canvas, x, y, w, h, r, rgba) => {
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const dx = Math.min(xx, w - 1 - xx)
      const dy = Math.min(yy, h - 1 - yy)
      if (dx < r && dy < r && (r - dx) ** 2 + (r - dy) ** 2 > r * r) continue
      setPixel(canvas, x + xx, y + yy, rgba)
    }
  }
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder (stored deflate blocks — no compression dependency)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeBytes = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])))
  return Buffer.concat([length, typeBytes, data, crc])
}

function encodePng(canvas) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(canvas.width, 0)
  header.writeUInt32BE(canvas.height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  const raw = Buffer.alloc((canvas.width * 4 + 1) * canvas.height)
  for (let y = 0; y < canvas.height; y++) {
    raw[y * (canvas.width * 4 + 1)] = 0
    canvas.pixels.subarray(y * canvas.width * 4, (y + 1) * canvas.width * 4).forEach((v, i) => {
      raw[y * (canvas.width * 4 + 1) + 1 + i] = v
    })
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------------------
// Draw
// ---------------------------------------------------------------------------

const rgba = (name, mode) => {
  const hex = tokens[name]?.[mode]
  if (hex === undefined) return [128, 128, 128, 255]
  const [r, g, b, a] = parseColor(hex)
  return [Math.round(r), Math.round(g), Math.round(b), Math.round((a ?? 1) * 255)]
}

const canvas = createCanvas(WIDTH, ROWS)
const bgLight = rgba('--dsw-alias-bg-base', 'light')
const bgDark = rgba('--dsw-alias-bg-base', 'dark')

// Two columns: light on the left, dark on the right.
const columnWidth = WIDTH / 2
fillRect(canvas, 0, 0, columnWidth, ROWS, bgLight)
fillRect(canvas, columnWidth, 0, columnWidth, ROWS, bgDark)

const drawColumn = (x0, mode) => {
  const pad = 48
  let y = 56

  // Title block
  fillRect(canvas, x0 + pad, y, 160, 26, rgba('--dsw-alias-label-primary', mode))
  fillRect(canvas, x0 + pad, y + 36, 96, 10, rgba('--dsw-alias-label-tertiary', mode))
  y += 88

  // The three surfaces a session is judged on.
  for (const [name, height] of [
    ['--dsw-specific-bubble', 56],
    ['--dsw-alias-markdown-code-block', 56],
    ['--dsw-specific-sidebar-fill', 56],
  ]) {
    fillRoundRect(canvas, x0 + pad, y, columnWidth - pad * 2, height, 10, rgba(name, mode))
    // Text-ish lines inside each surface.
    fillRect(canvas, x0 + pad + 16, y + 16, 260, 8, rgba('--dsw-alias-label-primary', mode))
    fillRect(canvas, x0 + pad + 16, y + 32, 180, 8, rgba('--dsw-alias-label-secondary', mode))
    y += height + 14
  }

  // Accent row: link, business, error, warn, success.
  y += 10
  for (const name of [
    '--dsw-alias-link',
    '--dsw-alias-state-business-primary',
    '--dsw-alias-state-error-primary',
    '--dsw-alias-state-warn-label',
    '--dsw-alias-state-success-primary',
  ]) {
    fillRoundRect(canvas, x0 + pad, y, 44, 44, 22, rgba(name, mode))
    fillRect(canvas, x0 + pad + 56, y + 18, 150, 8, rgba(name, mode))
    y += 58
  }

  // Code highlighter strip.
  y += 6
  fillRoundRect(canvas, x0 + pad, y, columnWidth - pad * 2, 44, 8, rgba('--dsw-alias-markdown-code-block-banner', mode))
  let cx = x0 + pad + 16
  for (const token of [
    '--shiki-token-keyword',
    '--shiki-token-function',
    '--shiki-token-string',
    '--shiki-token-constant',
    '--shiki-token-parameter',
    '--shiki-token-comment',
  ]) {
    fillRoundRect(canvas, cx, y + 14, 28, 16, 4, rgba(token, mode))
    cx += 36
  }
  fillRect(canvas, x0 + pad + 16, y + 36, 300, 3, rgba('--shiki-token-comment', mode))

  // The ramp, as a strip at the bottom.
  const ramp = Object.entries(tokens)
    .filter(([name]) => name.startsWith('--dsw-static-neutral'))
  fillRect(canvas, x0 + pad, ROWS - 120, columnWidth - pad * 2, 40, rgba('--dsw-alias-bg-base', mode))
  let rx = x0 + pad
  for (const [, pair] of ramp) {
    fillRect(canvas, rx, ROWS - 120, 12, 40, rgba('__direct', mode) && pair[mode].length > 0 ? hexToRgba(pair[mode]) : [0, 0, 0, 255])
    rx += 14
    if (rx > x0 + columnWidth - pad) break
  }
}

function hexToRgba(hex) {
  const [r, g, b, a] = parseColor(hex)
  return [Math.round(r), Math.round(g), Math.round(b), Math.round((a ?? 1) * 255)]
}

drawColumn(0, 'light')
drawColumn(columnWidth, 'dark')

// A vertical rule between the columns.
fillRect(canvas, columnWidth - 1, 0, 2, ROWS, [128, 128, 128, 90])

const png = encodePng(canvas)
writeFileSync(join(ROOT, 'preview.png'), png)

const headline = report.pairs.filter((p) => p.mode === 'light').slice(0, 1)[0]
const linkRatio = contrast(parseColor(tokens['--dsw-alias-link'].light), parseColor(tokens['--dsw-alias-bg-base'].light))
console.log(`wrote preview.png (${png.length} bytes) — ${tokens ? Object.keys(tokens).length : 0} tokens, ${report.pairs.length} pairs, link ${linkRatio.toFixed(2)}:1`)
void headline
void toHex
