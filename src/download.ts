// Fetches part of a YouTube or Instagram video with yt-dlp.
// Instagram is tried without a login first; the spare account is used only when Instagram demands one.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { isMissing } from './tools.ts';

const exec = promisify(execFile);
export type Run = (args: string[]) => Promise<{ stdout: string }>;
const ytDlp: Run = args => exec('yt-dlp', args, { timeout: 180_000 });

// Anyone in the group can make the bot use the account, so cap how often to lower the ban risk.
export const LOGINS_PER_HOUR = 10;
let logins: number[] = [];

export function isInstagram(url: URL): boolean {
  return /^(www\.)?instagram\.com$/.test(url.hostname) && /\/(reel|reels|p|tv)\/[\w-]+/.test(url.pathname);
}

export function needsLogin(stderr: string): boolean {
  return /log ?in|logged.in|rate.limit|empty media response|registered users|restricted/i.test(stderr);
}

/** IG_COOKIES is either a cookies.txt file or a browser such as "firefox:spare". */
export function cookieArgs(value: string): string[] {
  return [existsSync(value) ? '--cookies' : '--cookies-from-browser', value];
}

const stderrOf = (error: unknown) => (error as { stderr?: string }).stderr || (error as Error).message;

/** Returns the downloaded file's path. */
export async function download(
  { url, start, seconds }: { url: string; start: number; seconds: number },
  dir: string, ffmpegPath: string, run: Run = ytDlp, cookies = process.env.IG_COOKIES,
): Promise<string> {
  const args = (login: string[]) => ['--ignore-config', '--no-playlist', '--no-progress',
    ...ffmpegPath.includes('/') ? ['--ffmpeg-location', ffmpegPath] : [], ...login,
    '--download-sections', `*${start}-${start + seconds}`, '--force-keyframes-at-cuts',
    // "res" is the shorter side, so this also suits vertical video.
    '-f', 'bv*+ba/b', '-S', 'res:720', '-o', join(dir, 'clip.%(ext)s'), '--print', 'after_move:filepath', '--', url];

  let result;
  try {
    result = await run(args([]));
  } catch (error) {
    const stderr = stderrOf(error);
    console.error(stderr);
    if (isMissing(error)) throw new Error('yt-dlp is not installed where the bot runs.');
    const instagram = isInstagram(new URL(url));
    if (!instagram || !needsLogin(stderr)) {
      throw new Error(/^ERROR: .*$/m.exec(stderr)?.[0] ?? 'The download failed or took too long.');
    }
    if (!cookies) throw new Error('Instagram wants a login for that post, and none is set up.');
    logins = logins.filter(time => Date.now() - time < 3_600_000);
    if (logins.length >= LOGINS_PER_HOUR) throw new Error('Instagram login limit reached. Try again in an hour.');
    logins.push(Date.now());
    try {
      result = await run(args(cookieArgs(cookies)));
    } catch (retry) {
      // These errors can name local files, so only the terminal gets the detail.
      console.error(stderrOf(retry));
      throw new Error('Instagram did not allow that download, even when signed in.');
    }
  }
  const file = result.stdout.trim();
  if (!file) throw new Error('Nothing was downloaded. Check the link and the start time.');
  return file;
}
