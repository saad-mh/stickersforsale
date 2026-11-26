// Turns part of a local video into the two files a sound sticker needs.
// ffmpeg settings follow coelhobugado/whatsapp-figurinhas-com-som (src/convert.ts), MIT.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { downloadDirect } from './direct.ts';
import { download } from './download.ts';
import type { Clip, Effect, Options, Range } from './input.ts';
import { addPackName } from './metadata.ts';
import { FFMPEG, FFPROBE, isMissing } from './tools.ts';

const run = promisify(execFile);
export { FFMPEG };

export const MAX_SECONDS = 10;
/** Without `audio` it is an ordinary silent sticker. */
export type Made = { sticker: Buffer; audio?: Buffer; durationMs?: number; animated?: boolean };
const MAX_WEBP_BYTES = 498_000; // WhatsApp's 500 KB, less room for the EXIF name
const PACK_NAME = process.env.STICKER_NAME || 'S.';
// [fps, quality, detail], best first.
const LADDER = [[15, 60, 512], [12, 50, 512], [10, 45, 448], [10, 35, 384], [8, 30, 320], [6, 25, 256], [5, 20, 192]];

async function ffmpeg(args: string[], failure = 'Could not convert that file.') {
  try {
    await run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...args], { timeout: 120_000 });
  } catch (error) {
    // The raw error holds local paths and is sent to the chat, so keep it in the terminal.
    console.error((error as Error).message);
    throw new Error(isMissing(error) ? 'ffmpeg is not installed where the bot runs.' : failure);
  }
}

async function duration(file: string): Promise<number> {
  const { stdout } = await run(FFPROBE,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 30_000 });
  return Number(stdout);
}

const SOUND_EFFECTS: Record<Effect, string> = {
  // Changing the sample rate shifts the pitch; atempo then restores the length.
  deep: 'aresample=48000,asetrate=36000,aresample=48000,atempo=1.333333',
  chipmunk: 'aresample=48000,asetrate=72000,aresample=48000,atempo=0.666667',
  bass: 'bass=g=15,alimiter=limit=0.9',
  echo: 'aecho=0.8:0.88:90:0.45',
};

// Brings quiet voice notes and loud clips to a similar volume.
const LEVEL = 'loudnorm=I=-16:TP=-1.5:LRA=11';

function audioFilters({ reverse, speed = 1, effects = [] }: Options): string[] {
  // One atempo step cannot go below 0.5.
  const tempo = speed === 1 ? [] : speed < 0.5 ? ['atempo=0.5', `atempo=${speed / 0.5}`] : [`atempo=${speed}`];
  return [...reverse ? ['areverse'] : [], ...tempo, ...effects.map(effect => SOUND_EFFECTS[effect]), LEVEL];
}

const SQUARE = 'scale=512:512:force_original_aspect_ratio=increase,crop=512:512';

/** A picture as a still sticker. WhatsApp's limit for these is 100 KB. */
export async function makeStill(picture: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'sticker-still-'));
  try {
    const webp = join(dir, 'sticker.webp');
    for (const quality of [80, 65, 50, 35, 20]) {
      await ffmpeg(['-i', picture, '-frames:v', '1', '-vf', `${SQUARE},setsar=1,format=yuv420p`,
        '-c:v', 'libwebp', '-quality', String(quality), '-f', 'webp', webp]);
      if ((await stat(webp)).size <= 98_000) return addPackName(await readFile(webp), PACK_NAME);
    }
    throw new Error('Could not get that picture under 100 KB.');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Downloads only the requested part of a video. With `picture`, only its sound is used. */
export async function makeFromUrl(clip: Clip & Options, picture?: string): Promise<Made> {
  if (clip.soundOnly) throw new Error('A MyInstants sound needs a picture or video: caption or reply to one with the link.');
  const dir = await mkdtemp(join(tmpdir(), 'sticker-dl-'));
  try {
    // yt-dlp fetches only the requested part; a video file arrives whole.
    const file = clip.direct ? await downloadDirect(clip.url, dir) : await download(clip, dir, FFMPEG);
    const start = clip.direct ? clip.start : 0;
    return await makeSticker(picture ? { picture, sound: file } : { video: file }, { ...clip, start, soundStart: start });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * `video` or `picture` is what you see. `sound` replaces the video's own audio
 * (a voice note, or a downloaded clip for a picture) and is read from its start.
 */
export async function makeSticker(
  { video, picture, sound }: { video?: string; picture?: string; sound?: string },
  settings: Range & Options & { soundStart?: number },
): Promise<Made> {
  const { start, mute, audio: mode = 'once', speed = 1, reverse } = settings;
  const seconds = Math.min(settings.seconds, MAX_SECONDS);
  const tooShort = 'The clip is empty or shorter than 0.2 s. Check the start time.';
  const dir = await mkdtemp(join(tmpdir(), 'sticker-'));
  try {
    const available = video ? Math.min(seconds, await duration(video) - start) : seconds;
    if (!(available >= 0.2)) throw new Error(tooShort);
    let length = Math.min(MAX_SECONDS, available / speed);

    let audio: Buffer | undefined;
    if (!mute) {
      // First the sound with its effects, then fit it to the sticker's length.
      const track = join(dir, 'track.wav');
      const from = sound ? ['-ss', String(settings.soundStart ?? 0), '-t', String(seconds), '-i', sound] : ['-ss', String(start), '-t', String(available), '-i', video!];
      const filters = audioFilters(settings);
      await ffmpeg([...from, '-map', '0:a:0', '-vn', '-af', filters.join(','),
        '-ac', '1', '-ar', '48000', track], 'Could not read any sound. For silent videos and GIFs use .s mute');
      const trackLength = await duration(track);
      if (!(trackLength >= 0.2)) throw new Error(tooShort);
      // A picture has no length of its own, so it follows the sound unless that loops.
      if (picture) length = Math.min(MAX_SECONDS, mode === 'loop' ? seconds / speed : trackLength);
      else if (mode === 'cut') length = Math.min(length, trackLength);

      const ogg = join(dir, 'audio.ogg');
      await ffmpeg([...mode === 'loop' ? ['-stream_loop', '-1'] : [], '-i', track,
        ...mode === 'loop' ? [] : ['-af', 'apad'], '-t', String(length), '-c:a', 'libopus', '-b:a', '64k',
        '-map_metadata', '-1', '-f', 'ogg', ogg]);
      audio = await readFile(ogg);
    }
    const durationMs = Math.round(length * 1000);
    if (picture) return { sticker: await makeStill(picture), audio, durationMs };

    const webp = join(dir, 'sticker.webp');
    for (const [fps, quality, detail] of LADDER) {
      const filter = [speed === 1 ? '' : `setpts=PTS/${speed}`, `fps=${fps}`, SQUARE, reverse ? 'reverse' : '',
        `scale=${detail}:${detail},scale=512:512,setsar=1,format=yuv420p`].filter(Boolean).join(',');
      await ffmpeg(['-ss', String(start), '-t', String(available), '-i', video!, '-map', '0:v:0', '-an',
        '-vf', filter, '-t', String(length), '-c:v', 'libwebp_anim',
        '-lossless', '0', '-quality', String(quality), '-loop', '0', '-f', 'webp', webp]);
      if ((await stat(webp)).size <= MAX_WEBP_BYTES) {
        return { sticker: addPackName(await readFile(webp), PACK_NAME), audio, durationMs, animated: true };
      }
    }
    throw new Error('Could not get the sticker under 500 KB. Try a shorter clip.');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
