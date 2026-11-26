// Entry point: npm start. Only wires the parts together.
import type { WASocket } from 'baileys';
import { readConfig } from './config.ts';
import { createHandler, type Deliver } from './handler.ts';
import { makeFromUrl } from './make.ts';
import { createQueue } from './queue.ts';
import { sendSoundSticker } from './sound-sticker.ts';
import { checkTools } from './tools.ts';
import { startWeb } from './web.ts';
import { connect } from './whatsapp.ts';

// One stray error should be reported, not take the bot down.
process.on('unhandledRejection', error => console.error('Unexpected error:', error));

const { owner, group, port, warnings } = readConfig(process.env);
for (const warning of [...warnings, ...await checkTools()]) console.warn(`Warning: ${warning}`);

let socket: WASocket | undefined; // set only while connected
const enqueue = createQueue();

const deliver: Deliver = (make, target, quoted) => enqueue(async () => {
  const { sticker, audio, durationMs, animated } = await make();
  if (!socket) throw new Error('WhatsApp is not connected.');
  if (audio) await sendSoundSticker(socket, target, { sticker, audio, durationMs: durationMs!, quoted });
  else await socket.sendMessage(target, { sticker, isAnimated: animated }, { quoted });
});

// The web page is optional: if it cannot start, WhatsApp commands carry on.
if (port !== null) {
  startWeb(port, async clip => {
    if (!group) throw new Error('Set GROUP_JID to use the web page.');
    await deliver(() => makeFromUrl(clip), group);
  })
    .on('listening', () => console.log(`Web page: http://127.0.0.1:${port}`))
    .on('error', error => console.warn(`Warning: web page unavailable (${error.message}). WhatsApp commands still work.`));
}

const onMessage = createHandler({ owner, group, deliver });

await connect(
  sock => {
    socket = sock;
    console.log('WhatsApp connected.');
    if (group) return;
    sock.groupFetchAllParticipating()
      .then(groups => {
        console.log('Your groups (copy one ID into GROUP_JID in .env, then restart):');
        for (const found of Object.values(groups)) console.log(`  ${found.id}  ${found.subject}`);
      })
      .catch((error: Error) => console.error('Could not list groups:', error.message));
  },
  sock => {
    sock.ev.on('connection.update', ({ connection }) => {
      if (connection === 'close' && socket === sock) socket = undefined;
    });
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const message of messages) onMessage(sock, message).catch((error: Error) => console.error(error.message));
    });
  },
);
