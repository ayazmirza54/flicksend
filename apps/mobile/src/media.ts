import {File} from 'expo-file-system';
import {ImageManipulator, SaveFormat} from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import * as VideoThumbnails from 'expo-video-thumbnails';
import type {MediaKind} from '../../../shared/protocol';

export interface PickedMedia {
  key: string;
  uri: string;
  kind: MediaKind;
  mime: string;
  name: string;
  size: number;
  width: number;
  height: number;
  durationMs?: number;
  /** data: URI, filled in in the background after picking. */
  thumbnail?: string;
}

const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  '3gp': 'video/3gpp',
  mkv: 'video/x-matroska',
};

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

let counter = 0;

export async function pickMedia(): Promise<PickedMedia[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images', 'videos'],
    allowsMultipleSelection: true,
    selectionLimit: 20,
    quality: 1,
    exif: false,
  });
  if (result.canceled) {
    return [];
  }
  return result.assets.map(a => {
    const name = a.fileName || a.uri.split('/').pop() || 'flick';
    const kind: MediaKind = a.type === 'video' ? 'video' : 'image';
    const mime =
      a.mimeType || EXT_MIME[extOf(name)] || (kind === 'video' ? 'video/mp4' : 'image/jpeg');
    let size = a.fileSize ?? 0;
    if (!size) {
      try {
        size = new File(a.uri).size ?? 0;
      } catch {
        size = 0;
      }
    }
    return {
      key: `${Date.now()}-${counter++}`,
      uri: a.uri,
      kind,
      mime,
      name,
      size,
      width: a.width,
      height: a.height,
      durationMs: a.duration ?? undefined,
    };
  });
}

/** Small JPEG preview (longest side 480px) the laptop can show instantly. */
export async function makeThumbnail(m: PickedMedia): Promise<string> {
  let source = m.uri;
  if (m.kind === 'video') {
    const t = await VideoThumbnails.getThumbnailAsync(m.uri, {time: 300, quality: 0.7});
    source = t.uri;
  }
  const landscape = m.width >= m.height;
  const ctx = ImageManipulator.manipulate(source).resize(
    landscape ? {width: 480} : {height: 480},
  );
  const image = await ctx.renderAsync();
  try {
    const saved = await image.saveAsync({base64: true, compress: 0.6, format: SaveFormat.JPEG});
    if (!saved.base64) {
      throw new Error('thumbnail encoding failed');
    }
    return `data:image/jpeg;base64,${saved.base64}`;
  } finally {
    image.release();
    ctx.release();
  }
}

export function formatDuration(ms?: number): string {
  if (!ms) {
    return '';
  }
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function formatBytes(n: number): string {
  if (!n) {
    return '';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
