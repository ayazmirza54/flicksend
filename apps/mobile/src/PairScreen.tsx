import {CameraView, useCameraPermissions} from 'expo-camera';
import * as Haptics from 'expo-haptics';
import {useCallback, useRef, useState} from 'react';
import {ActivityIndicator, Pressable, StyleSheet, Text, View} from 'react-native';
import {parsePairingUri} from '../../../shared/protocol';
import type {Pairing} from '../../../shared/protocol';
import {findReachableHost} from './api';
import {savePairing} from './storage';
import {C} from './theme';

export function PairScreen({onPaired}: {onPaired: (p: Pairing, host: string) => void}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const lastCode = useRef<string>('');

  const onCode = useCallback(
    async (data: string) => {
      if (busy || data === lastCode.current) {
        return;
      }
      lastCode.current = data;
      const pairing = parsePairingUri(data);
      if (!pairing) {
        setMessage("That QR code isn't a FlickSend pairing code.");
        return;
      }
      setBusy(true);
      setMessage(`Connecting to ${pairing.name}…`);
      try {
        const {host, hello} = await findReachableHost(pairing);
        // Remember the address that worked first, so next launch is instant.
        const saved: Pairing = {
          ...pairing,
          name: hello.name || pairing.name,
          hosts: [host, ...pairing.hosts.filter(h => h !== host)],
        };
        await savePairing(saved);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        onPaired(saved, host);
      } catch (e) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setMessage(
          `Found ${pairing.name}, but couldn't reach it (${String(
            (e as Error)?.message ?? e,
          )}).\n\nMake sure the phone and laptop are on the same Wi-Fi, and that Windows Firewall allows FlickSend on private networks.`,
        );
        // Allow rescanning the same code.
        lastCode.current = '';
      } finally {
        setBusy(false);
      }
    },
    [busy, onPaired],
  );

  if (!permission) {
    return <View style={styles.root} />;
  }

  if (!permission.granted) {
    return (
      <View style={[styles.root, styles.center]}>
        <Text style={styles.title}>Pair with your laptop</Text>
        <Text style={styles.body}>
          Open FlickSend on your laptop and scan the QR code it shows.
        </Text>
        <Pressable style={styles.button} onPress={requestPermission}>
          <Text style={styles.buttonText}>Allow camera</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{barcodeTypes: ['qr']}}
        onBarcodeScanned={busy ? undefined : r => onCode(r.data)}
      />
      <View style={styles.overlay} pointerEvents="none">
        <Text style={styles.title}>Scan the code on your laptop</Text>
        <View style={styles.frame} />
      </View>
      {(message || busy) && (
        <View style={styles.sheet}>
          {busy && <ActivityIndicator color={C.accent} style={{marginBottom: 8}} />}
          {message && <Text style={styles.body}>{message}</Text>}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: C.bg},
  center: {alignItems: 'center', justifyContent: 'center', padding: 32},
  overlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  frame: {
    marginTop: 24,
    width: 260,
    height: 260,
    borderRadius: 28,
    borderWidth: 3,
    borderColor: '#ffffffcc',
  },
  title: {color: C.text, fontSize: 22, fontWeight: '700', textAlign: 'center'},
  body: {color: C.dim, fontSize: 15, lineHeight: 21, textAlign: 'center', marginTop: 8},
  button: {
    marginTop: 24,
    backgroundColor: C.accent,
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 14,
  },
  buttonText: {color: '#fff', fontWeight: '700', fontSize: 16},
  sheet: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 40,
    padding: 18,
    borderRadius: 18,
    backgroundColor: '#17171fee',
    alignItems: 'center',
  },
});
