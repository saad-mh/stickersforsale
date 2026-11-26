// Validation for everything that comes from a message or the web page.
import { normalizeMessageContent, type proto, type WAMessage } from 'baileys';
import { isInstagram } from './download.ts';
import { MAX_SECONDS } from './make.ts';
import { isSoundPage } from './myinstants.ts';

export const USAGE = [
  '*Ambatukam*',
  '',
  'YouTube: .sticker <link> <start> [end]',
  'Video: caption or reply .sticker [start] [end]',
  'Picture: caption or reply .sticker',
  'Picture with sound: caption or reply .sticker <link> <start> [end]',
  'Silent video or GIF: .s mute',
  'Instagram reel: .s <link> [start] [end]',
  'Video address: .s <https link ending in .mp4> [start] [end]',
  'MyInstants sound: caption or reply to a picture or video with .s <myinstants link>',
  '',
  'Your voice as the sound: send a voice note, then reply to it with a picture or video captioned .s',
  'Add audio loop (repeat it), audio cut (stop when it ends) or audio once (default).',
  '',
  'Effects: .s fx slow 0.5 | fast 2 | deep | chipmunk | bass | echo | reverse',
  'They can be combined: .s fx slow 0.7 echo',
  '',
  'Example: .sticker https://youtu.be/xyz 1:12 1:17',
  'Times are seconds or m:ss. Clips are 5 s by default, 10 s at most.',
  '.s is short for .sticker. !, # and / work in place of the dot.',
  'Send .help to see this again.',
  '',
  'Happy bussing!',
].join('\n');

export const HELP = /^\s*[.!#/]help\s*$/i;

/** Cheap check so that ordinary chat is dropped without further work. */
export const COMMAND = /^\s*[.!#/](sticker|s)(\s|$)/i;

const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
const DEFAULT_SECONDS = 5;

export type Effect = 'deep' | 'chipmunk' | 'bass' | 'echo';
export type Options = {
  mute?: true;
  /** What a voice note does when it is shorter than the video. */
  audio?: 'once' | 'loop' | 'cut';
  speed?: number;
  reverse?: true;
  effects?: Effect[];
};
export type Range = { start: number; seconds: number };
/** `soundOnly` links (MyInstants) have no picture of their own; `direct` ones are plain MP4 files. */
export type Clip = Range & { url: string; soundOnly?: true; direct?: true };

/** "72", "72.5", "1:12" or "1:02:03" to seconds. */
export function parseTime(text: string): number {
  if (!/^(\d+:){0,2}\d+(\.\d+)?$/.test(text)) throw new Error(`"${text}" is not a time. Use 72 or 1:12.`);
  return text.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

function parseRange(start: string, end?: string): Range {
  const from = parseTime(start);
  const seconds = end ? parseTime(end) - from : DEFAULT_SECONDS;
  if (!(seconds >= 0.2)) throw new Error('The end must be after the start.');
  if (seconds > MAX_SECONDS) throw new Error(`Clips can be at most ${MAX_SECONDS} seconds.`);
  return { start: from, seconds };
}

const isVideoFile = (url: URL) => url.protocol === 'https:' && /\.mp4$/i.test(url.pathname);

export function parseClip(url: string, start: string, end?: string): Clip {
  const parsed = URL.parse(url);
  const soundOnly = !!parsed && isSoundPage(parsed);
  const site = !!parsed && /^https?:$/.test(parsed.protocol) &&
    (soundOnly || HOSTS.has(parsed.hostname) || isInstagram(parsed));
  const direct = !site && !!parsed && isVideoFile(parsed);
  if (!parsed || !(site || direct)) {
    throw new Error('Only YouTube, Instagram, MyInstants and https .mp4 links are accepted.');
  }
  return { url: parsed.href, ...parseRange(start, end), ...soundOnly && { soundOnly }, ...direct && { direct } };
}

const EFFECTS: readonly string[] = ['deep', 'chipmunk', 'bass', 'echo'];
// [lowest, highest, default]
const SPEEDS: Record<string, [number, number, number]> = { slow: [0.25, 0.99, 0.5], fast: [1.01, 4, 2] };

/** Takes the option words out of the arguments, leaving the link and times. */
function parseOptions(args: string[]): { options: Options; rest: string[] } {
  const options: Options = {};
  const rest: string[] = [];
  const word = (i: number) => args[i]?.toLowerCase() ?? '';
  for (let i = 0; i < args.length; i++) {
    if (word(i) === 'mute') options.mute = true;
    else if (word(i) === 'audio') {
      const mode = word(++i);
      if (mode !== 'once' && mode !== 'loop' && mode !== 'cut') throw new Error('Use audio loop, audio cut or audio once.');
      options.audio = mode;
    } else if (word(i) === 'fx') {
      let found = 0;
      for (; ; found++) {
        const name = word(i + 1);
        if (Object.hasOwn(SPEEDS, name)) {
          i++;
          const [low, high, usual] = SPEEDS[name]!;
          const factor = /^(\d+(\.\d+)?|\.\d+)$/.test(word(i + 1)) ? Number(args[++i]) : usual;
          if (!(factor >= low && factor <= high)) throw new Error(`${name} takes ${low} to ${high}, for example ${name} ${usual}.`);
          options.speed = factor;
        } else if (name === 'reverse') {
          i++;
          options.reverse = true;
        } else if (EFFECTS.includes(name)) {
          i++;
          options.effects = [...new Set([...options.effects ?? [], name as Effect])];
        } else break;
      }
      if (!found) throw new Error('Effects: slow, fast, deep, chipmunk, bass, echo, reverse.');
    } else rest.push(args[i]!);
  }
  if (options.mute && (options.audio || options.effects)) throw new Error('mute has no sound, so audio options and sound effects do not apply.');
  return { options, rest };
}

/**
 * null when the message is not a command; throws when it is one but malformed.
 * A result without `url` refers to an attached or replied-to video.
 */
export function parseCommand(text: string): (Options & (Clip | (Range & { url?: undefined }))) | null {
  if (!COMMAND.test(text)) return null;
  const { options, rest: args } = parseOptions(text.trim().split(/\s+/).slice(1));
  if (args[0]?.includes(':/')) {
    // MyInstants sounds, reels and video files are usually short, so their times are optional.
    const url = URL.parse(args[0]);
    if (args.length > 3 || (args.length < 2 && !(url && (isSoundPage(url) || isInstagram(url) || isVideoFile(url))))) throw new Error(USAGE);
    return { ...parseClip(args[0], args[1] ?? '0', args[2]), ...options };
  }
  if (args.length > 2) throw new Error(USAGE);
  return { ...parseRange(args[0] ?? '0', args[1]), ...options };
}

export type Media = {
  message: WAMessage;
  type: 'video' | 'image' | 'audio';
  size: number;
  /** The voice note that the attached video or picture replies to. */
  voice?: Media;
};

type Content = ReturnType<typeof normalizeMessageContent>;

function toMedia(message: WAMessage, content: Content, context?: proto.IContextInfo | null): Media | null {
  const type = content?.videoMessage ? 'video' : content?.imageMessage ? 'image' : content?.audioMessage ? 'audio' : null;
  if (!type) return null;
  const key = context
    ? { remoteJid: message.key.remoteJid, id: context.stanzaId, participant: context.participant }
    : message.key;
  return { message: { key, message: content }, type, size: Number(content![`${type}Message`]!.fileLength) };
}

/** The video or picture attached to the command, or else the one it replies to. */
export function findMedia(message: WAMessage): Media | null {
  const content = normalizeMessageContent(message.message);
  const attached = content?.videoMessage || content?.imageMessage;
  if (attached) {
    const context = attached.contextInfo;
    const quoted = normalizeMessageContent(context?.quotedMessage);
    const voice = quoted?.audioMessage ? toMedia(message, quoted, context)! : undefined;
    return { ...toMedia(message, content)!, ...voice && { voice } };
  }
  const context = content?.extendedTextMessage?.contextInfo;
  const media = toMedia(message, normalizeMessageContent(context?.quotedMessage), context);
  return media?.type === 'audio' ? null : media;
}

/** What the sender typed, whether as a message or as the caption of a video or picture. */
export function messageText(message: WAMessage): string {
  const content = normalizeMessageContent(message.message);
  return content?.conversation || content?.extendedTextMessage?.text ||
    content?.videoMessage?.caption || content?.imageMessage?.caption || '';
}

/** True if any of the sender's IDs is the owner's phone number. */
export function isOwner(senderJids: (string | null | undefined)[], ownerNumber: string): boolean {
  // Device suffixes look like 15551234567:12@s.whatsapp.net.
  return senderJids.some(jid => jid?.replace(/:\d+@/, '@') === `${ownerNumber}@s.whatsapp.net`);
}
