import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { proto } from 'baileys';
import { FFMPEG, makeSticker, makeStill } from './src/make.ts';
import { buildSoundStickerWrapper } from './src/sound-sticker.ts';
import { once } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { COMMAND, findMedia, HELP, isOwner, messageText, parseCommand } from './src/input.ts';
import { fileKind, limit } from './src/files.ts';
import { startWeb } from './src/web.ts';
import { readConfig } from './src/config.ts';
import { createHandler } from './src/handler.ts';
import { createQueue } from './src/queue.ts';
import { checkTools } from './src/tools.ts';
import { checkLink, downloadDirect, isPublicAddress } from './src/direct.ts';
import { cookieArgs, download, LOGINS_PER_HOUR } from './src/download.ts';
import { findSound, isAudio } from './src/myinstants.ts';

test('a video becomes an animated 512px WebP plus Ogg audio', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sticker-test-'));
  try {
    const video = join(dir, 'in.mp4');
    execFileSync(FFMPEG, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '8', video]);
    const { sticker, audio, durationMs } = await makeSticker({ video }, { start: 1, seconds: 3 });
    assert.equal(sticker.toString('latin1', 8, 16), 'WEBPVP8X');
    assert.ok(sticker[20]! & 0x02, 'animation flag');
    assert.equal(sticker.readUIntLE(24, 3) + 1, 512);
    assert.equal(sticker.readUIntLE(27, 3) + 1, 512);
    assert.ok(sticker.length <= 500_000);
    assert.equal(sticker.readUInt32LE(4), sticker.length - 8);
    assert.ok(sticker[20]! & 0x08, 'EXIF flag');
    assert.ok(sticker.includes('"sticker-pack-name":"S."'));
    assert.equal(await fileKind(video), 'mp4');
    await assert.rejects(fileKind(new URL(import.meta.url).pathname));
    for (const kind of ['jpg', 'png'] as const) {
      const picture = join(dir, `picture.${kind}`);
      execFileSync(FFMPEG, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360', '-frames:v', '1', picture]);
      assert.equal(await fileKind(picture), kind);
      const still = await makeStill(picture);
      assert.equal(still.toString('latin1', 8, 16), 'WEBPVP8X');
      assert.ok(!(still[20]! & 0x02) && still.length <= 100_000);
      assert.ok(still.includes('"sticker-pack-name":"S."'));
      // A picture plus a separate sound source, as with a YouTube link.
      const both = await makeSticker({ picture, sound: video }, { start: 0, seconds: 2 });
      assert.ok(!(both.sticker[20]! & 0x02));
      assert.equal(both.audio!.toString('latin1', 0, 4), 'OggS');
    }
    assert.equal(audio!.toString('latin1', 0, 4), 'OggS');
    assert.ok(Math.abs(durationMs! - 3000) < 100, `duration ${durationMs}`);
    await assert.rejects(makeSticker({ video }, { start: 60, seconds: 3 }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the wrapper carries the sticker and its audio', () => {
  const wrapper = buildSoundStickerWrapper({ mimetype: 'image/webp' }, { seconds: 3 });
  const inner = proto.Message.FutureProofMessage.decode(wrapper).message!;
  assert.equal(inner.stickerMessage!.mimetype, 'image/webp');
  assert.ok(wrapper.includes(Buffer.from([0xd2, 0x01])), 'audio field 26');
});

test('commands are parsed and everything else is ignored', () => {
  assert.equal(parseCommand('hello .sticker'), null);
  assert.equal(parseCommand('.stickers https://youtu.be/a 1'), null);
  assert.deepEqual(parseCommand('!Sticker https://youtu.be/a 1:12 1:17'), { url: 'https://youtu.be/a', start: 72, seconds: 5 });
  assert.equal(parseCommand('.sticker https://www.youtube.com/watch?v=a 1:00:00')!.start, 3600);
  assert.deepEqual(parseCommand('#sticker'), { start: 0, seconds: 5 });
  assert.deepEqual(parseCommand('.S 1 3'), { start: 1, seconds: 2 });
  assert.equal(parseCommand('.so what'), null);
  assert.deepEqual(parseCommand('/sticker 0:02 0:04'), { start: 2, seconds: 2 });
  for (const bad of ['.sticker https://youtu.be/a', '.sticker 1 2 3', '.sticker https://evil.com/youtube.com 1', '.sticker file:///etc/passwd 1',
    '.sticker --exec 1', '.sticker https://youtu.be/a abc', '.sticker https://youtu.be/a 10 5',
    '.sticker https://youtu.be/a 0 11']) {
    assert.throws(() => parseCommand(bad), bad);
  }
});

test('only the owner number is accepted', () => {
  assert.ok(isOwner(['123@lid', '15551234567:3@s.whatsapp.net'], '15551234567'));
  assert.ok(!isOwner(['15551234567@lid', '915551234567@s.whatsapp.net', null], '15551234567'));
});

test('the web page refuses other hosts, other content types and bad links', async () => {
  const sent: unknown[] = [];
  const server = startWeb(0, async clip => { sent.push(clip); });
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const post = (body: object, headers: Record<string, string> = {}) => new Promise<number>(resolve => {
    request({ port, host: '127.0.0.1', method: 'POST', path: '/send', headers: { 'content-type': 'application/json', ...headers } },
      response => { response.resume(); resolve(response.statusCode!); }).end(JSON.stringify(body));
  });
  const good = { url: 'https://youtu.be/a', start: '1' };
  try {
    assert.equal(await post(good, { host: 'evil.com' }), 403);
    assert.equal(await post(good, { 'content-type': 'text/plain' }), 415);
    assert.equal(await post({ url: 'https://evil.com', start: '1' }), 400);
    assert.equal(sent.length, 0);
    assert.equal(await post(good), 200);
    assert.equal(sent.length, 1);
  } finally {
    server.close();
  }
});

test('a video or picture is found on the message itself or on the one replied to', () => {
  const key = { remoteJid: '1@g.us', id: 'A' };
  assert.equal(findMedia({ key, message: { videoMessage: { caption: '.sticker' } } })!.message.key.id, 'A');
  const reply = { extendedTextMessage: { text: '.sticker', contextInfo: { stanzaId: 'B', quotedMessage: { videoMessage: {} } } } };
  assert.equal(findMedia({ key, message: reply })!.message.key.id, 'B');
  assert.equal(findMedia({ key, message: { conversation: '.sticker' } }), null);
  assert.equal(findMedia({ key, message: { imageMessage: { caption: '.sticker' } } })!.type, 'image');
});

test('oversized downloads are cut off', async () => {
  await assert.rejects(pipeline(Readable.from([Buffer.alloc(11)]), limit(10), new PassThrough().resume()), /over 50 MB/);
});

test('commands are read from messages and captions, and help is recognised', () => {
  const key = { id: 'A' };
  for (const message of [{ conversation: '.sticker' }, { extendedTextMessage: { text: '.sticker' } },
    { videoMessage: { caption: '.sticker' } }, { imageMessage: { caption: '.sticker' } },
    { ephemeralMessage: { message: { imageMessage: { caption: '.sticker' } } } }]) {
    assert.equal(messageText({ key, message }), '.sticker', JSON.stringify(message));
  }
  assert.ok(HELP.test('.help') && HELP.test('!Help '));
  assert.ok(!HELP.test('.help me move') && !HELP.test('help') && !COMMAND.test('.help'));
});

test('mute, voice modes and effects produce the right lengths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sticker-test-'));
  const make = (...args: string[]) => execFileSync(FFMPEG, ['-loglevel', 'error', ...args]);
  try {
    const video = join(dir, 'silent.mp4'), voice = join(dir, 'voice.ogg'), picture = join(dir, 'p.png');
    make('-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15', '-t', '8', video);
    make('-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-c:a', 'libopus', voice);
    make('-f', 'lavfi', '-i', 'testsrc', '-frames:v', '1', picture);
    const range = { start: 0, seconds: 5 };
    const length = async (visual: object, options: object = {}) =>
      (await makeSticker(visual, { ...range, ...options })).durationMs;
    // Peak volume of the part after the 2 s voice note has finished.
    const tail = (audio: Buffer) => {
      writeFileSync(join(dir, 'out.ogg'), audio);
      const { stderr } = spawnSync(FFMPEG, ['-ss', '3', '-i', join(dir, 'out.ogg'), '-af', 'volumedetect', '-f', 'null', '-']);
      return Number(/max_volume: (-?[\d.]+) dB/.exec(String(stderr))![1]);
    };

    const muted = await makeSticker({ video }, { ...range, mute: true });
    assert.ok(muted.animated && !muted.audio);
    await assert.rejects(makeSticker({ video }, range), /s mute/);

    const once = await makeSticker({ video, sound: voice }, range);
    assert.equal(once.durationMs, 5000);
    assert.ok(tail(once.audio!) < -50, 'silent after the voice ends');
    const looped = await makeSticker({ video, sound: voice }, { ...range, audio: 'loop' });
    assert.equal(looped.durationMs, 5000);
    assert.ok(tail(looped.audio!) > -30, 'still playing when looped');
    assert.ok(Math.abs((await length({ video, sound: voice }, { audio: 'cut' }))! - 2000) < 100);
    assert.ok(Math.abs((await length({ picture, sound: voice }))! - 2000) < 100);
    assert.equal(await length({ picture, sound: voice }, { audio: 'loop' }), 5000);

    assert.equal(await length({ video, sound: voice }, { speed: 0.5 }), 10_000);
    assert.equal(await length({ video, sound: voice }, { speed: 0.25 }), 10_000);
    assert.equal(await length({ video, sound: voice }, { speed: 2 }), 2500);
    const all = await makeSticker({ video, sound: voice }, { ...range, reverse: true, effects: ['deep', 'chipmunk', 'bass', 'echo'] });
    assert.ok(all.animated && all.audio!.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mute, audio and fx words are parsed in any order', () => {
  assert.deepEqual(parseCommand('.s mute 1 3'), { start: 1, seconds: 2, mute: true });
  assert.deepEqual(parseCommand('.s audio loop'), { start: 0, seconds: 5, audio: 'loop' });
  assert.deepEqual(parseCommand('.s fx slow 0.5'), { start: 0, seconds: 5, speed: 0.5 });
  assert.deepEqual(parseCommand('.s fx fast echo bass 1 3'), { start: 1, seconds: 2, speed: 2, effects: ['echo', 'bass'] });
  assert.deepEqual(parseCommand('.s https://youtu.be/a 1:00 1:03 FX reverse'),
    { url: 'https://youtu.be/a', start: 60, seconds: 3, reverse: true });
  for (const bad of ['.s fx', '.s fx boom', '.s fx slow 3', '.s fx fast 0.5', '.s fx constructor', '.s audio', '.s audio forever', '.s mute fx echo']) {
    assert.throws(() => parseCommand(bad), bad);
  }
});

test('a voice note is picked up when a picture or video replies to it', () => {
  const key = { id: 'A', remoteJid: '1@g.us' };
  const contextInfo = { stanzaId: 'V', quotedMessage: { audioMessage: {} } };
  const found = findMedia({ key, message: { imageMessage: { caption: '.s', contextInfo } } })!;
  assert.equal(found.type, 'image');
  assert.equal(found.voice!.message.key.id, 'V');
  assert.equal(findMedia({ key, message: { extendedTextMessage: { text: '.s', contextInfo } } }), null);
});

test('MyInstants links are accepted, and only its own sound files are fetched', () => {
  const url = 'https://www.myinstants.com/en/instant/vine-boom-sound-70972/';
  assert.deepEqual(parseCommand(`.s ${url}`), { url, start: 0, seconds: 5, soundOnly: true });
  assert.throws(() => parseCommand('.s https://youtu.be/a'));
  assert.throws(() => parseCommand('.s https://www.myinstants.com/en/index/us/'));
  const page = (src: string) => `<meta property="og:audio" content="${src}"/>`;
  const good = 'https://www.myinstants.com/media/sounds/vine-boom.mp3';
  assert.equal(findSound(page(good)), good);
  for (const bad of ['http://127.0.0.1/a.mp3', 'file:///etc/passwd', 'https://www.myinstants.com.evil.com/media/sounds/a.mp3',
    'https://www.myinstants.com/media/sounds/../../accounts']) {
    assert.throws(() => findSound(page(bad)), bad);
  }
  assert.ok(isAudio(Buffer.from('ID3\x04')) && isAudio(Buffer.from([0xff, 0xfb, 0, 0])));
  assert.ok(!isAudio(Buffer.from('#EXTM3U')));
});

test('quiet and loud sounds come out at a similar volume', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sticker-test-'));
  try {
    const picture = join(dir, 'p.png');
    execFileSync(FFMPEG, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc', '-frames:v', '1', picture]);
    const loudness = async (volume: number) => {
      const sound = join(dir, `${volume}.wav`);
      execFileSync(FFMPEG, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440', '-af', `volume=${volume}`, '-t', '4', sound]);
      const made = await makeSticker({ picture, sound }, { start: 0, seconds: 4 });
      writeFileSync(join(dir, 'out.ogg'), made.audio!);
      const { stderr } = spawnSync(FFMPEG, ['-i', join(dir, 'out.ogg'), '-af', 'volumedetect', '-f', 'null', '-']);
      return Number(/mean_volume: (-?[\d.]+) dB/.exec(String(stderr))![1]);
    };
    const [quiet, loud] = [await loudness(0.1), await loudness(6)];
    assert.ok(Math.abs(quiet - loud) < 3, `${quiet} vs ${loud}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Instagram links are accepted, with or without times', () => {
  const url = 'https://www.instagram.com/reels/DgNOuzERIwx/';
  assert.deepEqual(parseCommand(`.s ${url}`), { url, start: 0, seconds: 5 });
  assert.equal(parseCommand('.s https://instagram.com/p/abc_-1/ 2 9')!.seconds, 7);
  for (const bad of ['.s https://www.instagram.com/someone/', '.s https://instagram.com.evil.com/reel/a']) {
    assert.throws(() => parseCommand(bad), bad);
  }
});

test('the Instagram login is used only when needed, and only so often', async () => {
  const reel = { url: 'https://www.instagram.com/reel/a/', start: 0, seconds: 5 };
  const calls: string[][] = [];
  const fail = (stderr: string) => Object.assign(new Error('x'), { stderr });
  // Signed out is refused; signed in works.
  const run = async (args: string[]) => {
    calls.push(args);
    if (!args.includes('--cookies-from-browser')) throw fail('ERROR: [Instagram] a: rate-limit reached, log in');
    return { stdout: '/tmp/clip.mp4\n' };
  };
  const get = (clip = reel, runner = run, cookies: string | undefined = 'firefox:spare') =>
    download(clip, '/tmp', 'ffmpeg', runner, cookies);

  assert.equal(await get(reel, async args => { calls.push(args); return { stdout: 'a.mp4' }; }), 'a.mp4');
  assert.ok(!calls[0]!.some(arg => arg.startsWith('--cookies')), 'public posts never use the login');

  await assert.rejects(get(reel, run, ''), /none is set up/);
  calls.length = 0;
  await assert.rejects(get({ ...reel, url: 'https://youtu.be/a' }), /log in/);
  assert.equal(calls.length, 1, 'never signs in for other sites');
  calls.length = 0;
  await assert.rejects(get(reel, async args => { calls.push(args); throw fail('ERROR: network down'); }), /network down/);
  assert.equal(calls.length, 1, 'unrelated errors do not use the login');

  await assert.rejects(get(reel, async () => { throw fail('ERROR: login required /Users/me/secret'); }),
    (error: Error) => !error.message.includes('secret'));
  for (let used = 1; used < LOGINS_PER_HOUR; used++) assert.equal(await get(), '/tmp/clip.mp4');
  await assert.rejects(get(), /limit reached/);
  assert.deepEqual(cookieArgs('firefox:spare'), ['--cookies-from-browser', 'firefox:spare']);
  assert.equal(cookieArgs(new URL(import.meta.url).pathname)[0], '--cookies');
});

test('direct MP4 links are accepted but cannot reach the local network', async () => {
  const url = 'https://example.com/a/clip.MP4';
  assert.deepEqual(parseCommand(`.s ${url}`), { url, start: 0, seconds: 5, direct: true });
  assert.throws(() => parseCommand('.s http://example.com/clip.mp4'));
  assert.throws(() => parseCommand('.s https://example.com/clip.mp4.exe'));
  for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.31.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', 'not-an-address']) {
    assert.ok(!isPublicAddress(address), address);
  }
  assert.ok(isPublicAddress('1.1.1.1') && isPublicAddress('2606:4700:4700::1111'));
  for (const bad of ['http://example.com/a.mp4', 'https://127.0.0.1/a.mp4', 'https://2130706433/a.mp4',
    'https://[::1]/a.mp4', 'https://example.com:8443/a.mp4', 'https://me:pw@example.com/a.mp4']) {
    assert.throws(() => checkLink(new URL(bad)), bad);
  }
  // A name that resolves to this Mac is refused at connection time.
  await assert.rejects(downloadDirect('https://localhost/a.mp4', tmpdir()), /not allowed/);
});

test('missing or bad settings switch off only what depends on them', () => {
  const empty = readConfig({});
  assert.deepEqual([empty.owner, empty.group, empty.port], ['', '', 3000]);
  assert.equal(empty.warnings.length, 2);
  const bad = readConfig({ OWNER_NUMBER: '+1 (555) 123-4567', GROUP_JID: 'nonsense', PORT: 'abc' });
  assert.deepEqual([bad.owner, bad.group, bad.port], ['15551234567', '', 3000]);
  assert.equal(readConfig({ PORT: 'off' }).port, null);
  assert.deepEqual(readConfig({ OWNER_NUMBER: '1', GROUP_JID: 'a@g.us' }).warnings, []);
});

test('missing programs are reported, not fatal', async () => {
  const warnings = await checkTools('/no/ffmpeg', '/no/ffprobe', '/no/yt-dlp');
  assert.equal(warnings.length, 3);
});

test('a failed or stuck job does not block the queue', async () => {
  const enqueue = createQueue(3, 50);
  const failed = enqueue(async () => { throw new Error('boom'); });
  const stuck = enqueue(() => new Promise(() => {}));
  let ran = false;
  const next = enqueue(async () => { ran = true; });
  await assert.rejects(enqueue(async () => {}), /Too many/);
  await assert.rejects(failed, /boom/);
  await assert.rejects(stuck, /too long/);
  await next;
  assert.ok(ran);
});

test('the handler obeys only the group and the owner, and survives failed replies', async () => {
  const replies: string[] = [];
  const targets: string[] = [];
  let failReplies = false;
  const sock = {
    sendMessage: async (_: string, content: { text: string }) => {
      if (failReplies) throw new Error('offline');
      replies.push(content.text);
    },
    signalRepository: { lidMapping: { getPNForLID: async () => null } },
  } as never;
  let id = 0;
  const message = (remoteJid: string, text = '.s https://youtu.be/a 1') => ({
    key: { remoteJid, id: String(++id), participant: remoteJid.endsWith('@g.us') ? '999@s.whatsapp.net' : undefined },
    messageTimestamp: Date.now() / 1000, message: { conversation: text },
  });
  const make = (owner: string, group: string) =>
    createHandler({ owner, group, deliver: async (_, target) => { targets.push(target); } });

  const both = make('111', 'g@g.us');
  await both(sock, message('g@g.us'));
  await both(sock, message('other@g.us'));
  await both(sock, message('222@s.whatsapp.net'));
  await both(sock, message('g@g.us', 'just chatting'));
  await both(sock, message('111@s.whatsapp.net'));
  assert.deepEqual(targets.splice(0), ['g@g.us', 'g@g.us']);

  await make('', 'g@g.us')(sock, message('111@s.whatsapp.net'));
  await make('', '')(sock, message('g@g.us'));
  assert.deepEqual(targets.splice(0), []);
  await make('111', '')(sock, message('111@s.whatsapp.net'));
  assert.deepEqual(targets.splice(0), ['111@s.whatsapp.net']);

  failReplies = true;
  await both(sock, message('g@g.us'));
  assert.deepEqual(targets.splice(0), ['g@g.us'], 'the sticker is still made');
});
