// Downloads an MP4 from any public HTTPS address. Anyone in the group chooses the address,
// so it must never reach this Mac, the router or anything else on the local network.
import { lookup } from 'node:dns';
import { createWriteStream } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { get } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileKind, limit, MAX_MEDIA_BYTES } from './files.ts';

const REFUSED = 'That address is not allowed.';
const FAILED = 'Could not download that video link.';

const private4 = new BlockList();
for (const range of ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24',
  '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4']) {
  const [address, bits] = range.split('/');
  private4.addSubnet(address!, Number(bits), 'ipv4');
}
// For IPv6 only ordinary global addresses are let through, minus the ranges that can wrap an IPv4 one.
const global6 = new BlockList();
global6.addSubnet('2000::', 3, 'ipv6');
const special6 = new BlockList();
special6.addSubnet('2001::', 32, 'ipv6');
special6.addSubnet('2001:db8::', 32, 'ipv6');
special6.addSubnet('2002::', 16, 'ipv6');

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) return !private4.check(address, 'ipv4');
  return isIP(address) === 6 && global6.check(address, 'ipv6') && !special6.check(address, 'ipv6');
}

// Checked on the very addresses being connected to, so a name cannot change its answer in between.
const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, []);
    if (!addresses.length || !addresses.every(found => isPublicAddress(found.address))) {
      return callback(new Error(REFUSED), []);
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

/** Applied to the link and to every redirect. */
export function checkLink(link: URL): URL {
  const host = link.hostname.replace(/^\[|\]$/g, '');
  // Node skips the lookup for a bare IP address, so those are checked here.
  if (link.protocol !== 'https:' || link.port || link.username || link.password || (isIP(host) && !isPublicAddress(host))) {
    throw new Error(REFUSED);
  }
  return link;
}

function request(link: URL, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    get(link, { agent: false, lookup: publicLookup, signal, headers: { 'user-agent': 'Mozilla/5.0' } }, resolve)
      .on('error', reject);
  });
}

/** Returns the downloaded file's path. */
export async function downloadDirect(url: string, dir: string): Promise<string> {
  const signal = AbortSignal.timeout(90_000);
  const file = join(dir, 'clip.mp4');
  try {
    let link = checkLink(new URL(url));
    for (let hop = 0; hop < 4; hop++) {
      const response = await request(link, signal);
      const { statusCode = 0, headers } = response;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        response.destroy();
        link = checkLink(new URL(headers.location, link));
        continue;
      }
      if (statusCode !== 200) {
        response.destroy();
        throw new Error(`The site answered with error ${statusCode}.`);
      }
      await pipeline(response, limit(MAX_MEDIA_BYTES), createWriteStream(file), { signal });
      if (await fileKind(file) !== 'mp4') throw new Error('That link is not an MP4 video.');
      return file;
    }
    throw new Error('That link redirects too many times.');
  } catch (error) {
    console.error((error as Error).message);
    // Network errors can name addresses, so only our own messages go to the chat.
    const { message } = error as Error;
    throw new Error(/^(That|The site) /.test(message) ? message : FAILED);
  }
}
