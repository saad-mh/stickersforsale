// A video, picture or voice note sent in the chat: download it, then make the sticker.
import { downloadMediaMessage } from 'baileys';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileKind, limit, MAX_MEDIA_BYTES, TOO_BIG } from './files.ts';
import type { Clip, Media, Options, Range } from './input.ts';
import { makeFromUrl, makeSticker, makeStill, type Made } from './make.ts';
import { fetchSound } from './myinstants.ts';

const ALLOWED: Record<Media['type'], string[]> = { video: ['mp4'], image: ['jpg', 'png'], audio: ['ogg', 'mp4', 'mp3'] };

/** Downloads the file to a temporary folder, passes it to `use`, then deletes it. */
async function withMedia<T>(media: Media, use: (file: string) => Promise<T>): Promise<T> {
  if (media.size > MAX_MEDIA_BYTES) throw new Error(TOO_BIG);
  const dir = await mkdtemp(join(tmpdir(), 'sticker-media-'));
  try {
    const download = join(dir, 'download');
    const stream = await downloadMediaMessage(media.message, 'stream', {}) as Readable;
    await pipeline(stream, limit(MAX_MEDIA_BYTES), createWriteStream(download),
      { signal: AbortSignal.timeout(120_000) });
    const kind = await fileKind(download);
    if (!ALLOWED[media.type].includes(kind)) throw new Error('That file type is not supported.');
    // ffmpeg reads pictures more reliably with the matching extension.
    const file = `${download}.${kind}`;
    await rename(download, file);
    return await use(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Runs `use` with the MyInstants sound saved to a temporary file. */
async function withSound<T>(url: string, use: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'sticker-sound-'));
  try {
    const file = join(dir, 'sound');
    await writeFile(file, await fetchSound(url));
    return await use(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * A voice note or MyInstants sound, when there is one, becomes the sound. Otherwise a video keeps its own sound,
 * and a picture gets the sound of a YouTube `clip` or is a silent sticker.
 */
export function makeFromMedia(media: Media, command: Range & Options, clip?: Clip & Options): Promise<Made> {
  return withMedia(media, async file => {
    const visual = media.type === 'video' ? { video: file } : { picture: file };
    if (media.voice) return withMedia(media.voice, sound => makeSticker({ ...visual, sound }, command));
    if (clip?.soundOnly) return withSound(clip.url, sound => makeSticker({ ...visual, sound }, command));
    if (media.type === 'video') return makeSticker(visual, command);
    if (clip && !clip.mute) return makeFromUrl(clip, file);
    if (command.effects || command.speed || command.reverse) throw new Error('Effects need sound: add a link or use a voice note.');
    return { sticker: await makeStill(file) };
  });
}
