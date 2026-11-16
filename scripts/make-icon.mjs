#!/usr/bin/env node
/**
 * Generates build/icon.png (1024x1024), the single source electron-builder
 * turns into the .icns and .ico bundles. Written by hand so the project needs
 * no image dependency; edit the constants below to restyle the mark.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 1024
const SAMPLES = 4 // 4x4 supersampling per pixel, for smooth edges
const TOP = [91, 140, 255] // --accent
const BOTTOM = [143, 107, 255]
/** Level meter bars: [height, ...] as a fraction of the canvas. */
const BARS = [0.3, 0.54, 0.4, 0.62, 0.34]
const BAR_WIDTH = 0.072
const BAR_GAP = 0.042

/** Signed-distance test for a rounded rectangle, in pixel space. */
function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  const cx = Math.min(Math.max(x, left + radius), right - radius)
  const cy = Math.min(Math.max(y, top + radius), bottom - radius)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= radius * radius
}

const barsTotal = BARS.length * BAR_WIDTH + (BARS.length - 1) * BAR_GAP
const barsLeft = (1 - barsTotal) / 2

function coverage(x, y) {
  let background = 0
  let mark = 0
  for (let sy = 0; sy < SAMPLES; sy += 1) {
    for (let sx = 0; sx < SAMPLES; sx += 1) {
      const px = x + (sx + 0.5) / SAMPLES
      const py = y + (sy + 0.5) / SAMPLES

      if (insideRoundedRect(px, py, 0, 0, SIZE, SIZE, SIZE * 0.225)) background += 1

      for (const [index, height] of BARS.entries()) {
        const left = (barsLeft + index * (BAR_WIDTH + BAR_GAP)) * SIZE
        const right = left + BAR_WIDTH * SIZE
        const top = (0.5 - height / 2) * SIZE
        const bottom = (0.5 + height / 2) * SIZE
        if (insideRoundedRect(px, py, left, top, right, bottom, (BAR_WIDTH * SIZE) / 2)) {
          mark += 1
          break
        }
      }
    }
  }
  const total = SAMPLES * SAMPLES
  return { background: background / total, mark: mark / total }
}

// One filter byte + RGBA per row.
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4))
for (let y = 0; y < SIZE; y += 1) {
  const rowStart = y * (1 + SIZE * 4)
  raw[rowStart] = 0 // filter: none
  const t = y / (SIZE - 1)
  const base = [
    Math.round(TOP[0] + (BOTTOM[0] - TOP[0]) * t),
    Math.round(TOP[1] + (BOTTOM[1] - TOP[1]) * t),
    Math.round(TOP[2] + (BOTTOM[2] - TOP[2]) * t)
  ]
  for (let x = 0; x < SIZE; x += 1) {
    const { background, mark } = coverage(x, y)
    const offset = rowStart + 1 + x * 4
    // White mark composited over the gradient, both masked by the squircle.
    raw[offset] = Math.round(base[0] * (1 - mark) + 255 * mark)
    raw[offset + 1] = Math.round(base[1] * (1 - mark) + 255 * mark)
    raw[offset + 2] = Math.round(base[2] * (1 - mark) + 255 * mark)
    raw[offset + 3] = Math.round(255 * background)
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // colour type: RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, png)
console.log(`Icona generata: ${out} (${SIZE}x${SIZE}, ${Math.round(png.length / 1024)} KB)`)
