// Copied from https://github.com/coelhobugado/whatsapp-figurinhas-com-som (src/sound-sticker.ts). MIT, see LICENSE.sound-sticker.
// Only change: imports from "baileys".
/**
 * Envio de figurinha com som.
 *
 * O WhatsApp representa a figurinha sonora como uma StickerMessage que carrega uma
 * AudioMessage no campo 26, embrulhada em um FutureProofMessage no campo 134 de Message:
 *
 *   Message
 *    └─ 134 FutureProofMessage
 *         └─ 1 Message
 *              └─ 26 StickerMessage (WebP animado)
 *                   └─ 26 AudioMessage (Ogg/Opus + streamingSidecar)
 *
 * Esses dois campos não existem no protobuf do Baileys 7.0.0-rc14, então os bytes são
 * montados aqui e anexados por um encoder adaptado. O formato vem de engenharia
 * reversa do aplicativo e pode mudar em versões futuras do WhatsApp.
 */
import { createCipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  generateWAMessageFromContent, getMediaKeys, prepareWAMessageMedia, proto,
  type WAMessage, type WASocket,
} from 'baileys';

const FIELD_STICKER = 26;          // Message.stickerMessage
const FIELD_STICKER_AUDIO = 26;    // StickerMessage.<áudio>, ausente no proto do Baileys
const FIELD_SOUND_WRAPPER = 134;   // Message.<FutureProofMessage da figurinha sonora>, ausente no proto do Baileys
const FIELD_FUTURE_PROOF_MESSAGE = 1;
const SIDECAR_CHUNK = 64 * 1024;

/**
 * Marca o objeto Message que deve sair no formato sonoro. É um Symbol enumerável para
 * sobreviver aos `{ ...message }` que o Baileys faz em alguns caminhos (grupos, reenvio).
 * O protobufjs ignora chaves Symbol, então a marca não vaza para outras mensagens.
 */
export const SOUND_STICKER_BYTES = Symbol.for('bot-figurinha-som.wrapper');
type MarkedMessage = proto.IMessage & { [SOUND_STICKER_BYTES]?: Uint8Array };

function varint(value: number): Buffer {
  const bytes: number[] = [];
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value) byte |= 0x80;
    bytes.push(byte);
  } while (value);
  return Buffer.from(bytes);
}

/** Campo protobuf do tipo "length-delimited" (wire type 2). */
function lengthField(field: number, payload: Uint8Array): Buffer {
  return Buffer.concat([varint(field * 8 + 2), varint(payload.length), payload]);
}

/** Bytes do FutureProofMessage que vai no campo 134. */
export function buildSoundStickerWrapper(sticker: proto.Message.IStickerMessage, audio: proto.Message.IAudioMessage): Buffer {
  const stickerBytes = Buffer.concat([
    proto.Message.StickerMessage.encode(sticker).finish(),
    lengthField(FIELD_STICKER_AUDIO, proto.Message.AudioMessage.encode(audio).finish()),
  ]);
  const innerMessage = lengthField(FIELD_STICKER, stickerBytes);
  return lengthField(FIELD_FUTURE_PROOF_MESSAGE, innerMessage);
}

let encoderInstalled = false;
/**
 * Troca `proto.Message.encode` por uma versão que, para mensagens marcadas, envia o
 * envelope 134 no lugar do campo 26. As demais mensagens passam direto pelo original.
 * O Baileys chama essa função também ao copiar a mensagem para os seus outros aparelhos
 * (deviceSentMessage), então a cópia sai no mesmo formato.
 */
export function installSoundStickerEncoder(): void {
  if (encoderInstalled) return;
  const original = proto.Message.encode;
  const patched = function encode(message: MarkedMessage, writer?: Parameters<typeof original>[1]) {
    const wrapper = message?.[SOUND_STICKER_BYTES];
    if (!wrapper) return original.call(proto.Message, message, writer);
    // `stickerMessage` fica no objeto só para o Baileys marcar mediatype="sticker" na stanza.
    const { stickerMessage: _visibleOnlyToBaileys, ...rest } = message;
    const out = original.call(proto.Message, rest, writer);
    out.uint32(FIELD_SOUND_WRAPPER * 8 + 2).bytes(wrapper);
    return out;
  };
  proto.Message.encode = patched as typeof original;
  encoderInstalled = true;
}

/**
 * streamingSidecar do áudio: um HMAC-SHA256 truncado em 10 bytes para cada bloco de 64 KiB
 * do arquivo cifrado, encadeado com os 16 bytes anteriores (o IV, no primeiro bloco).
 * Refaz a cifragem com a mesma mediaKey do upload e confere o hash antes de confiar no resultado.
 */
export async function createStreamingSidecar(audio: Buffer, mediaKey: Uint8Array, fileEncSha256: Uint8Array): Promise<Buffer> {
  const { iv, cipherKey, macKey } = await getMediaKeys(Buffer.from(mediaKey), 'audio');
  if (!iv || !cipherKey || !macKey) throw new Error('Não consegui derivar as chaves do áudio.');
  const cipher = createCipheriv('aes-256-cbc', cipherKey, iv);
  const encrypted = Buffer.concat([cipher.update(audio), cipher.final()]);
  const mac = createHmac('sha256', macKey).update(iv).update(encrypted).digest().subarray(0, 10);
  const hash = createHash('sha256').update(encrypted).update(mac).digest();
  if (hash.length !== fileEncSha256.length || !timingSafeEqual(hash, Buffer.from(fileEncSha256)))
    throw new Error('O áudio cifrado não confere com o que foi enviado ao servidor.');
  const parts: Buffer[] = [];
  for (let start = 0; start < encrypted.length; start += SIDECAR_CHUNK) {
    const previous = start === 0 ? iv : encrypted.subarray(start - 16, start);
    const chunk = encrypted.subarray(start, start + SIDECAR_CHUNK);
    parts.push(createHmac('sha256', macKey).update(previous).update(chunk).digest().subarray(0, 10));
  }
  return Buffer.concat(parts);
}

export type SoundStickerInput = {
  sticker: Buffer;      // WebP animado 512×512
  audio: Buffer;        // Ogg/Opus
  durationMs: number;
  quoted?: WAMessage;
};

/** Faz upload das duas mídias, monta a mensagem sonora e envia. Devolve o id da mensagem. */
export async function sendSoundSticker(socket: WASocket, jid: string, input: SoundStickerInput): Promise<string> {
  if (!socket.user?.id) throw new Error('Socket ainda não autenticado.');
  const options = { upload: socket.waUploadToServer, mediaUploadTimeoutMs: 60_000 };
  const visual = await prepareWAMessageMedia({ sticker: input.sticker, isAnimated: true, width: 512, height: 512 }, options);
  const sound = await prepareWAMessageMedia({
    audio: input.audio, mimetype: 'audio/ogg; codecs=opus', seconds: Math.max(1, Math.ceil(input.durationMs / 1000)),
  }, options);
  const audioMessage = sound.audioMessage;
  if (!visual.stickerMessage || !audioMessage?.mediaKey || !audioMessage.fileEncSha256)
    throw new Error('Falha ao preparar as mídias da figurinha.');
  audioMessage.streamingSidecar = await createStreamingSidecar(input.audio, audioMessage.mediaKey, audioMessage.fileEncSha256);

  const message = generateWAMessageFromContent(jid, visual, { userJid: socket.user.id, quoted: input.quoted });
  const content = message.message as MarkedMessage | null | undefined;
  if (!content?.stickerMessage || !message.key.id) throw new Error('Falha ao montar a mensagem.');
  content.stickerMessage.isAnimated = true;
  content[SOUND_STICKER_BYTES] = buildSoundStickerWrapper(content.stickerMessage, audioMessage);

  installSoundStickerEncoder();
  await socket.relayMessage(jid, content, { messageId: message.key.id });
  return message.key.id;
}
