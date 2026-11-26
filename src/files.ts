// Checks applied to every file that comes from someone else.
import { open } from 'node:fs/promises';
import { Transform } from 'node:stream';

export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
export const TOO_BIG = 'That file is over 50 MB.';

/** Passes data through, failing once more than `max` bytes have arrived. */
export function limit(max: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _, done) {
      total += chunk.length;
      done(total > max ? new Error(TOO_BIG) : null, chunk);
    },
  });
}

const MAGIC = {
  mp4: [4, '66747970'], jpg: [0, 'ffd8ff'], png: [0, '89504e47'], ogg: [0, '4f676753'], mp3: [0, '494433'],
} as const;

/**
 * Judged by content, so only real media files reach ffmpeg (not, say, playlists that point elsewhere).
 * Returns which kind it is.
 */
export async function fileKind(file: string): Promise<keyof typeof MAGIC> {
  const handle = await open(file);
  try {
    const { buffer } = await handle.read(Buffer.alloc(8), 0, 8, 0);
    for (const [kind, [offset, hex]] of Object.entries(MAGIC)) {
      if (buffer.toString('hex', offset, offset + hex.length / 2) === hex) return kind as keyof typeof MAGIC;
    }
    throw new Error('That file type is not supported.');
  } finally {
    await handle.close();
  }
}
