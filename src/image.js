// -----------------------------------------------------------------------------
// Camera snapshots, made to fit Gladys.
//
// Gladys takes camera images as an `image/jpg;base64,…` string of 150 KB at
// most (the whole string, SDK MAX_CAMERA_IMAGE_SIZE), and widget images of
// 300 KB decoded. A Protect snapshot is a JPEG of the camera resolution, often
// larger, and the Integration API cannot ask for a smaller one. So the
// integration re-encodes it when needed: decode, shrink by averaging (a box
// filter, no aliasing), encode again, smaller each round until it fits.
//
// In pure JavaScript: no native module, no ffmpeg. The sandbox has 256 MB and
// the event loop carries the Gladys acknowledgements, so:
//   - the frame is decoded straight at 1/2, 1/4 or 1/8 of its size by a small
//     baseline decoder (src/jpeg-scaled.js): a few megabytes even in 4K, where
//     a general decoder (jpeg-js) needs about 50 bytes per pixel (measured:
//     +110 MB for a 1080p frame, +370 MB for a 4K one). jpeg-js only encodes,
//     and decodes the rare file the small decoder refuses, up to 1080p;
//   - the conversion runs in a worker thread (src/image-worker.js), one at a
//     time, and the worker is ended after each one: its memory goes back at
//     once instead of waiting for the garbage collector.
// -----------------------------------------------------------------------------

import { Worker } from 'node:worker_threads';

export const CAMERA_PREFIX = 'image/jpg;base64,';
export const MAX_CAMERA_IMAGE = 150 * 1024; // the full string, prefix included

// What jpeg-js may decode in full: 1920 × 1088 (1080p is coded on 1088 lines).
export const MAX_DECODED_PIXELS = 1920 * 1088;

// A stuck conversion must not hold the queue.
const WORKER_TIMEOUT_MS = 20_000;

/** The `image/jpg;base64,…` string of JPEG bytes. */
export const asCameraImage = (bytes) => `${CAMERA_PREFIX}${Buffer.from(bytes).toString('base64')}`;

export const fitsCamera = (bytes) =>
  CAMERA_PREFIX.length + Math.ceil(bytes.length / 3) * 4 <= MAX_CAMERA_IMAGE;

export const isJpeg = (bytes) =>
  Buffer.isBuffer(bytes) && bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;

/**
 * The frame size of a JPEG, read from its SOF marker without decoding.
 * @returns {{ width: number, height: number } | null}
 */
export function jpegSize(bytes) {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) {
      return null;
    }
    const marker = bytes[at + 1];
    if (marker === 0xff) {
      at += 1; // fill byte
      continue;
    }
    // SOF0 to SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    }
    if (marker === 0xda) {
      return null; // image data before any frame header
    }
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  return null;
}

/** Run one conversion in a fresh worker, ended once it answered. */
function convertInWorker(bytes) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./image-worker.js', import.meta.url), {
      workerData: bytes,
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('The snapshot conversion timed out'));
    }, WORKER_TIMEOUT_MS);
    const settle = (fn, value) => {
      clearTimeout(timer);
      worker.terminate();
      fn(value);
    };
    worker.once('message', (message) =>
      message.error
        ? settle(reject, new Error(message.error))
        : settle(resolve, Buffer.from(message.bytes)),
    );
    worker.once('error', (err) => settle(reject, err));
    worker.once('exit', (code) =>
      settle(reject, new Error(`The snapshot conversion stopped (${code})`)),
    );
  });
}

// One conversion at a time: each holds a decoded frame in memory.
let queue = Promise.resolve();

/**
 * JPEG bytes that fit a Gladys camera image (≤ 150 KB as base64 with its
 * prefix), re-encoded only when needed.
 * @param {Buffer} bytes a JPEG
 * @returns {Promise<Buffer>}
 */
export function fitJpeg(bytes) {
  if (!isJpeg(bytes)) {
    return Promise.reject(new Error('The snapshot is not a JPEG image'));
  }
  if (fitsCamera(bytes)) {
    return Promise.resolve(bytes);
  }
  const run = queue.then(() => convertInWorker(bytes));
  // The next conversion waits for this one, whatever its outcome.
  queue = run.catch(() => {});
  return run;
}

/** The snapshot as Gladys takes camera images. */
export async function toCameraImage(bytes) {
  return asCameraImage(await fitJpeg(bytes));
}
