import {File, UploadType} from 'expo-file-system';
import {
  HEADER_FILE_NAME,
  HEADER_TOKEN,
  baseUrl,
} from '../../../shared/protocol';
import type {FlickMeta, HelloResponse, Pairing} from '../../../shared/protocol';

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {...init, signal: controller.signal});
  } finally {
    clearTimeout(timer);
  }
}

async function errorFrom(res: Response): Promise<Error> {
  let message = `HTTP ${res.status}`;
  try {
    const body = await res.json();
    if (body?.error) {
      message = body.error;
    }
  } catch {
    // not JSON
  }
  return new Error(message);
}

export async function hello(
  host: string,
  port: number,
  token: string,
  timeoutMs = 2500,
): Promise<HelloResponse> {
  const res = await fetchWithTimeout(
    `${baseUrl(host, port)}/hello`,
    {headers: {[HEADER_TOKEN]: token}},
    timeoutMs,
  );
  if (!res.ok) {
    throw await errorFrom(res);
  }
  const body = (await res.json()) as HelloResponse;
  if (body.app !== 'flicksend') {
    throw new Error('That is not a FlickSend laptop');
  }
  return body;
}

/**
 * Tries every address in the pairing at once and resolves with the first one
 * that answers. A laptop often has several (Wi-Fi, Ethernet, VPN, Hyper-V…).
 */
export function findReachableHost(
  p: Pairing,
  timeoutMs = 3000,
): Promise<{host: string; hello: HelloResponse}> {
  return new Promise((resolve, reject) => {
    let pending = p.hosts.length;
    let lastError: unknown = new Error('No addresses in pairing code');
    if (pending === 0) {
      reject(lastError);
      return;
    }
    for (const host of p.hosts) {
      hello(host, p.port, p.token, timeoutMs).then(
        h => resolve({host, hello: h}),
        err => {
          lastError = err;
          if (--pending === 0) {
            reject(lastError);
          }
        },
      );
    }
  });
}

export async function postFlick(
  host: string,
  p: Pairing,
  meta: FlickMeta,
): Promise<void> {
  const res = await fetchWithTimeout(
    `${baseUrl(host, p.port)}/flick`,
    {
      method: 'POST',
      headers: {[HEADER_TOKEN]: p.token, 'Content-Type': 'application/json'},
      body: JSON.stringify(meta),
    },
    8000,
  );
  if (!res.ok) {
    throw await errorFrom(res);
  }
}

/** Streams the file from disk to the laptop (no base64, no loading it into JS memory). */
export async function uploadContent(
  host: string,
  p: Pairing,
  meta: FlickMeta,
  fileUri: string,
  onProgress: (sent: number, total: number) => void,
): Promise<void> {
  const file = new File(fileUri);
  const result = await file.upload(
    `${baseUrl(host, p.port)}/flick/${meta.id}/content`,
    {
      httpMethod: 'PUT',
      uploadType: UploadType.BINARY_CONTENT,
      mimeType: meta.mime,
      headers: {
        [HEADER_TOKEN]: p.token,
        [HEADER_FILE_NAME]: encodeURIComponent(meta.name),
        'Content-Type': meta.mime,
      },
      onProgress: e => onProgress(e.bytesSent, e.totalBytes),
    },
  );
  if (result.status !== 200) {
    let message = `HTTP ${result.status}`;
    try {
      message = JSON.parse(result.body).error ?? message;
    } catch {
      // not JSON
    }
    throw new Error(message);
  }
}
