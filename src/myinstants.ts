// Downloads the sound behind a MyInstants page.
const SOUNDS = 'https://www.myinstants.com/media/sounds/';
const HOSTS = new Set(['myinstants.com', 'www.myinstants.com']);

export function isSoundPage(url: URL): boolean {
  return HOSTS.has(url.hostname) && /\/instant\/[^/]+/.test(url.pathname);
}

/** The audio address named by the page, only if it points at MyInstants' own sound folder. */
export function findSound(html: string): string {
  const found = /<meta property="og:audio" content="([^"]+)"/.exec(html)?.[1];
  const sound = found && URL.parse(found)?.href;
  if (!sound?.startsWith(SOUNDS)) throw new Error('Could not find a sound on that MyInstants page.');
  return sound;
}

/** MP3, Ogg or WAV, judged by content, so ffmpeg is never handed something like a playlist. */
export function isAudio(data: Buffer): boolean {
  const head = data.toString('latin1', 0, 4);
  return head.startsWith('ID3') || head === 'OggS' || head === 'RIFF' || (data[0] === 0xff && (data[1]! & 0xe0) === 0xe0);
}

async function download(url: string, maxBytes: number): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !HOSTS.has(new URL(response.url).hostname)) throw new Error('MyInstants did not return that sound.');
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const part of response.body!) {
    total += part.length;
    if (total > maxBytes) throw new Error('That MyInstants file is too big.');
    parts.push(part);
  }
  return Buffer.concat(parts);
}

export async function fetchSound(pageUrl: string): Promise<Buffer> {
  const page = await download(pageUrl, 1_000_000);
  const sound = await download(findSound(page.toString('utf8')), 5_000_000);
  if (!isAudio(sound)) throw new Error('That MyInstants file is not a supported sound.');
  return sound;
}
