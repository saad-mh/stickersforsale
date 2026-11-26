// Decides what to do with each incoming WhatsApp message.
import type { WAMessage, WASocket } from 'baileys';
import { COMMAND, findMedia, HELP, isOwner, messageText, parseCommand, USAGE } from './input.ts';
import { makeFromUrl, type Made } from './make.ts';
import { makeFromMedia } from './media.ts';

const WAITING_LINES = [
  'Cooking up your sticker real quick',
  'Summoning your sticker from the void',
  'Pixelating your chaos',
  'Sticker factory is online, hold tight',
  'One sec, just arguing with the AI about your face',
  'Brewing your sticker potion',
  'Your sticker is currently in the microwave',
  'The sticker council is currently reviewing your application',
  'I’m currently teaching the pixels how to behave',
];

export type Deliver = (make: () => Promise<Made>, target: string, quoted?: WAMessage) => Promise<void>;

/** `owner` and `group` may each be empty, which simply grants nothing through it. */
export function createHandler({ owner, group, deliver }: { owner: string; group: string; deliver: Deliver }) {
  const busy = new Set<string>(); // one pending sticker per person, so nobody can fill the queue alone
  const seen = new Set<string>();

  return async function onMessage(sock: WASocket, message: WAMessage): Promise<void> {
    const { key } = message;
    const chat = key.remoteJid;
    if (!chat || !key.id || key.fromMe || seen.has(key.id)) return;
    // Ignore old messages delivered after the bot was offline.
    if (Date.now() / 1000 - Number(message.messageTimestamp) > 300) return;
    const text = messageText(message);
    const help = HELP.test(text);
    if (!help && !COMMAND.test(text)) return;

    // Anyone in the chosen group may use the bot; elsewhere, only the owner.
    if (chat !== group) {
      if (!owner) return;
      // WhatsApp may identify the sender by a hidden "LID" instead of the phone number.
      const ids = chat.endsWith('@g.us') ? [key.participant, key.participantAlt] : [chat, key.remoteJidAlt];
      const lid = ids.find(id => id?.endsWith('@lid'));
      if (lid) ids.push(await sock.signalRepository.lidMapping.getPNForLID(lid));
      if (!isOwner(ids, owner)) return;
    }

    if (seen.size > 1000) seen.clear();
    seen.add(key.id);
    // A text reply that fails to send must not stop the sticker or the bot.
    const reply = async (body: string) => {
      await sock.sendMessage(chat, { text: body }, { quoted: message })
        .catch((error: Error) => console.error('Could not reply:', error.message));
    };
    if (help) return reply(USAGE);
    const sender = key.participant || chat;
    if (busy.has(sender)) return reply('Wait for your previous sticker to finish.');
    busy.add(sender);
    try {
      const command = parseCommand(text)!;
      const media = findMedia(message);
      const clip = command.url !== undefined ? command : undefined;
      if (media?.voice && (clip || command.mute)) throw new Error('A voice note cannot be combined with a link or mute.');
      if (clip?.soundOnly && command.mute) throw new Error('mute cannot be combined with a sound link.');
      if (command.audio && !media?.voice && !clip?.soundOnly) {
        throw new Error('audio loop, cut and once need a voice note or a MyInstants sound.');
      }
      let make;
      // A video link wins over an attached video; a picture takes its sound from the link.
      if (media && (!clip || clip.soundOnly || media.type === 'image')) make = () => makeFromMedia(media, command, clip);
      else if (clip) make = () => makeFromUrl(clip);
      else throw new Error(USAGE);
      await reply(WAITING_LINES[Math.floor(Math.random() * WAITING_LINES.length)]!);
      // Without a chosen group, the sticker goes back to where it was asked for.
      const target = group || chat;
      // Where it lands in the same chat, the sticker itself answers; a quote cannot cross chats.
      await deliver(make, target, chat === target ? message : undefined);
      if (chat !== target) await reply('Sent to the group.');
    } catch (error) {
      await reply((error as Error).message);
    } finally {
      busy.delete(sender);
    }
  };
}
