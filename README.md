# stickersforsale

A self-hosted WhatsApp bot that makes **sound stickers** from YouTube, Instagram, MyInstants and `.mp4` links, or from videos, pictures and voice notes sent in a chat.

## Read this first

- It uses an **unofficial** WhatsApp library. WhatsApp can ban the number, so use a spare one.
- Sound stickers are reverse engineered. A WhatsApp update can break them at any time.
- Sound stickers are still being rolled out. Some people may see a silent sticker or none, and WhatsApp Web may not play the sound.
- Downloading from YouTube, Instagram and similar sites is against their terms. You are responsible for what you download and share.
- Not affiliated with WhatsApp, Meta, YouTube or MyInstants.

## What you need

- A spare WhatsApp number for the bot, and your own number to talk to it
- A computer that stays on while the bot should work
- [Node.js](https://nodejs.org) 24 or newer
- `ffmpeg` and `ffprobe`, built with `libwebp` and `libopus`
- `yt-dlp` (only for YouTube and Instagram links)

Developed on macOS. Linux should work but is untested. Windows is untested.

## Setup

**1. Install the tools.** On macOS with [Homebrew](https://brew.sh) (the plain `ffmpeg` formula cannot write WebP, so use `ffmpeg-full`):

```bash
brew install node ffmpeg-full yt-dlp
```

On Linux, install `ffmpeg` and `yt-dlp` from your package manager or their websites.

**2. Get the code** (clone or download this repository), then in its folder:

```bash
npm install
```

**3. Create your settings file:**

```bash
cp -n .env.example .env
```

**4. Link the bot's number.** Start the bot, then on the spare phone open WhatsApp > Linked devices > Link a device and scan the QR code:

```bash
npm start
```

**5. Choose the group.** Add the spare number to a group. With `GROUP_JID` empty, the bot prints your group IDs after connecting. Put one in `.env` as `GROUP_JID`, and your own number as `OWNER_NUMBER`.

**6. Restart** (Ctrl+C, then `npm start`) and send `.help` in the group.

## Run with Docker instead

**Untested:** these files have not been built or run yet.

Needs [Docker](https://docs.docker.com/get-docker/) with Compose; nothing else from the list above. Create `.env` (step 3), then link the number:

```bash
docker compose up --build
```

Scan the QR code, fill in `GROUP_JID` and `OWNER_NUMBER`, press Ctrl+C, then run it in the background:

```bash
docker compose up -d --build
```

- The WhatsApp login is kept in a Docker volume. `docker compose down -v` deletes it.
- The web page is off in Docker.
- Use one copy at a time: Docker or `npm start`, not both on the same number.
- `yt-dlp` is installed when the image is built. To update it: `docker compose build --no-cache`.
- For `IG_COOKIES`, mount a `cookies.txt` file the container can write to, and point the setting at it. A Firefox profile path from your computer will not work inside the container.
- Memory, CPU and log limits are in `compose.yaml`.

## Commands

`.s` is short for `.sticker`. `!`, `#` and `/` work in place of the dot. Times are `72` or `1:12`. The default length is 5 s and the most is 10 s.

| Send | Result |
|---|---|
| `.s <youtube link> 1:00 1:05` | Sticker from that part |
| `.s <instagram reel link>` | Sticker from the reel (times optional) |
| `.s <https link ending in .mp4>` | Sticker from that file, up to 50 MB |
| A video captioned `.s`, or reply `.s` to one | Sticker from the video |
| A picture captioned `.s` | Silent sticker |
| A picture captioned `.s <video link>` | Picture with that sound |
| A picture or video captioned `.s <myinstants link>` | That sound on your media |
| Send a voice note, then **reply to it** with a picture or video captioned `.s` | Your voice as the sound |
| `.s mute` (caption or reply) | Silent video or GIF sticker |
| `audio loop`, `audio cut`, `audio once` | What a short voice note or MyInstants sound does |
| `fx slow 0.5`, `fast 2`, `deep`, `chipmunk`, `bass`, `echo`, `reverse` | Effects, which can be combined |
| `.help` | The help text, in the chat |

Anyone in the chosen group can use the bot, one sticker at a time each. Outside it, only `OWNER_NUMBER` is obeyed. Messages sent more than 5 minutes before the bot received them are skipped. Every sound is levelled to a similar volume.

There is also a web page at http://127.0.0.1:3000, reachable only from the computer running the bot.

## Settings

All are optional, in `.env`.

| Setting | Meaning | If missing or wrong |
|---|---|---|
| `GROUP_JID` | The group that can use the bot | Only the owner can command it, and stickers go back to that chat. The web page cannot send |
| `OWNER_NUMBER` | Your number, with country code | Only the group can command it |
| `PORT` | Web page port, or `off` | 3000 |
| `STICKER_NAME` | Name in the sticker's details | `S.` |
| `IG_COOKIES` | Instagram login fallback | Reels that need a login fail |
| `FFMPEG_PATH` | Location of `ffmpeg` | Found automatically |

## Instagram login (optional)

Public reels are downloaded without any login. The login is only tried when Instagram refuses, at most 10 times an hour.

1. Use a **spare** Instagram account that follows no private accounts. Anyone in the group can fetch what it can see, and it can get banned.
2. Install Firefox (`brew install --cask firefox`), open `about:profiles`, create a profile for this, and sign in to Instagram in it. Do not give the bot the password.
3. In `.env`, set `IG_COOKIES=firefox:` followed by that profile's "Root Directory" path.

A `cookies.txt` file path also works. Either way it is a login: keep it private.

## When something breaks

Parts fail on their own, and the rest keeps running. At startup the bot prints a warning for a missing tool or setting.

| Problem | Still works |
|---|---|
| `yt-dlp` missing or a site changed | Chat media, voice notes, `.mp4` and MyInstants links |
| `ffmpeg` missing | The bot runs and `.help` replies; stickers report the error |
| Web page port in use | Everything on WhatsApp |
| One sticker fails or hangs | The queue moves on |
| Connection drops | Reconnects by itself |

- **Downloads fail:** update yt-dlp (`brew upgrade yt-dlp`).
- **Logged out:** delete the `auth/` folder and link again.
- **"Another copy is already connected":** stop the other copy.
- **Sticker has no sound:** check on a phone. If no sticker has sound, the format may have changed.

## Keep private

`.env`, `auth/` and files with `cookies` in a `.txt` name are in `.gitignore`. `auth/` is a full login to the bot's WhatsApp account. Never commit or share it.

Anyone in the group can make your computer download from a link they choose, and that site will see your internet address. Links to your own network are refused. Only add people you trust.

## How it works, and building your own

```
WhatsApp message ─> handler ─┐
                             ├─> queue ─> download ─> ffmpeg ─> send
web page ────────────────────┘
```

To rebuild the idea in another language:

1. Connect as a linked device with a WhatsApp Web protocol library.
2. Make a 512x512 animated WebP under 500 KB, and the sound as Ogg/Opus, mono, 48 kHz.
3. Upload both. Send a message that wraps the sticker, with the audio inside it, in a form the library does not know yet. See `src/sound-sticker.ts`.
4. Add the pack name as EXIF metadata in the WebP (`src/metadata.ts`).

| File | Job |
|---|---|
| `src/bot.ts` | Starts everything and connects the parts |
| `src/config.ts`, `src/tools.ts` | Settings and external programs |
| `src/whatsapp.ts` | Linking and reconnecting |
| `src/handler.ts` | Who may command the bot, what a message asks for, the waiting messages |
| `src/input.ts` | Reading commands and links. Edit `USAGE` to change the help text |
| `src/queue.ts` | One job at a time |
| `src/make.ts`, `src/metadata.ts` | Conversion, effects, sticker details |
| `src/media.ts`, `src/download.ts`, `src/direct.ts`, `src/myinstants.ts` | Fetching from chats and sites |
| `src/files.ts` | Size and type checks |
| `src/sound-sticker.ts` | The sound sticker message |
| `src/web.ts`, `src/page.html` | Local web page |
| `src/test-send.ts` | Sends one sticker from a local video, for debugging. Stop the bot first |

Node runs the TypeScript directly, so there is no build step.

## Test

Needs `ffmpeg`.

```bash
npm test
```

## Credits and license

MIT, see `LICENSE`.

The sound sticker message (`src/sound-sticker.ts`), and the conversion settings and metadata format used in `src/make.ts` and `src/metadata.ts`, come from [coelhobugado/whatsapp-figurinhas-com-som](https://github.com/coelhobugado/whatsapp-figurinhas-com-som) (MIT, see `LICENSE.sound-sticker`). WhatsApp connection by [Baileys](https://github.com/WhiskeySockets/Baileys).
