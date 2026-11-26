// Where the external programs are, and whether they work.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Homebrew's plain ffmpeg has no WebP encoder; ffmpeg-full does but is not on PATH.
const FULL = ['/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg', '/usr/local/opt/ffmpeg-full/bin/ffmpeg'].find(existsSync);
export const FFMPEG = process.env.FFMPEG_PATH || FULL || 'ffmpeg';
export const FFPROBE = FFMPEG.replace(/ffmpeg$/, 'ffprobe');

export const isMissing = (error: unknown) => (error as { code?: string }).code === 'ENOENT';

/** One warning per problem. Nothing here stops the bot: the rest keeps working. */
export async function checkTools(ffmpeg = FFMPEG, ffprobe = FFPROBE, ytDlp = 'yt-dlp'): Promise<string[]> {
  const warnings: string[] = [];
  try {
    const { stdout } = await run(ffmpeg, ['-hide_banner', '-encoders']);
    const absent = ['libwebp_anim', 'libopus'].filter(encoder => !stdout.includes(encoder));
    if (absent.length) warnings.push(`ffmpeg lacks ${absent.join(' and ')}: some or all stickers will fail.`);
  } catch {
    warnings.push('ffmpeg was not found: stickers cannot be made. Install it or set FFMPEG_PATH.');
  }
  await run(ffprobe, ['-version']).catch(() => warnings.push('ffprobe was not found: sound and animated stickers will fail.'));
  await run(ytDlp, ['--version']).catch(() => warnings.push('yt-dlp was not found: YouTube and Instagram links will fail.'));
  return warnings;
}
