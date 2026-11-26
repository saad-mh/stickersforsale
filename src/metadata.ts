// The name WhatsApp shows in a sticker's details, stored as JSON in the WebP's EXIF chunk.
// Format follows coelhobugado/whatsapp-figurinhas-com-som (src/webp.ts), MIT.
import { randomUUID } from 'node:crypto';

function chunk(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(type, 'ascii');
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload, Buffer.alloc(payload.length % 2)]);
}

/** For a 512x512 WebP that has no EXIF yet, which is what ffmpeg produces here. */
export function addPackName(webp: Buffer, name: string): Buffer {
  const json = Buffer.from(JSON.stringify({
    'sticker-pack-id': randomUUID(), 'sticker-pack-name': name, 'sticker-pack-publisher': '', emojis: [''],
  }));
  // Minimal TIFF: one entry, tag 0x5741, with the JSON at offset 22.
  const tiff = Buffer.from('49492a00080000000100415707000000000016000000', 'hex');
  tiff.writeUInt32LE(json.length, 14);

  let body = Buffer.from(webp.subarray(12));
  // The EXIF flag lives in a VP8X header; single-frame files may not have one.
  if (body.toString('ascii', 0, 4) !== 'VP8X') {
    const vp8x = Buffer.alloc(10);
    vp8x.writeUIntLE(511, 4, 3);
    vp8x.writeUIntLE(511, 7, 3);
    body = Buffer.concat([chunk('VP8X', vp8x), body]);
  }
  body[8]! |= 0x08;
  const out = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP'), body, chunk('EXIF', Buffer.concat([tiff, json]))]);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}
