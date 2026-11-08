import { validateProject, type ProjectFile } from './project';

const PREFIX = '#mr2.';
const DIGEST_LENGTH = 43; // SHA-256 encoded as unpadded base64url.
/** A product limit on the entire URL, not a browser's maximum accepted size. */
export const MAX_SHARE_URL_LENGTH = 16 * 1024;
export const MAX_SHARE_JSON_BYTES = 1024 * 1024;
const TOO_LARGE = 'Project is too large for a share link; use project file export instead.';

async function collect(stream: ReadableStream<Uint8Array>, limit: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  signal?.throwIfAborted();
  const reader = stream.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error(TOO_LARGE);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function base64url(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x8000) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  }
  return btoa(parts.join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unbase64url(encoded: string): Uint8Array<ArrayBuffer> {
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1) {
    throw new Error('Invalid share link base64url payload.');
  }
  const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - encoded.length % 4) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (base64url(bytes) !== encoded) throw new Error('Invalid share link base64url payload.');
  return bytes;
}

async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

/** The checksum detects corruption, not authorship: every decoded field is untrusted. */
export async function encodeShare(project: ProjectFile, maxHashLength = MAX_SHARE_URL_LENGTH): Promise<string> {
  validateProject(project, true);
  const json = JSON.stringify(project);
  if (json.length > MAX_SHARE_JSON_BYTES) throw new Error(TOO_LARGE);
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > MAX_SHARE_JSON_BYTES) throw new Error(TOO_LARGE);
  const limit = Math.min(maxHashLength, MAX_SHARE_URL_LENGTH);
  const payloadLimit = Math.floor((limit - PREFIX.length - DIGEST_LENGTH - 1) * 3 / 4);
  if (payloadLimit < 1) throw new Error(TOO_LARGE);
  const compressed = await collect(
    new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')),
    payloadLimit,
  );
  const hash = PREFIX + await digest(compressed) + '.' + base64url(compressed);
  if (hash.length > limit) throw new Error(TOO_LARGE);
  return hash;
}

/** Check the envelope and integrity before decompressing, then validate before applying. */
export async function decodeShare(hash: string, maxHashLength = MAX_SHARE_URL_LENGTH, signal?: AbortSignal): Promise<ProjectFile> {
  signal?.throwIfAborted();
  if (hash.length > Math.min(maxHashLength, MAX_SHARE_URL_LENGTH)) throw new Error(TOO_LARGE);
  if (!hash.startsWith(PREFIX)) throw new Error('Unsupported or missing share link version.');
  const parts = hash.slice(PREFIX.length).split('.');
  if (parts.length !== 2 || parts[0].length !== DIGEST_LENGTH) throw new Error('Invalid share link checksum envelope.');
  const checksum = unbase64url(parts[0]);
  if (checksum.length !== 32) throw new Error('Invalid share link checksum.');
  const bytes = unbase64url(parts[1]);
  const expected = await digest(bytes);
  signal?.throwIfAborted();
  if (expected !== parts[0]) throw new Error('Share link checksum mismatch.');
  let expanded: Uint8Array<ArrayBuffer>;
  try {
    expanded = await collect(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
      MAX_SHARE_JSON_BYTES,
      signal,
    );
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Error && error.message === TOO_LARGE) throw error;
    throw new Error('Corrupt share link gzip payload.');
  }
  signal?.throwIfAborted();
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(expanded));
  } catch {
    throw new Error('Corrupt share link JSON payload.');
  }
  validateProject(value, true);
  return value;
}
