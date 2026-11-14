/**
 * FlickSend wire protocol (v1) — shared by the phone app and the desktop app.
 *
 * The desktop runs a tiny HTTP/1.1 server on the LAN. The phone pairs by
 * scanning a QR code that contains every LAN address of the laptop, the port
 * and a secret token. Every request from the phone carries the token in the
 * `X-Flick-Token` header.
 *
 *   GET  /hello                    -> HelloResponse            (pairing check)
 *   POST /flick         (JSON)     -> { ok: true }             (metadata + tiny thumbnail,
 *                                                               lets the laptop start the
 *                                                               fly-in animation instantly)
 *   PUT  /flick/:id/content (raw)  -> { ok: true }             (the full file, streamed)
 *   GET  /media/:id                -> file bytes               (loopback only: the desktop
 *                                                               UI loads media from here)
 */

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 47821;
export const PAIRING_SCHEME = 'flicksend://pair';

export const HEADER_TOKEN = 'X-Flick-Token';
/** URI-encoded original file name, sent with the PUT upload. */
export const HEADER_FILE_NAME = 'X-Flick-Name';

export type MediaKind = 'image' | 'video';

/** Direction the user flicked in. Reserved for multi-monitor targeting. */
export type FlickDirection = 'up' | 'up-left' | 'up-right';

export interface HelloResponse {
  app: 'flicksend';
  protocol: number;
  name: string;
}

export interface FlickMeta {
  /** Client-generated id: 8–64 chars of [A-Za-z0-9_-]. */
  id: string;
  kind: MediaKind;
  mime: string;
  name: string;
  /** Size of the full file in bytes (0 if unknown). */
  size: number;
  width?: number;
  height?: number;
  /** Video duration in milliseconds. */
  durationMs?: number;
  /** Small JPEG preview as a data: URI, so the desktop can animate before the upload finishes. */
  thumbnail?: string;
  direction?: FlickDirection;
  /** Human-readable sender name (e.g. phone model). */
  from?: string;
  sentAt: number;
}

export interface Pairing {
  /** Candidate LAN IPv4 addresses of the desktop, best first. */
  hosts: string[];
  port: number;
  token: string;
  /** Desktop computer name, for display. */
  name: string;
}

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function isValidId(id: string): boolean {
  return ID_RE.test(id);
}

export function newFlickId(): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = Date.now().toString(36) + '-';
  for (let i = 0; i < 12; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export function buildPairingUri(p: Pairing): string {
  const q = [
    'v=' + PROTOCOL_VERSION,
    'h=' + p.hosts.map(encodeURIComponent).join(','),
    'p=' + p.port,
    't=' + encodeURIComponent(p.token),
    'n=' + encodeURIComponent(p.name),
  ].join('&');
  return `${PAIRING_SCHEME}?${q}`;
}

/** Parses a `flicksend://pair?...` URI. Returns null if it isn't a valid pairing code. */
export function parsePairingUri(uri: string): Pairing | null {
  const trimmed = uri.trim();
  if (!trimmed.startsWith(PAIRING_SCHEME + '?')) {
    return null;
  }
  const params: Record<string, string> = {};
  for (const part of trimmed.slice(PAIRING_SCHEME.length + 1).split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    params[part.slice(0, eq)] = part.slice(eq + 1);
  }
  try {
    const hosts = (params.h ?? '')
      .split(',')
      .map(decodeURIComponent)
      .filter(h => /^\d{1,3}(\.\d{1,3}){3}$/.test(h));
    const port = Number(params.p);
    const token = decodeURIComponent(params.t ?? '');
    const name = decodeURIComponent(params.n ?? '') || 'Laptop';
    if (
      hosts.length === 0 ||
      !Number.isInteger(port) ||
      port <= 0 ||
      port > 65535 ||
      token.length < 16
    ) {
      return null;
    }
    return {hosts, port, token, name};
  } catch {
    return null;
  }
}

export function baseUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}

export function kindFromMime(mime: string): MediaKind {
  return mime.startsWith('video/') ? 'video' : 'image';
}

/** Desktop native module event payloads (sent as JSON strings). */
export interface ProgressEvent {
  id: string;
  received: number;
  total: number;
}

export interface CompleteEvent {
  id: string;
  path: string;
  url: string;
}

export interface ErrorEvent {
  id: string;
  error: string;
}

export const EVENT_INCOMING = 'flickIncoming';
export const EVENT_PROGRESS = 'flickProgress';
export const EVENT_COMPLETE = 'flickComplete';
export const EVENT_ERROR = 'flickError';
