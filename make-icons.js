'use strict';

/**
 * Generates the PNG icons the manifest needs.
 *
 * Chrome will not offer to install a PWA — and so will not build a WebAPK —
 * without a raster icon of at least 192px. An SVG alone is not enough, which is
 * why this exists rather than just shipping icon.svg.
 *
 * Writing the PNG by hand keeps the project's zero-dependency rule: a PNG is a
 * signature, three chunks, and a zlib stream, and pulling in a canvas or an SVG
 * rasteriser for two flat images would be the heaviest thing in the repo.
 *
 *   node make-icons.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const COLOURS = {
  bg: [0x0e, 0x11, 0x16],
  screen: [0x16, 0x1b, 0x22],
  edge: [0x3a, 0x45, 0x53],
  notch: [0x2a, 0x32, 0x3d],
  play: [0x4c, 0x9a, 0xff],
};

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // truecolour with alpha
  // 10-12: deflate, adaptive filtering, no interlace — all zero.

  // Each scanline is prefixed with its filter type; 0 means "none", which
  // compresses fine for flat colour and keeps this simple.
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const at = y * (1 + width * 4);
    raw[at] = 0;
    rgba.copy(raw, at + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * `maskable` means Android may crop the icon to a circle or a squircle, so
 * everything that matters stays inside the middle 80%.
 */
function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const u = size / 512; // the artwork is designed at 512 and scaled
  const set = (x, y, [r, g, b]) => {
    const at = (y * size + x) * 4;
    px[at] = r; px[at + 1] = g; px[at + 2] = b; px[at + 3] = 255;
  };

  const screen = { x0: 96 * u, y0: 152 * u, x1: 416 * u, y1: 360 * u };
  const play = { x0: 226 * u, y0: 208 * u, x1: 318 * u, mid: 256 * u, h: 96 * u };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let colour = COLOURS.bg;

      const inScreen = x >= screen.x0 && x <= screen.x1 && y >= screen.y0 && y <= screen.y1;
      if (inScreen) {
        const border = 6 * u;
        const onEdge = x < screen.x0 + border || x > screen.x1 - border
          || y < screen.y0 + border || y > screen.y1 - border;
        colour = onEdge ? COLOURS.edge : COLOURS.screen;

        // Film-strip perforations down both sides.
        const inNotchColumn = (x > screen.x0 + 14 * u && x < screen.x0 + 40 * u)
          || (x < screen.x1 - 14 * u && x > screen.x1 - 40 * u);
        if (inNotchColumn && !onEdge) {
          const band = ((y - screen.y0) / u) % 52;
          if (band > 10 && band < 34) colour = COLOURS.notch;
        }

        // A play triangle: half-height at the tip, full at the base.
        if (x >= play.x0 && x <= play.x1) {
          const across = (x - play.x0) / (play.x1 - play.x0);
          const half = (play.h / 2) * (1 - across);
          if (Math.abs(y - (play.y0 + play.h / 2)) <= half) colour = COLOURS.play;
        }
      }

      set(x, y, colour);
    }
  }
  return px;
}

for (const size of [192, 512]) {
  const file = path.join(__dirname, `icon-${size}.png`);
  fs.writeFileSync(file, png(size, size, draw(size)));
  console.log(`wrote ${path.basename(file)}  ${fs.statSync(file).size} bytes`);
}
