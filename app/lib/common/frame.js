// Length-prefixed framing used on the broker <-> server unix socket.
//   frame := u32be length(rest) | u8 kind | body
//   kind 0 : JSON (utf8)
//   kind 1 : data  : u8 idLen | id (ascii) | f64be seq | bytes
// A single reader handles partial and coalesced chunks.

export const KIND_JSON = 0;
export const KIND_DATA = 1;
const MAX_FRAME = 64 * 1024 * 1024;

export function encodeJson(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.allocUnsafe(5);
  head.writeUInt32BE(body.length + 1, 0);
  head.writeUInt8(KIND_JSON, 4);
  return Buffer.concat([head, body]);
}

export function encodeData(id, seq, bytes) {
  const idb = Buffer.from(id, 'ascii');
  const head = Buffer.allocUnsafe(5 + 1 + idb.length + 8);
  head.writeUInt32BE(1 + 1 + idb.length + 8 + bytes.length, 0);
  head.writeUInt8(KIND_DATA, 4);
  head.writeUInt8(idb.length, 5);
  idb.copy(head, 6);
  head.writeDoubleBE(seq, 6 + idb.length);
  return Buffer.concat([head, bytes]);
}

export class FrameReader {
  constructor(onJson, onData) {
    this.onJson = onJson;
    this.onData = onData;
    this.chunks = [];
    this.len = 0;
  }
  push(chunk) {
    this.chunks.push(chunk);
    this.len += chunk.length;
    while (this.len >= 4) {
      const buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
      this.chunks = [buf];
      const n = buf.readUInt32BE(0);
      if (n < 1 || n > MAX_FRAME) throw new Error('bad frame length ' + n);
      if (buf.length < 4 + n) return;
      const kind = buf.readUInt8(4);
      const body = buf.subarray(5, 4 + n);
      const rest = buf.subarray(4 + n);
      this.chunks = rest.length ? [rest] : [];
      this.len = rest.length;
      if (kind === KIND_JSON) {
        this.onJson(JSON.parse(body.toString('utf8')));
      } else if (kind === KIND_DATA) {
        const idLen = body.readUInt8(0);
        const id = body.toString('ascii', 1, 1 + idLen);
        const seq = body.readDoubleBE(1 + idLen);
        this.onData(id, seq, Buffer.from(body.subarray(1 + idLen + 8)));
      }
    }
  }
}
