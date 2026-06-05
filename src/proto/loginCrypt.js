'use strict';

const { Blowfish } = require('./blowfish');

const STATIC_KEY = Buffer.from([
  0x6b, 0x60, 0xcb, 0x5b, 0x82, 0xce, 0x90, 0xb1,
  0xcc, 0x2b, 0x6c, 0x55, 0x6c, 0x6c, 0x6c, 0x6c
]);
const STATIC_BF = new Blowfish(STATIC_KEY);

// Decrypt the Init packet from the login server.
// data = raw payload bytes AFTER the 2-byte size prefix.
function decryptInit(data) {
  const buf = Buffer.from(STATIC_BF.decryptECB(data));

  // Reverse XOR pass:
  // encXORPass writes evolved key at (len-8), XOR'd region is [4..len-9].
  const stopPos = buf.length - 8;
  let pk = buf.readInt32LE(stopPos);
  for (let pos = stopPos - 4; pos >= 4; pos -= 4) {
    const enc = buf.readInt32LE(pos);
    const orig = enc ^ pk;
    pk = (pk - orig) | 0;
    buf.writeInt32LE(orig, pos);
  }
  return buf;
}

// Encrypt a client→server login packet with the session blowfish key.
// data = opcode byte + payload (already assembled, no padding needed).
function encryptPacket(sessionBF, data) {
  // Compute padded size: data.length + 4 (dynamic header), aligned to 8, +8 (checksum area)
  let sz = data.length + 4;
  const rem = sz % 8;
  if (rem !== 0) sz += (8 - rem);
  sz += 8;

  const buf = Buffer.alloc(sz, 0);
  data.copy(buf, 0);

  // Append checksum: XOR all int32s except last 4 bytes, store at sz-4
  let checksum = 0;
  for (let i = 0; i < sz - 4; i += 4) {
    checksum ^= buf.readInt32LE(i);
  }
  buf.writeInt32LE(checksum, sz - 4);

  return sessionBF.encryptECB(buf);
}

// Decrypt a server→client login packet (after Init) with session key.
// data = raw payload bytes after the 2-byte size prefix.
function decryptPacket(sessionBF, data) {
  const buf = Buffer.from(sessionBF.decryptECB(data));
  // Verify checksum (optional for client, just parse)
  return buf;
}

module.exports = { decryptInit, encryptPacket, decryptPacket };
