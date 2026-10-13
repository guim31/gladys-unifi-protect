// -----------------------------------------------------------------------------
// A small baseline JPEG decoder that decodes straight to a reduced size.
//
// Why: a general decoder (jpeg-js) keeps every 8×8 block of the frame in
// memory before producing the full-size picture: about 50 bytes per pixel,
// 150 MB and more for the 4 MP and 4K cameras of Protect, in a sandbox of
// 256 MB. Here each block is decoded, inverse-transformed and immediately
// averaged down by 1, 2, 4 or 8 into planes of the reduced size: a 4K frame
// read at 1/4 holds 960 × 540 pixels per component, a few megabytes.
//
// Scope, on purpose: baseline and extended sequential Huffman JPEGs (SOF0,
// SOF1) with one component (grey) or three (YCbCr, any sampling), restart
// markers included — what camera encoders produce. Progressive, arithmetic or
// CMYK files throw UnsupportedJpeg, and the caller falls back to jpeg-js
// within its size cap (src/image-worker.js).
//
// References: ITU-T T.81 (the JPEG standard), annexes A, B, F; colour
// conversion from JFIF 1.02.
// -----------------------------------------------------------------------------

export class UnsupportedJpeg extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsupportedJpeg';
  }
}

// Natural index of the k-th coefficient in zig-zag order (T.81 figure A.6).
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
  13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52,
  45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

// IDCT basis: COS[x * 8 + u] = C(u) / 2 · cos((2x + 1) u π / 16).
const COS = new Float64Array(64);
for (let x = 0; x < 8; x += 1) {
  for (let u = 0; u < 8; u += 1) {
    COS[x * 8 + u] =
      ((u === 0 ? Math.SQRT1_2 : 1) / 2) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
}

/** A canonical Huffman table (T.81 annex C), decoded bit by bit (F.2.2.3). */
function buildHuffman(counts, symbols) {
  const maxCode = new Int32Array(18).fill(-1);
  const valPtr = new Int32Array(17);
  const minCode = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length += 1) {
    const n = counts[length - 1];
    if (n > 0) {
      valPtr[length] = k;
      minCode[length] = code;
      code += n;
      k += n;
      maxCode[length] = code - 1;
    }
    code <<= 1;
  }
  maxCode[17] = 0x7fffffff;
  return { maxCode, valPtr, minCode, symbols };
}

class BitReader {
  constructor(bytes, offset) {
    this.bytes = bytes;
    this.pos = offset;
    this.bits = 0;
    this.count = 0;
    this.marker = null;
  }

  bit() {
    if (this.count === 0) {
      if (this.marker !== null || this.pos >= this.bytes.length) {
        // Past the data (or at a marker): T.81 pads with ones.
        this.bits = 0xff;
      } else {
        let byte = this.bytes[this.pos];
        this.pos += 1;
        if (byte === 0xff) {
          const next = this.bytes[this.pos];
          if (next === 0x00) {
            this.pos += 1;
          } else {
            this.marker = next;
            this.pos -= 1;
            byte = 0xff;
          }
        }
        this.bits = byte;
      }
      this.count = 8;
    }
    this.count -= 1;
    return (this.bits >> this.count) & 1;
  }

  receive(length) {
    let value = 0;
    for (let i = 0; i < length; i += 1) {
      value = (value << 1) | this.bit();
    }
    return value;
  }

  decode(table) {
    let code = this.bit();
    let length = 1;
    while (code > table.maxCode[length]) {
      code = (code << 1) | this.bit();
      length += 1;
      if (length > 16) {
        throw new Error('Corrupt JPEG: bad Huffman code');
      }
    }
    return table.symbols[table.valPtr[length] + code - table.minCode[length]];
  }

  /** Skip to the restart marker expected next and past it. */
  restart() {
    this.count = 0;
    if (this.marker === null) {
      while (this.pos + 1 < this.bytes.length) {
        if (this.bytes[this.pos] === 0xff && this.bytes[this.pos + 1] >= 0xd0) {
          this.marker = this.bytes[this.pos + 1];
          break;
        }
        this.pos += 1;
      }
    }
    if (this.marker !== null && this.marker >= 0xd0 && this.marker <= 0xd7) {
      this.pos += 2;
      this.marker = null;
    }
  }
}

const extend = (value, length) => (value < 1 << (length - 1) ? value - (1 << length) + 1 : value);

/** Parse the headers up to the first scan. */
function parse(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new UnsupportedJpeg('Not a JPEG');
  }
  const quant = [];
  const dc = [];
  const ac = [];
  let frame = null;
  let restartInterval = 0;
  let adobeTransform = null;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) {
      throw new Error('Corrupt JPEG: marker expected');
    }
    const marker = bytes[at + 1];
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    const length = bytes.readUInt16BE(at + 2);
    const start = at + 4;
    const end = at + 2 + length;
    if (marker === 0xdb) {
      // DQT: one or more tables, 8 or 16 bits, in zig-zag order.
      let p = start;
      while (p < end) {
        const precision = bytes[p] >> 4;
        const id = bytes[p] & 15;
        p += 1;
        const table = new Int32Array(64);
        for (let k = 0; k < 64; k += 1) {
          table[k] = precision ? bytes.readUInt16BE(p + 2 * k) : bytes[p + k];
        }
        p += precision ? 128 : 64;
        quant[id] = table;
      }
    } else if (marker === 0xc4) {
      // DHT
      let p = start;
      while (p < end) {
        const tableClass = bytes[p] >> 4;
        const id = bytes[p] & 15;
        const counts = bytes.subarray(p + 1, p + 17);
        const total = counts.reduce((sum, n) => sum + n, 0);
        const table = buildHuffman(counts, bytes.subarray(p + 17, p + 17 + total));
        (tableClass === 0 ? dc : ac)[id] = table;
        p += 17 + total;
      }
    } else if (marker === 0xc0 || marker === 0xc1) {
      const count = bytes[start + 5];
      const components = [];
      for (let i = 0; i < count; i += 1) {
        const p = start + 6 + i * 3;
        components.push({
          id: bytes[p],
          h: bytes[p + 1] >> 4,
          v: bytes[p + 1] & 15,
          tq: bytes[p + 2],
        });
      }
      frame = {
        precision: bytes[start],
        height: bytes.readUInt16BE(start + 1),
        width: bytes.readUInt16BE(start + 3),
        components,
      };
    } else if (marker >= 0xc2 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      throw new UnsupportedJpeg('Progressive or arithmetic JPEG');
    } else if (marker === 0xdd) {
      restartInterval = bytes.readUInt16BE(start);
    } else if (marker === 0xee && bytes.toString('latin1', start, start + 5) === 'Adobe') {
      adobeTransform = bytes[start + 11];
    } else if (marker === 0xda) {
      return {
        quant,
        dc,
        ac,
        frame,
        restartInterval,
        adobeTransform,
        scanAt: start,
        scanLength: length,
      };
    } else if (marker === 0xd9) {
      break;
    }
    at = end;
  }
  throw new Error('Corrupt JPEG: no image data');
}

/** The reduction factor: the largest of 8, 4, 2 that keeps `minWidth` pixels. */
export function chooseScale(width, minWidth) {
  for (const scale of [8, 4, 2]) {
    if (width / scale >= minWidth) {
      return scale;
    }
  }
  return 1;
}

/**
 * Decode a baseline JPEG to RGBA, reduced by `scale` (1, 2, 4 or 8).
 * @param {Buffer} bytes
 * @param {number} scale
 * @returns {{ width: number, height: number, data: Buffer }}
 */
export function decodeScaled(bytes, scale) {
  const header = parse(bytes);
  const { frame, quant, restartInterval } = header;
  if (!frame) {
    throw new Error('Corrupt JPEG: no frame header');
  }
  if (frame.precision !== 8) {
    throw new UnsupportedJpeg('12-bit JPEG');
  }
  if (frame.components.length !== 1 && frame.components.length !== 3) {
    throw new UnsupportedJpeg('CMYK JPEG');
  }
  if (header.adobeTransform === 0 && frame.components.length === 3) {
    throw new UnsupportedJpeg('RGB JPEG');
  }

  // Scan header: every component in one interleaved scan.
  const scanCount = bytes[header.scanAt];
  if (scanCount !== frame.components.length) {
    throw new UnsupportedJpeg('Non-interleaved JPEG');
  }
  for (let i = 0; i < scanCount; i += 1) {
    const id = bytes[header.scanAt + 1 + i * 2];
    const tables = bytes[header.scanAt + 2 + i * 2];
    const component = frame.components.find((c) => c.id === id);
    if (!component) {
      throw new Error('Corrupt JPEG: unknown scan component');
    }
    component.dcTable = header.dc[tables >> 4];
    component.acTable = header.ac[tables & 15];
    component.quant = quant[component.tq];
    if (!component.dcTable || !component.acTable || !component.quant) {
      throw new Error('Corrupt JPEG: missing table');
    }
  }

  const single = frame.components.length === 1;
  const maxH = single ? 1 : Math.max(...frame.components.map((c) => c.h));
  const maxV = single ? 1 : Math.max(...frame.components.map((c) => c.v));
  if (single) {
    // A lone component is coded one block per MCU, whatever its factors.
    frame.components[0].h = 1;
    frame.components[0].v = 1;
  }
  const mcusX = Math.ceil(frame.width / (8 * maxH));
  const mcusY = Math.ceil(frame.height / (8 * maxV));

  for (const c of frame.components) {
    // A subsampled component (chroma) is reduced less: its samples already
    // cover several pixels, so it keeps the resolution of the output.
    c.sx = Math.max(1, (scale * c.h) / maxH);
    c.sy = Math.max(1, (scale * c.v) / maxV);
    c.cellWidth = 8 / c.sx;
    c.cellHeight = 8 / c.sy;
    c.planeWidth = mcusX * c.h * c.cellWidth;
    c.planeHeight = mcusY * c.v * c.cellHeight;
    c.plane = new Uint8Array(c.planeWidth * c.planeHeight);
    c.pred = 0;
  }

  const reader = new BitReader(bytes, header.scanAt + header.scanLength - 2);
  const coefficients = new Float64Array(64);
  const rows = new Float64Array(64);

  const decodeBlock = (c, blockX, blockY) => {
    coefficients.fill(0);
    const t = reader.decode(c.dcTable);
    c.pred += t === 0 ? 0 : extend(reader.receive(t), t);
    coefficients[0] = c.pred * c.quant[0];
    for (let k = 1; k < 64;) {
      const rs = reader.decode(c.acTable);
      const run = rs >> 4;
      const size = rs & 15;
      if (size === 0) {
        if (run !== 15) {
          break; // end of block
        }
        k += 16;
        continue;
      }
      k += run;
      if (k > 63) {
        throw new Error('Corrupt JPEG: coefficient out of the block');
      }
      coefficients[ZIGZAG[k]] = extend(reader.receive(size), size) * c.quant[k];
      k += 1;
    }
    // Inverse DCT, rows then columns, then average each sx × sy cell.
    for (let v = 0; v < 8; v += 1) {
      for (let x = 0; x < 8; x += 1) {
        let sum = 0;
        for (let u = 0; u < 8; u += 1) {
          sum += COS[x * 8 + u] * coefficients[v * 8 + u];
        }
        rows[v * 8 + x] = sum;
      }
    }
    const { sx, sy } = c;
    const area = sx * sy;
    const baseX = blockX * c.cellWidth;
    const baseY = blockY * c.cellHeight;
    for (let cy = 0; cy < c.cellHeight; cy += 1) {
      for (let cx = 0; cx < c.cellWidth; cx += 1) {
        let total = 0;
        for (let y = cy * sy; y < (cy + 1) * sy; y += 1) {
          for (let x = cx * sx; x < (cx + 1) * sx; x += 1) {
            let sum = 0;
            for (let v = 0; v < 8; v += 1) {
              sum += COS[y * 8 + v] * rows[v * 8 + x];
            }
            total += sum;
          }
        }
        const value = Math.round(total / area + 128);
        c.plane[(baseY + cy) * c.planeWidth + baseX + cx] =
          value < 0 ? 0 : value > 255 ? 255 : value;
      }
    }
  };

  let mcu = 0;
  for (let my = 0; my < mcusY; my += 1) {
    for (let mx = 0; mx < mcusX; mx += 1) {
      if (restartInterval && mcu > 0 && mcu % restartInterval === 0) {
        reader.restart();
        for (const c of frame.components) {
          c.pred = 0;
        }
      }
      for (const c of frame.components) {
        for (let by = 0; by < c.v; by += 1) {
          for (let bx = 0; bx < c.h; bx += 1) {
            decodeBlock(c, mx * c.h + bx, my * c.v + by);
          }
        }
      }
      mcu += 1;
    }
  }

  // Colour conversion at the reduced size (JFIF YCbCr → RGB).
  const width = Math.ceil(frame.width / scale);
  const height = Math.ceil(frame.height / scale);
  const data = Buffer.alloc(width * height * 4);
  const [Y, Cb, Cr] = frame.components;
  // Output pixel → component sample: the component covers maxH / h output
  // pixels per sample before its own reduction by sx.
  const sample = (c, x, y) =>
    c.plane[
      Math.floor((y * scale * c.v) / (maxV * c.sy)) * c.planeWidth +
        Math.floor((x * scale * c.h) / (maxH * c.sx))
    ];
  const clamp = (value) => (value < 0 ? 0 : value > 255 ? 255 : Math.round(value));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const luma = sample(Y, x, y);
      if (single) {
        data[at] = luma;
        data[at + 1] = luma;
        data[at + 2] = luma;
      } else {
        const cb = sample(Cb, x, y) - 128;
        const cr = sample(Cr, x, y) - 128;
        data[at] = clamp(luma + 1.402 * cr);
        data[at + 1] = clamp(luma - 0.344136 * cb - 0.714136 * cr);
        data[at + 2] = clamp(luma + 1.772 * cb);
      }
      data[at + 3] = 255;
    }
  }
  return { width, height, data };
}
