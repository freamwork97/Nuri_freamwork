import http from 'node:http';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const MAX_BODY_BYTES = 8 * 1024 * 1024; // screenshots for vision steps are sent as base64

export function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

export function readJsonBody(req: http.IncomingMessage, limit = MAX_BODY_BYTES): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}
