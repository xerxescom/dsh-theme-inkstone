/**
 * Renders the generated palette straight to PNG with no browser involved:
 * a minimal PNG encoder over node:zlib, then solid blocks laid out as the
 * surfaces DSH builds. Text is deliberately absent 鈥?the block order is the
 * legend, and this exists to judge colour harmony and muddy-ness, not copy.
 *
 * rows, top to bottom:  light ramp / light accent / light mock UI
 *                       dark  ramp / dark  accent / dark  mock UI
 */
import { deflateSync, inflateSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ramps = JSON.parse(readFileSync(join(HERE, 'ramps.json'), 'utf8'))

const W = 940
const H = 560
const px = new Uint8Array(W * H * 4)

const hexToRgb = (hex) => {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
}
function rect(x, y, w, h, hex) {
  const [r, g, b] = hexToRgb(hex)
  for (let yy = Math.max(0, y); yy < Math.min(H, y + h); yy++) {
    for (let xx = Math.max(0, x); xx < Math.min(W, x + w); xx++) {
      const i = (yy * W + xx) * 4
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255
    }
  }
}
/** A hairline separator drawn as a solid block, using the palette's own border token. */
const border = (x, y, w, h, hex) => rect(x, y, w, h, hex)

// ------------------------------------------------------------------- PNG output

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
/** Encode the pixel buffer. Must run AFTER every draw call. */
function encodePng() {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const stride = W * 4
  const raw = Buffer.alloc(H * (stride + 1))
  for (let y = 0; y < H; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(px.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ------------------------------------------------------------------ composition

const rampOf = (statics, prefix) =>
  Object.entries(statics)
    .filter(([k]) => k.startsWith('--dsw-static-' + prefix))
    .sort(([a], [b]) => Number(a.split('-').pop().replace(/\D/g, '')) - Number(b.split('-').pop().replace(/\D/g, '')))
    .map(([, v]) => v)
const alias = (mode, token) => ramps['alias' + mode[0].toUpperCase() + mode.slice(1)]['--dsw-alias-' + token]

function paint(mode, top) {
  const statics = ramps[mode]
  const neutral = rampOf(statics, 'neutral-bluish-')
  const accent = rampOf(statics, 'deepseek-')
  const scale = 2

  // ramp strips
  const cell = Math.floor((W - 40) / Math.max(neutral.length, accent.length))
  neutral.forEach((v, i) => rect(20 + i * cell, top, cell - 3, 26 * scale / 2, v))
  accent.forEach((v, i) => rect(20 + i * cell, top + 30, cell - 3, 26 * scale / 2, v))

  // mock UI, left to right: sidebar | stream | menus | states
  const y = top + 66
  const bg = alias(mode, 'bg-base')
  const layer = alias(mode, 'bg-layer-2')
  rect(20, y, W - 40, 118, bg)
  border(20, y, W - 40, 1, alias(mode, 'border-l2'))

  // sidebar
  const sb = ramps['alias' + mode[0].toUpperCase() + mode.slice(1)]['--dsw-specific-sidebar-fill']
  rect(20, y, 150, 118, sb)
  rect(32, y + 14, 60, 9, alias(mode, 'label-primary'))
  rect(32, y + 38, 110, 18, ramps['alias' + mode[0].toUpperCase() + mode.slice(1)]['--dsw-specific-sidebar-nav-item-active'])
  rect(32, y + 40, 3, 14, ramps['alias' + mode[0].toUpperCase() + mode.slice(1)]['--dsw-specific-sidebar-nav-item-active-accent'])
  rect(42, y + 44, 70, 7, alias(mode, 'label-primary'))
  rect(32, y + 64, 80, 7, alias(mode, 'label-secondary'))
  rect(32, y + 80, 66, 7, alias(mode, 'label-tertiary'))
  rect(32, y + 96, 74, 7, alias(mode, 'label-caption'))

  // conversation stream: assistant bubble (with link + code), user bubble on the accent
  const bubble = ramps['alias' + mode[0].toUpperCase() + mode.slice(1)]['--dsw-specific-bubble']
  const bubbleHi = ramps['alias' + mode[0].toUpperCase() + mode.slice(1)]['--dsw-specific-bubble-highlight']
  rect(186, y + 12, 300, 60, bubble)
  rect(198, y + 24, 250, 7, alias(mode, 'label-primary'))
  rect(198, y + 38, 170, 7, alias(mode, 'label-secondary'))
  rect(198, y + 52, 60, 7, alias(mode, 'link'))
  rect(266, y + 52, 70, 7, alias(mode, 'markdown-inline-code'))
  rect(430, y + 80, 220, 26, bubbleHi)
  rect(444, y + 89, 150, 7, alias(mode, 'label-primary'))

  // composer + buttons
  rect(186, y + 92, 300, 20, ramps['alias' + mode[0].toUpperCase() + mode.slice(1)]['--dsw-specific-input-major'])
  rect(500, y + 12, 74, 30, alias(mode, 'button-primary-fill'))
  rect(500, y + 50, 74, 22, alias(mode, 'button-info-fill'))
  rect(500, y + 78, 74, 22, layer)

  // menus / overlays
  rect(590, y + 12, 120, 74, ramps['alias' + mode[0].toUpperCase() + mode.slice(1)]['--dsw-specific-menu'])
  rect(598, y + 20, 104, 14, alias(mode, 'interactive-bg-hover'))
  rect(598, y + 40, 104, 7, alias(mode, 'label-secondary'))
  rect(598, y + 53, 80, 7, alias(mode, 'label-tertiary'))
  rect(598, y + 66, 90, 7, alias(mode, 'label-caption'))
  rect(724, y + 12, 90, 24, alias(mode, 'toast-bg'))
  rect(724, y + 42, 70, 20, alias(mode, 'tooltip-bg'))

  // state text bars + scrollbar
  rect(820, y + 12, 100, 9, alias(mode, 'state-success-primary'))
  rect(820, y + 28, 100, 9, alias(mode, 'state-warn-primary'))
  rect(820, y + 44, 100, 9, alias(mode, 'state-error-primary'))
  rect(820, y + 60, 100, 9, alias(mode, 'state-business-primary'))
  rect(820, y + 78, 100, 9, alias(mode, 'markdown-code-block'))
  rect(908, y + 96, 9, 20, alias(mode, 'scrollbar-hover-l1'))
}

rect(0, 0, W, H, ramps.aliasDark['--dsw-alias-bg-base'])
paint('light', 14)
paint('dark', 292)

const png = encodePng()

/**
 * Round-trip check: inflate the IDAT we just wrote and compare the scanlines
 * byte for byte against the pixel buffer. This exists because the preview is
 * read back as an image by eye, and an encoder bug (or a filter/stride slip)
 * would show up as a plausible-looking but wrong colour rather than an error.
 */
function verifyPng(buffer) {
  let offset = 8
  const idat = []
  while (offset < buffer.length) {
    const len = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    if (type === 'IDAT') idat.push(buffer.subarray(offset + 8, offset + 8 + len))
    offset += 12 + len
  }
  const inflated = inflateSync(Buffer.concat(idat))
  const stride = W * 4
  if (inflated.length !== H * (stride + 1)) throw new Error('scanline length mismatch')
  for (let y = 0; y < H; y++) {
    if (inflated[y * (stride + 1)] !== 0) throw new Error('unexpected filter type on row ' + y)
    for (let i = 0; i < stride; i++) {
      if (inflated[y * (stride + 1) + 1 + i] !== px[y * stride + i]) {
        throw new Error(`pixel mismatch at row ${y} byte ${i}`)
      }
    }
  }
  return true
}
verifyPng(png)

writeFileSync(join(HERE, '..', 'preview.png'), png)
console.log('wrote preview.png', png.length, 'bytes', `${W}x${H}`, '(encoder round-trip verified)')
