// Step 1 check: node src/test-send.ts                      -> link and list groups
//              node src/test-send.ts <video> <group-id>   -> send one sound sticker
import { makeSticker } from './make.ts';
import { sendSoundSticker } from './sound-sticker.ts';
import { connect } from './whatsapp.ts';

const [video, jid] = process.argv.slice(2);
if (video && !jid?.endsWith('@g.us')) {
  console.error('Usage: node src/test-send.ts [<video> <group-id ending in @g.us>]');
  process.exit(1);
}
// Convert first, so a bad file fails before WhatsApp is involved.
const clip = video ? await makeSticker({ video }, { start: 0, seconds: 5 }) : undefined;

let started = false;
await connect(async sock => {
  if (started) return;
  started = true;
  try {
    if (clip) {
      await sendSoundSticker(sock, jid!, clip);
      console.log('Sent. Check the group on your phone and tap the sticker.');
    } else {
      for (const group of Object.values(await sock.groupFetchAllParticipating())) {
        console.log(`${group.id}  ${group.subject}`);
      }
    }
    // Give Baileys time to finish writing the session and delivering.
    setTimeout(() => process.exit(0), 5000);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
});
