// -----------------------------------------------------------------------------
// Camera snapshots made to fit Gladys: the small baseline decoder against
// jpeg-js on files written by another encoder, the frame size read from the
// header, and the conversion in its worker (a 4K frame included).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import {
  CAMERA_PREFIX,
  MAX_CAMERA_IMAGE,
  fitJpeg,
  fitsCamera,
  isJpeg,
  jpegSize,
  toCameraImage,
} from '../src/image.js';
import { ATTEMPTS, convert, shrink } from '../src/image-worker.js';
import { UnsupportedJpeg, chooseScale, decodeScaled } from '../src/jpeg-scaled.js';
import { smallJpeg } from './helpers/fakeProtect.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/jpeg/${name}`, import.meta.url));

/** Mean absolute difference of the RGB channels of two RGBA images. */
function difference(a, b) {
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let total = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      total += Math.abs(a.data[i + c] - b.data[i + c]);
    }
  }
  return total / ((a.data.length / 4) * 3);
}

/** Reduce an RGBA image by an integer factor, cell by cell, as the decoder does. */
function reduceBy(image, scale) {
  const width = Math.ceil(image.width / scale);
  const height = Math.ceil(image.height / scale);
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sums = [0, 0, 0];
      let count = 0;
      for (let sy = y * scale; sy < Math.min(image.height, (y + 1) * scale); sy += 1) {
        for (let sx = x * scale; sx < Math.min(image.width, (x + 1) * scale); sx += 1) {
          for (let c = 0; c < 3; c += 1) {
            sums[c] += image.data[(sy * image.width + sx) * 4 + c];
          }
          count += 1;
        }
      }
      for (let c = 0; c < 3; c += 1) {
        data[(y * width + x) * 4 + c] = Math.round(sums[c] / count);
      }
      data[(y * width + x) * 4 + 3] = 255;
    }
  }
  return { width, height, data };
}

/** A noisy RGBA frame: the worst case for JPEG compression. */
function noisyFrame(width, height) {
  const data = Buffer.alloc(width * height * 4);
  let seed = 1;
  for (let i = 0; i < width * height; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const x = i % width;
    const y = Math.floor(i / width);
    data[i * 4] = (x * 7 + (seed & 63)) & 255;
    data[i * 4 + 1] = (y * 5 + ((seed >> 6) & 63)) & 255;
    data[i * 4 + 2] = (x ^ y) & 255;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

for (const name of ['420-restart.jpg', '422.jpg', '444.jpg', 'grey.jpg']) {
  test(`the scaled decoder matches jpeg-js on ${name}, at every reduction`, () => {
    const bytes = fixture(name);
    const reference = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
    for (const scale of [1, 2, 4, 8]) {
      const decoded = decodeScaled(bytes, scale);
      const error = difference(decoded, reduceBy(reference, scale));
      // Chroma is upsampled differently (and edge cells see the block padding).
      assert.ok(error < 3, `${name} 1/${scale}: mean error ${error.toFixed(2)}`);
    }
  });
}

test('the scaled decoder refuses what it does not handle, explicitly', () => {
  assert.throws(() => decodeScaled(fixture('progressive.jpg'), 2), UnsupportedJpeg);
  assert.throws(() => decodeScaled(Buffer.from('not a jpeg'), 2), UnsupportedJpeg);
  const truncated = fixture('444.jpg').subarray(0, 300);
  assert.throws(() => decodeScaled(truncated, 2));
});

test('the reduction keeps about the width the images are encoded at', () => {
  assert.equal(chooseScale(3840, 960), 4);
  assert.equal(chooseScale(2688, 960), 2);
  assert.equal(chooseScale(1920, 960), 2);
  assert.equal(chooseScale(1280, 960), 1);
  assert.equal(chooseScale(7680, 960), 8);
});

test('the frame size comes from the header, without decoding', () => {
  assert.deepEqual(jpegSize(fixture('420-restart.jpg')), { width: 173, height: 97 });
  assert.deepEqual(jpegSize(fixture('progressive.jpg')), { width: 173, height: 97 });
  assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 0x00, 0x00])), null);
  assert.ok(isJpeg(fixture('grey.jpg')));
  assert.ok(!isJpeg(Buffer.from('PNG')));
});

test('a snapshot that fits is sent as it is', async () => {
  const bytes = smallJpeg();
  assert.ok(fitsCamera(bytes));
  assert.equal(await fitJpeg(bytes), bytes);
  assert.equal(await toCameraImage(bytes), `${CAMERA_PREFIX}${bytes.toString('base64')}`);
});

test('a large 1080p snapshot is re-encoded under 150 KB, in the worker', async () => {
  const big = Buffer.from(jpeg.encode(noisyFrame(1920, 1080), 90).data);
  assert.ok(!fitsCamera(big), 'the source is too large');
  const image = await toCameraImage(big);
  assert.ok(image.startsWith(CAMERA_PREFIX));
  assert.ok(image.length <= MAX_CAMERA_IMAGE, `${image.length} characters`);
  const decoded = jpeg.decode(Buffer.from(image.slice(CAMERA_PREFIX.length), 'base64'));
  assert.ok(decoded.width <= ATTEMPTS[0].width && decoded.width >= 320);
  assert.equal(Math.round((decoded.width / decoded.height) * 9), 16, 'the aspect ratio is kept');
});

test('a 4K snapshot is read at a reduced size (never decoded in full)', () => {
  const frame = noisyFrame(3840, 2160);
  const big = Buffer.from(jpeg.encode(frame, 70).data);
  const out = convert(big);
  assert.ok(fitsCamera(out));
  assert.deepEqual(jpegSize(out).width <= 960, true);
});

test('a progressive snapshot above 1080p is refused rather than risking the memory', async () => {
  // A header announcing 4096 × 2160 in a progressive frame (SOF2).
  const header = Buffer.from([
    0xff, 0xd8, 0xff, 0xc2, 0x00, 0x11, 0x08, 0x08, 0x70, 0x10, 0x00, 0x03, 0x01, 0x22, 0x00, 0x02,
    0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
  ]);
  const padded = Buffer.concat([header, Buffer.alloc(200 * 1024)]);
  await assert.rejects(fitJpeg(padded), /too large to resize \(4096×2160/);
  await assert.rejects(fitJpeg(Buffer.from('nope')), /not a JPEG/);
});

test('a small progressive snapshot is still converted by jpeg-js', () => {
  const decoded = jpeg.decode(fixture('progressive.jpg'), { useTArray: true, formatAsRGBA: true });
  assert.equal(decoded.width, 173);
  const out = convert(fixture('progressive.jpg'));
  assert.ok(isJpeg(out));
});

test('shrinking averages the pixels each target pixel covers', () => {
  const data = Buffer.from([
    0, 0, 0, 255, 100, 100, 100, 255, 200, 0, 0, 255, 0, 0, 200, 255, 0, 0, 0, 255, 100, 100, 100,
    255, 200, 0, 0, 255, 0, 0, 200, 255,
  ]);
  const out = shrink({ width: 4, height: 2, data }, 2);
  assert.deepEqual([out.width, out.height], [2, 1]);
  assert.deepEqual([...out.data], [50, 50, 50, 255, 100, 0, 100, 255]);
  // Never enlarged.
  assert.equal(shrink({ width: 4, height: 2, data }, 8).width, 4);
});
