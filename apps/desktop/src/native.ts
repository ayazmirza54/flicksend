import {DeviceEventEmitter, NativeModules, TurboModuleRegistry} from 'react-native';
import type {TurboModule} from 'react-native';
import {
  EVENT_COMPLETE,
  EVENT_ERROR,
  EVENT_INCOMING,
  EVENT_PROGRESS,
} from '../../../shared/protocol';
import type {
  CompleteEvent,
  ErrorEvent,
  FlickMeta,
  ProgressEvent,
} from '../../../shared/protocol';

export interface ServerInfo {
  port: number;
  token: string;
  name: string;
  hosts: string[];
  saveDir: string;
}

interface FlickServerSpec extends TurboModule {
  start(): Promise<string>;
  setOverlay(on: boolean): void;
  openFile(path: string): void;
  revealFile(path: string): void;
}

const mod: FlickServerSpec | null =
  TurboModuleRegistry.get<FlickServerSpec>('FlickServer') ??
  (NativeModules.FlickServer as FlickServerSpec | undefined) ??
  null;

export const isNativeAvailable = mod != null;

function requireModule(): FlickServerSpec {
  if (!mod) {
    throw new Error(
      'FlickServer native module not found. Run the app with `npm run windows`.',
    );
  }
  return mod;
}

export async function startServer(): Promise<ServerInfo> {
  const json = await requireModule().start();
  return JSON.parse(json) as ServerInfo;
}

export function setOverlay(on: boolean): void {
  mod?.setOverlay(on);
}

export function openFile(path: string): void {
  mod?.openFile(path);
}

export function revealFile(path: string): void {
  mod?.revealFile(path);
}

export interface FlickHandlers {
  onIncoming(meta: FlickMeta): void;
  onProgress(e: ProgressEvent): void;
  onComplete(e: CompleteEvent): void;
  onError(e: ErrorEvent): void;
}

function parse<T>(payload: unknown): T | null {
  try {
    return (typeof payload === 'string' ? JSON.parse(payload) : payload) as T;
  } catch {
    return null;
  }
}

/** Subscribes to native server events. Returns an unsubscribe function. */
export function subscribe(handlers: FlickHandlers): () => void {
  const subs = [
    DeviceEventEmitter.addListener(EVENT_INCOMING, (p: unknown) => {
      const meta = parse<FlickMeta>(p);
      if (meta && typeof meta.id === 'string') {
        handlers.onIncoming(meta);
      }
    }),
    DeviceEventEmitter.addListener(EVENT_PROGRESS, (p: unknown) => {
      const e = parse<ProgressEvent>(p);
      if (e) {
        handlers.onProgress(e);
      }
    }),
    DeviceEventEmitter.addListener(EVENT_COMPLETE, (p: unknown) => {
      const e = parse<CompleteEvent>(p);
      if (e) {
        handlers.onComplete(e);
      }
    }),
    DeviceEventEmitter.addListener(EVENT_ERROR, (p: unknown) => {
      const e = parse<ErrorEvent>(p);
      if (e) {
        handlers.onError(e);
      }
    }),
  ];
  return () => subs.forEach(s => s.remove());
}
