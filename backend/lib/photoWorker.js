const { parentPort } = require('worker_threads');
const { uprightJpeg, fitJpeg } = require('./imageOrientation');

// The other end of lib/photos.js. Everything that decodes a photograph runs here, on a thread of
// its own, so that the thread answering requests never stops to do it.

// A fresh copy whose memory can be handed to the main thread rather than copied to it. jpeg-js may
// hand back a slice of a shared pool, and a pool cannot be given away.
const owned = buffer => {
  const copy = new Uint8Array(buffer.length);
  copy.set(buffer);
  return copy;
};

parentPort.on('message', ({ id, op, bytes, options }) => {
  try {
    const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    if (op === 'upright') {
      const result = uprightJpeg(input);
      // An untouched photo is reported as such and not sent back: the caller still has it.
      if (!result.rotated) {
        parentPort.postMessage({ id, ok: true, changed: false, width: result.width, height: result.height });
        return;
      }
      const out = owned(result.buffer);
      parentPort.postMessage(
        { id, ok: true, changed: true, bytes: out, width: result.width, height: result.height },
        [out.buffer],
      );
      return;
    }

    if (op === 'fit') {
      const result = fitJpeg(input, options || undefined);
      if (result === input) {
        parentPort.postMessage({ id, ok: true, changed: false });
        return;
      }
      const out = owned(result);
      parentPort.postMessage({ id, ok: true, changed: true, bytes: out }, [out.buffer]);
      return;
    }

    parentPort.postMessage({ id, ok: false, error: `unknown photo operation: ${op}` });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
});
