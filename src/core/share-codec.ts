import { validateProject, type ProjectFile } from './project';

const PREFIX = '#mr1.';
/** Limits include custom sound data: oversized projects must use file export. */
export const MAX_SHARE_HASH_LENGTH = 2 * 1024 * 1024;
export const MAX_SHARE_JSON_BYTES = 8 * 1024 * 1024;
const TOO_LARGE = 'Project is too large for a share link; use project file export instead.';

async function collect(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error(TOO_LARGE);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
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

/** Losslessly encode the same versioned JSON payload used by project files. */
export async function encodeShare(project: ProjectFile): Promise<string> {
  validateProject(project);
  const json = JSON.stringify(project);
  if (json.length > MAX_SHARE_JSON_BYTES) throw new Error(TOO_LARGE);
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > MAX_SHARE_JSON_BYTES) throw new Error(TOO_LARGE);
  const compressed = await collect(
    new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')),
    Math.floor((MAX_SHARE_HASH_LENGTH - PREFIX.length) * 3 / 4),
  );
  const hash = PREFIX + base64url(compressed);
  if (hash.length > MAX_SHARE_HASH_LENGTH) throw new Error(TOO_LARGE);
  return hash;
}

/** Reject malformed links before any caller applies their state. */
export async function decodeShare(hash: string): Promise<ProjectFile> {
  if (hash.length > MAX_SHARE_HASH_LENGTH) throw new Error(TOO_LARGE);
  if (!hash.startsWith(PREFIX)) throw new Error('Unsupported or missing share link version.');
  const encoded = hash.slice(PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1) {
    throw new Error('Invalid share link base64url payload.');
  }
  const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - encoded.length % 4) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // Reject noncanonical trailing padding bits as well as invalid characters.
  if (base64url(bytes) !== encoded) throw new Error('Invalid share link base64url payload.');
  let expanded: Uint8Array<ArrayBuffer>;
  try {
    expanded = await collect(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
      MAX_SHARE_JSON_BYTES,
    );
  } catch (error) {
    if (error instanceof Error && error.message === TOO_LARGE) throw error;
    throw new Error('Corrupt share link gzip payload.');
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(expanded));
  } catch {
    throw new Error('Corrupt share link JSON payload.');
  }
  validateProject(value);
  return value;
}
