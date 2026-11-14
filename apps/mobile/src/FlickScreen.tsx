import * as Device from 'expo-device';
import * as Haptics from 'expo-haptics';
import {useCallback, useEffect, useRef, useState} from 'react';
import {Image, Pressable, StyleSheet, Text, View, useWindowDimensions} from 'react-native';
import {GestureDetector, usePanGesture} from 'react-native-gesture-handler';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import {scheduleOnRN} from 'react-native-worklets';
import {newFlickId} from '../../../shared/protocol';
import type {FlickDirection, FlickMeta, Pairing} from '../../../shared/protocol';
import {findReachableHost, hello, postFlick, uploadContent} from './api';
import {formatBytes, formatDuration, makeThumbnail, pickMedia} from './media';
import type {PickedMedia} from './media';
import {C} from './theme';

/** Upward speed (points/s) that counts as a flick. */
const FLICK_VELOCITY = -900;
/** …and the minimum upward travel, so a tap-jitter never sends. */
const FLICK_MIN_DISTANCE = -40;

type SendStatus = 'sending' | 'done' | 'error';
interface Send {
  id: string;
  name: string;
  preview?: string;
  status: SendStatus;
  sent: number;
  total: number;
  error?: string;
  media: PickedMedia;
}

export function FlickScreen({
  pairing,
  initialHost,
  onUnpair,
}: {
  pairing: Pairing;
  initialHost: string | null;
  onUnpair: () => void;
}) {
  const [deck, setDeck] = useState<PickedMedia[]>([]);
  const [sends, setSends] = useState<Send[]>([]);
  const [online, setOnline] = useState<boolean | null>(initialHost ? true : null);
  const hostRef = useRef<string | null>(initialHost);
  const thumbs = useRef(new Map<string, Promise<string | undefined>>());

  // ---- connection ---------------------------------------------------------
  const resolveHost = useCallback(async (): Promise<string> => {
    if (hostRef.current) {
      try {
        await hello(hostRef.current, pairing.port, pairing.token, 2000);
        setOnline(true);
        return hostRef.current;
      } catch {
        // fall through and rescan every address
      }
    }
    try {
      const {host} = await findReachableHost(pairing);
      hostRef.current = host;
      setOnline(true);
      return host;
    } catch (e) {
      hostRef.current = null;
      setOnline(false);
      throw e;
    }
  }, [pairing]);

  useEffect(() => {
    const check = () => {
      resolveHost().catch(() => {});
    };
    const first = setTimeout(check, 0);
    const every = setInterval(check, 15000);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [resolveHost]);

  // ---- thumbnails (prepared in the background right after picking) --------
  const ensureThumb = useCallback((m: PickedMedia) => {
    let p = thumbs.current.get(m.key);
    if (!p) {
      p = makeThumbnail(m).catch(() => undefined);
      thumbs.current.set(m.key, p);
      p.then(uri => {
        if (uri) {
          setDeck(prev => prev.map(x => (x.key === m.key ? {...x, thumbnail: uri} : x)));
        }
      });
    }
    return p;
  }, []);

  const pick = useCallback(async () => {
    const picked = await pickMedia();
    if (picked.length === 0) {
      return;
    }
    setDeck(prev => [...picked.reverse(), ...prev]);
    picked.forEach(ensureThumb);
  }, [ensureThumb]);

  // ---- sending ------------------------------------------------------------
  const patchSend = (id: string, patch: Partial<Send>) =>
    setSends(prev => prev.map(s => (s.id === id ? {...s, ...patch} : s)));

  const send = useCallback(
    async (m: PickedMedia, direction: FlickDirection) => {
      const id = newFlickId();
      setSends(prev =>
        [
          {
            id,
            name: m.name,
            preview: m.kind === 'video' ? m.thumbnail : m.uri,
            status: 'sending' as const,
            sent: 0,
            total: m.size,
            media: m,
          },
          ...prev,
        ].slice(0, 20),
      );
      try {
        const host = await resolveHost();
        const thumbnail = await ensureThumb(m);
        const meta: FlickMeta = {
          id,
          kind: m.kind,
          mime: m.mime,
          name: m.name,
          size: m.size,
          width: m.width,
          height: m.height,
          durationMs: m.durationMs,
          thumbnail,
          direction,
          from: Device.modelName ?? 'Phone',
          sentAt: Date.now(),
        };
        // 1) metadata + preview: the laptop starts its fly-in animation now.
        await postFlick(host, pairing, meta);
        // 2) the full file, streamed.
        await uploadContent(host, pairing, meta, m.uri, (sent, total) =>
          patchSend(id, {sent, total: total || m.size}),
        );
        patchSend(id, {status: 'done', sent: m.size});
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (e) {
        patchSend(id, {status: 'error', error: String((e as Error)?.message ?? e)});
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    },
    [pairing, resolveHost, ensureThumb],
  );

  const onFlick = useCallback(
    (direction: FlickDirection) => {
      const top = deck[0];
      if (!top) {
        return;
      }
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      send(top, direction);
      // Let the fly-off animation finish before the card leaves the deck.
      setTimeout(() => setDeck(prev => prev.filter(x => x.key !== top.key)), 260);
    },
    [deck, send],
  );

  // Tap a finished row to dismiss it; tap a failed one to try again.
  const onSendPress = useCallback(
    (s: Send) => {
      setSends(prev => prev.filter(x => x.id !== s.id));
      if (s.status === 'error') {
        send(s.media, 'up');
      }
    },
    [send],
  );

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View style={styles.target}>
          <View
            style={[
              styles.dot,
              {backgroundColor: online ? C.ok : online === false ? C.danger : C.dim},
            ]}
          />
          <Text style={styles.targetText} numberOfLines={1}>
            {pairing.name}
            {online === false ? '  ·  offline' : ''}
          </Text>
        </View>
        <Pressable onPress={onUnpair} hitSlop={12}>
          <Text style={styles.link}>Unpair</Text>
        </Pressable>
      </View>

      <View style={styles.stage}>
        {deck.length === 0 ? (
          <Pressable style={styles.empty} onPress={pick}>
            <Text style={styles.emptyIcon}>＋</Text>
            <Text style={styles.emptyTitle}>Choose photos & videos</Text>
            <Text style={styles.emptyBody}>Then flick them up to {pairing.name}.</Text>
          </Pressable>
        ) : (
          <>
            {deck
              .slice(1, 3)
              .reverse()
              .map((m, i, arr) => (
                <BackCard key={m.key} item={m} depth={arr.length - i} />
              ))}
            <TopCard key={deck[0].key} item={deck[0]} onFlick={onFlick} />
          </>
        )}
      </View>

      <View style={styles.footer}>
        {deck.length > 0 && (
          <View style={styles.hintRow}>
            <Text style={styles.hint}>↑ Flick up to send</Text>
            <Pressable onPress={pick} hitSlop={10}>
              <Text style={styles.link}>Add more</Text>
            </Pressable>
          </View>
        )}
        {sends.slice(0, 4).map(s => (
          <SendRow key={s.id} s={s} onPress={() => onSendPress(s)} />
        ))}
      </View>
    </View>
  );
}

function cardSize(item: PickedMedia, screenW: number, screenH: number) {
  const maxW = screenW - 48;
  const maxH = screenH * 0.58;
  const aspect = item.width && item.height ? item.width / item.height : 3 / 4;
  let w = maxW;
  let h = w / aspect;
  if (h > maxH) {
    h = maxH;
    w = h * aspect;
  }
  return {w, h};
}

function CardContent({item}: {item: PickedMedia}) {
  const source = item.kind === 'video' ? item.thumbnail : item.uri;
  return (
    <>
      {source ? (
        <Image source={{uri: source}} style={StyleSheet.absoluteFill} resizeMode="cover" />
      ) : (
        <View style={[StyleSheet.absoluteFill, {backgroundColor: C.panel}]} />
      )}
      {item.kind === 'video' && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>▶ {formatDuration(item.durationMs)}</Text>
        </View>
      )}
    </>
  );
}

function BackCard({item, depth}: {item: PickedMedia; depth: number}) {
  const {width, height} = useWindowDimensions();
  const {w, h} = cardSize(item, width, height);
  return (
    <View
      style={[
        styles.card,
        {
          width: w,
          height: h,
          opacity: 0.55,
          transform: [{translateY: depth * 14}, {scale: 1 - depth * 0.05}],
        },
      ]}>
      <CardContent item={item} />
    </View>
  );
}

function TopCard({
  item,
  onFlick,
}: {
  item: PickedMedia;
  onFlick: (direction: FlickDirection) => void;
}) {
  const {width, height} = useWindowDimensions();
  const {w, h} = cardSize(item, width, height);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const flying = useSharedValue(false);

  const pan = usePanGesture({
    onUpdate: e => {
      'worklet';
      if (flying.value) {
        return;
      }
      tx.value = e.translationX;
      ty.value = e.translationY;
    },
    onDeactivate: e => {
      'worklet';
      if (flying.value) {
        return;
      }
      const flicked =
        !e.canceled &&
        ((e.velocityY < FLICK_VELOCITY && e.translationY < FLICK_MIN_DISTANCE) ||
          e.translationY < -height * 0.35);
      if (flicked) {
        flying.value = true;
        const direction: FlickDirection =
          e.velocityX < -600 ? 'up-left' : e.velocityX > 600 ? 'up-right' : 'up';
        tx.value = withTiming(tx.value + e.velocityX * 0.15, {duration: 240});
        ty.value = withTiming(-height * 1.1, {duration: 240});
        scheduleOnRN(onFlick, direction);
      } else {
        tx.value = withSpring(0, {damping: 14});
        ty.value = withSpring(0, {damping: 14});
      }
    },
  });

  const animated = useAnimatedStyle(() => ({
    transform: [
      {translateX: tx.value},
      {translateY: ty.value},
      {rotate: `${tx.value / 18}deg`},
      {scale: interpolate(ty.value, [-height, 0], [0.75, 1], Extrapolation.CLAMP)},
    ],
  }));

  const glow = useAnimatedStyle(() => ({
    opacity: interpolate(ty.value, [-160, -20], [1, 0], Extrapolation.CLAMP),
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[styles.card, styles.topCard, {width: w, height: h}, animated]}>
        <CardContent item={item} />
        <Animated.View style={[styles.glow, glow]} pointerEvents="none">
          <Text style={styles.glowText}>Release to send</Text>
        </Animated.View>
        <View style={styles.caption} pointerEvents="none">
          <Text style={styles.captionText} numberOfLines={1}>
            {item.name}
          </Text>
          <Text style={styles.captionSub}>{formatBytes(item.size)}</Text>
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

function SendRow({s, onPress}: {s: Send; onPress: () => void}) {
  const pct = s.total ? Math.min(100, Math.round((s.sent / s.total) * 100)) : 0;
  return (
    <Pressable style={styles.sendRow} onPress={s.status !== 'sending' ? onPress : undefined}>
      {s.preview ? (
        <Image source={{uri: s.preview}} style={styles.sendThumb} />
      ) : (
        <View style={[styles.sendThumb, {backgroundColor: C.border}]} />
      )}
      <View style={{flex: 1, marginLeft: 10}}>
        <Text style={styles.sendName} numberOfLines={1}>
          {s.name}
        </Text>
        {s.status === 'sending' ? (
          <View style={styles.track}>
            <View style={[styles.fill, {width: `${pct}%`}]} />
          </View>
        ) : (
          <Text
            style={[styles.sendSub, {color: s.status === 'done' ? C.ok : C.danger}]}
            numberOfLines={2}>
            {s.status === 'done' ? 'On your laptop' : `Failed: ${s.error} · tap to retry`}
          </Text>
        )}
      </View>
      <Text style={styles.sendPct}>
        {s.status === 'sending' ? `${pct}%` : s.status === 'done' ? '✓' : '!'}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: C.bg},
  header: {
    paddingTop: 56,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  target: {flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 16},
  dot: {width: 10, height: 10, borderRadius: 5, marginRight: 8},
  targetText: {color: C.text, fontSize: 16, fontWeight: '600'},
  link: {color: C.accent, fontSize: 15, fontWeight: '600'},
  stage: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  empty: {
    width: '86%',
    aspectRatio: 0.8,
    borderRadius: 28,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  emptyIcon: {color: C.accent, fontSize: 56, fontWeight: '300'},
  emptyTitle: {color: C.text, fontSize: 20, fontWeight: '700', marginTop: 8},
  emptyBody: {color: C.dim, fontSize: 15, marginTop: 6, textAlign: 'center'},
  card: {
    position: 'absolute',
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: C.panel,
  },
  topCard: {
    borderWidth: 1,
    borderColor: '#ffffff22',
    elevation: 12,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 20,
    shadowOffset: {width: 0, height: 10},
  },
  badge: {
    position: 'absolute',
    top: 12,
    left: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
    backgroundColor: '#000000aa',
  },
  badgeText: {color: '#fff', fontSize: 13, fontWeight: '600'},
  glow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: '#7c5cffcc',
  },
  glowText: {color: '#fff', fontWeight: '800', letterSpacing: 0.5},
  caption: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: 14,
    backgroundColor: '#00000088',
  },
  captionText: {color: '#fff', fontSize: 14, fontWeight: '600'},
  captionSub: {color: '#ffffffaa', fontSize: 12, marginTop: 2},
  footer: {paddingHorizontal: 16, paddingBottom: 32, minHeight: 120},
  hintRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  hint: {color: C.dim, fontSize: 15},
  sendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    marginTop: 8,
    borderRadius: 14,
    backgroundColor: C.panel,
  },
  sendThumb: {width: 40, height: 40, borderRadius: 8},
  sendName: {color: C.text, fontSize: 14},
  sendSub: {fontSize: 12, marginTop: 3},
  sendPct: {color: C.dim, fontSize: 13, marginLeft: 10, minWidth: 34, textAlign: 'right'},
  track: {
    marginTop: 6,
    height: 5,
    borderRadius: 3,
    backgroundColor: '#ffffff1a',
    overflow: 'hidden',
  },
  fill: {height: 5, borderRadius: 3, backgroundColor: C.accent2},
});
