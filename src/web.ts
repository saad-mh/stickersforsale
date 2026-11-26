// Local-only web page. Listens on 127.0.0.1 so nothing else on the network can reach it.
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { parseClip, type Clip } from './input.ts';

async function readBody(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 4096) throw new Error('Request too large.');
  }
  return body;
}

export function startWeb(port: number, send: (clip: Clip) => Promise<void>) {
  const server = createServer(async (request, response) => {
    const reply = (status: number, type: string, body: string) =>
      response.writeHead(status, { 'content-type': `${type}; charset=utf-8` }).end(body);
    const json = (status: number, data: object) => reply(status, 'application/json', JSON.stringify(data));
    try {
      // The Host check stops DNS rebinding: another site's name pointed at 127.0.0.1.
      const { port: actual } = server.address() as { port: number };
      if (![`127.0.0.1:${actual}`, `localhost:${actual}`].includes(request.headers.host ?? '')) {
        return json(403, { error: 'Forbidden.' });
      }
      if (request.method === 'GET' && request.url === '/') {
        return reply(200, 'text/html', await readFile(new URL('page.html', import.meta.url), 'utf8'));
      }
      if (request.method !== 'POST' || request.url !== '/send') return json(404, { error: 'Not found.' });
      // Browsers will not send this type cross-site without permission, which is never given.
      if (request.headers['content-type'] !== 'application/json') return json(415, { error: 'JSON only.' });
      const { url, start, end } = JSON.parse(await readBody(request));
      await send(parseClip(String(url), String(start), end ? String(end) : undefined));
      return json(200, { ok: true });
    } catch (error) {
      return json(400, { error: (error as Error).message });
    }
  });
  return server.listen(port, '127.0.0.1');
}
