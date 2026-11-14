import AsyncStorage from '@react-native-async-storage/async-storage';
import type {Pairing} from '../../../shared/protocol';

const KEY = 'flicksend.pairing.v1';

export async function loadPairing(): Promise<Pairing | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) {
      return null;
    }
    const p = JSON.parse(raw) as Pairing;
    return Array.isArray(p.hosts) && p.port && p.token ? p : null;
  } catch {
    return null;
  }
}

export async function savePairing(p: Pairing): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(p));
}

export async function clearPairing(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}
