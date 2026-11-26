import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import makeWASocket, { DisconnectReason, useMultiFileAuthState, type WASocket } from 'baileys';
import qrcode from 'qrcode-terminal';

// A login to the WhatsApp account: keep private and out of git.
const AUTH_DIR = fileURLToPath(new URL('../auth/', import.meta.url));

// Silent on purpose: Baileys logs would include message contents.
const logger = {
  level: 'silent', child: () => logger,
  trace() {}, debug() {}, info() {}, warn() {}, error() {},
};

/** Connects and keeps reconnecting. `onSocket` runs for every new socket, `onOpen` once it is logged in. */
export async function connect(onOpen: (sock: WASocket) => void, onSocket?: (sock: WASocket) => void): Promise<void> {
  mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({ auth: state, logger });
  sock.ev.on('creds.update', () => {
    saveCreds().catch((error: Error) => console.error('Could not save the session:', error.message));
  });
  onSocket?.(sock);
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('On the phone the bot should use: WhatsApp > Linked devices > Link a device, then scan:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') onOpen(sock);
    if (connection !== 'close') return;
    const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
    if (code === DisconnectReason.loggedOut || code === DisconnectReason.connectionReplaced) {
      console.error(code === DisconnectReason.loggedOut
        ? 'Logged out. Delete the auth/ folder and link again.'
        : 'Another copy of the bot is already connected.');
      process.exit(1);
    }
    // restartRequired is the normal step right after scanning; reconnect at once.
    const delay = code === DisconnectReason.restartRequired ? 0 : 3000;
    reconnect(delay, onOpen, onSocket);
  });
}

// A failed attempt is retried too, so one bad moment does not leave the bot offline for good.
function reconnect(delay: number, onOpen: (sock: WASocket) => void, onSocket?: (sock: WASocket) => void) {
  setTimeout(() => connect(onOpen, onSocket).catch((error: Error) => {
    console.error('Reconnect failed:', error.message);
    reconnect(10_000, onOpen, onSocket);
  }), delay);
}
