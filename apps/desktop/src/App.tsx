import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Animated,
  Easing,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import {buildPairingUri} from '../../../shared/protocol';
import type {FlickMeta} from '../../../shared/protocol';
import {QrCode} from './QrCode';
import {
  isNativeAvailable,
  openFile,
  revealFile,
  setOverlay,
  startServer,
  subscribe,
} from './native';
import type {ServerInfo} from './native';

type Status = 'receiving' | 'done' | 'error';

interface FlickItem {
  meta: FlickMeta;
  status: Status;
  received: number;
  total: number;
  url?: string;
  path?: string;
  error?: string;
  arrivedAt: number;
}

const C = {
  bg: '#0e0e14',
  panel: '#17171f',
  border: '#262633',
  text: '#f2f2f7',
  dim: '#9a9aae',
  accent: '#7c5cff',
  accent2: '#22d3ee',
  danger: '#ff5c7a',
  stage: '#05050a',
};

function formatBytes(n: number): string {
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

export default function App() {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [items, setItems] = useState<Record<string, FlickItem>>({});
  const [stage, setStage] = useState<string[]>([]); // ids, newest last
  const stageOpen = stage.length > 0;
  const stageOpenRef = useRef(false);

  const update = useCallback((id: string, patch: Partial<FlickItem>) => {
    setItems(prev => (prev[id] ? {...prev, [id]: {...prev[id], ...patch}} : prev));
  }, []);

  useEffect(() => {
    if (!isNativeAvailable) {
      setStartError('Native FlickServer module missing. Launch with `npm run windows`.');
      return;
    }
    const unsubscribe = subscribe({
      onIncoming: meta => {
        setItems(prev => ({
          ...prev,
          [meta.id]: {
            meta,
            status: prev[meta.id]?.status ?? 'receiving',
            received: prev[meta.id]?.received ?? 0,
            total: meta.size,
            url: prev[meta.id]?.url,
            path: prev[meta.id]?.path,
            arrivedAt: Date.now(),
          },
        }));
        setStage(prev => [...prev.filter(x => x !== meta.id), meta.id]);
        if (!stageOpenRef.current) {
          stageOpenRef.current = true;
          setOverlay(true);
        }
      },
      onProgress: e =>
        update(e.id, {received: e.received, total: e.total || undefined}),
      onComplete: e => update(e.id, {status: 'done', url: e.url, path: e.path}),
      onError: e => update(e.id, {status: 'error', error: e.error}),
    });
    startServer().then(setInfo, err => setStartError(String(err?.message ?? err)));
    return unsubscribe;
  }, [update]);

  const closeStage = useCallback(() => {
    stageOpenRef.current = false;
    setStage([]);
    setOverlay(false);
  }, []);

  const recent = useMemo(
    () =>
      Object.values(items)
        .sort((a, b) => b.arrivedAt - a.arrivedAt)
        .slice(0, 12),
    [items],
  );

  if (stageOpen) {
    const current = items[stage[stage.length - 1]];
    return (
      <Stage
        item={current}
        others={stage.slice(0, -1).map(id => items[id]).filter(Boolean)}
        onPick={id => setStage(prev => [...prev.filter(x => x !== id), id])}
        onClose={closeStage}
      />
    );
  }

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.home}>
        <Text style={styles.logo}>
          Flick<Text style={{color: C.accent}}>Send</Text>
        </Text>
        <Text style={styles.subtitle}>
          Scan this with the FlickSend app on your phone, then flick photos and
          videos straight onto this screen.
        </Text>

        <View style={styles.qrPanel}>
          {info ? (
            info.hosts.length > 0 ? (
              <QrCode
                size={300}
                value={buildPairingUri({
                  hosts: info.hosts,
                  port: info.port,
                  token: info.token,
                  name: info.name,
                })}
              />
            ) : (
              <Text style={styles.warn}>
                This laptop isn't on a network. Connect to the same Wi-Fi as your
                phone, then restart FlickSend.
              </Text>
            )
          ) : startError ? (
            <Text style={styles.warn}>{startError}</Text>
          ) : (
            <Text style={styles.dim}>Starting receiver…</Text>
          )}
        </View>

        {info && (
          <View style={styles.meta}>
            <Text style={styles.metaText}>
              <Text style={styles.metaStrong}>{info.name}</Text>
              {'  ·  '}
              {info.hosts[0] ?? 'offline'}:{info.port}
            </Text>
            <Text style={styles.metaSmall}>Saving to {info.saveDir}</Text>
          </View>
        )}

        {recent.length > 0 && (
          <View style={styles.recent}>
            <Text style={styles.sectionTitle}>Recent flicks</Text>
            {recent.map(it => (
              <View key={it.meta.id} style={styles.recentRow}>
                {it.meta.thumbnail ? (
                  <Image source={{uri: it.meta.thumbnail}} style={styles.recentThumb} />
                ) : (
                  <View style={[styles.recentThumb, {backgroundColor: C.border}]} />
                )}
                <View style={styles.recentInfo}>
                  <Text style={styles.recentName} numberOfLines={1}>
                    {it.meta.name}
                  </Text>
                  <Text style={styles.metaSmall}>
                    {it.status === 'done'
                      ? `${it.meta.kind} · ${formatBytes(it.total || it.meta.size)}`
                      : it.status === 'error'
                        ? `Failed: ${it.error}`
                        : `Receiving… ${pct(it)}%`}
                  </Text>
                </View>
                {it.path && (
                  <>
                    <SmallButton label="Open" onPress={() => openFile(it.path!)} />
                    <SmallButton label="Show" onPress={() => revealFile(it.path!)} />
                  </>
                )}
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function pct(it: FlickItem): number {
  const total = it.total || it.meta.size;
  if (!total) {
    return 0;
  }
  return Math.min(100, Math.round((it.received / total) * 100));
}

function SmallButton({label, onPress}: {label: string; onPress: () => void}) {
  return (
    <Pressable
      onPress={onPress}
      style={({pressed}) => [styles.smallBtn, pressed && {opacity: 0.6}]}>
      <Text style={styles.smallBtnText}>{label}</Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Stage: the full-screen, always-on-top surface a flick lands on.

function Stage({
  item,
  others,
  onPick,
  onClose,
}: {
  item: FlickItem;
  others: FlickItem[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const {width, height} = useWindowDimensions();
  const fly = useRef(new Animated.Value(0)).current;
  const backdrop = useRef(new Animated.Value(0)).current;
  const fullOpacity = useRef(new Animated.Value(0)).current;

  // Re-run the fly-in whenever a new flick takes the stage.
  useEffect(() => {
    fly.setValue(0);
    fullOpacity.setValue(0);
    Animated.parallel([
      Animated.timing(backdrop, {
        toValue: 1,
        duration: 220,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.spring(fly, {
        toValue: 1,
        velocity: 3,
        tension: 70,
        friction: 9,
        useNativeDriver: true,
      }),
    ]).start();
  }, [item.meta.id, fly, backdrop, fullOpacity]);

  // Fit the media into ~78% of the screen, keeping its aspect ratio.
  const aspect =
    item.meta.width && item.meta.height ? item.meta.width / item.meta.height : 4 / 3;
  const maxW = width * 0.78;
  const maxH = height * 0.7;
  let cardW = maxW;
  let cardH = cardW / aspect;
  if (cardH > maxH) {
    cardH = maxH;
    cardW = cardH * aspect;
  }

  const translateY = fly.interpolate({inputRange: [0, 1], outputRange: [height, 0]});
  const scale = fly.interpolate({inputRange: [0, 1], outputRange: [0.55, 1]});
  const rotate = fly.interpolate({
    inputRange: [0, 1],
    outputRange: [item.meta.direction === 'up-left' ? '10deg' : '-10deg', '0deg'],
  });

  const isVideo = item.meta.kind === 'video';
  const showFull = !isVideo && item.status === 'done' && item.url;

  return (
    <Animated.View style={[styles.stage, {opacity: backdrop}]}>
      <View style={styles.stageTop}>
        <Text style={styles.stageFrom} numberOfLines={1}>
          {item.meta.from ? `From ${item.meta.from}` : 'Incoming flick'}
        </Text>
        <Pressable
          onPress={onClose}
          style={({pressed}) => [styles.closeBtn, pressed && {opacity: 0.6}]}>
          <Text style={styles.closeText}>✕</Text>
        </Pressable>
      </View>

      <Animated.View
        style={[
          styles.card,
          {width: cardW, height: cardH, transform: [{translateY}, {scale}, {rotate}]},
        ]}>
        {item.meta.thumbnail ? (
          <Image
            source={{uri: item.meta.thumbnail}}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
            blurRadius={showFull ? 0 : 2}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, {backgroundColor: C.panel}]} />
        )}
        {showFull && (
          <Animated.Image
            source={{uri: item.url}}
            style={[StyleSheet.absoluteFill, {opacity: fullOpacity}]}
            resizeMode="contain"
            onLoad={() =>
              Animated.timing(fullOpacity, {
                toValue: 1,
                duration: 250,
                useNativeDriver: true,
              }).start()
            }
          />
        )}
        {isVideo && (
          <Pressable
            disabled={item.status !== 'done'}
            onPress={() => item.path && openFile(item.path)}
            style={styles.playWrap}>
            <View style={[styles.playBtn, item.status !== 'done' && {opacity: 0.5}]}>
              <Text style={styles.playIcon}>▶</Text>
            </View>
          </Pressable>
        )}
      </Animated.View>

      <View style={styles.stageBottom}>
        <Text style={styles.stageName} numberOfLines={1}>
          {item.meta.name}
        </Text>
        {item.status === 'receiving' && (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, {width: `${pct(item)}%`}]} />
          </View>
        )}
        {item.status === 'error' && (
          <Text style={[styles.metaSmall, {color: C.danger}]}>
            Transfer failed: {item.error}
          </Text>
        )}
        <Text style={styles.metaSmall}>
          {item.status === 'receiving'
            ? `Receiving… ${pct(item)}%  ·  ${formatBytes(item.received)} of ${formatBytes(
                item.total || item.meta.size,
              )}`
            : item.status === 'done'
              ? `${formatBytes(item.total || item.meta.size)} · saved`
              : ''}
        </Text>
        <View style={styles.stageActions}>
          {item.path && isVideo && (
            <StageButton primary label="Play" onPress={() => openFile(item.path!)} />
          )}
          {item.path && !isVideo && (
            <StageButton label="Open" onPress={() => openFile(item.path!)} />
          )}
          {item.path && (
            <StageButton label="Show in folder" onPress={() => revealFile(item.path!)} />
          )}
          <StageButton label="Done" onPress={onClose} />
        </View>
        {others.length > 0 && (
          <View style={styles.strip}>
            {others.slice(-6).map(o => (
              <Pressable key={o.meta.id} onPress={() => onPick(o.meta.id)}>
                {o.meta.thumbnail ? (
                  <Image source={{uri: o.meta.thumbnail}} style={styles.stripThumb} />
                ) : (
                  <View style={[styles.stripThumb, {backgroundColor: C.border}]} />
                )}
              </Pressable>
            ))}
          </View>
        )}
      </View>
    </Animated.View>
  );
}

function StageButton({
  label,
  onPress,
  primary,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({pressed}) => [
        styles.stageBtn,
        primary && {backgroundColor: C.accent, borderColor: C.accent},
        pressed && {opacity: 0.7},
      ]}>
      <Text style={styles.stageBtnText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: C.bg},
  home: {alignItems: 'center', paddingVertical: 40, paddingHorizontal: 24},
  logo: {fontSize: 40, fontWeight: '800', color: C.text, letterSpacing: -1},
  subtitle: {
    marginTop: 8,
    color: C.dim,
    fontSize: 15,
    textAlign: 'center',
    maxWidth: 420,
    lineHeight: 21,
  },
  qrPanel: {
    marginTop: 28,
    padding: 18,
    borderRadius: 24,
    backgroundColor: C.panel,
    borderWidth: 1,
    borderColor: C.border,
    minWidth: 336,
    minHeight: 336,
    alignItems: 'center',
    justifyContent: 'center',
  },
  warn: {color: C.danger, fontSize: 14, textAlign: 'center', maxWidth: 280},
  dim: {color: C.dim},
  meta: {marginTop: 16, alignItems: 'center'},
  metaText: {color: C.dim, fontSize: 14},
  metaStrong: {color: C.text, fontWeight: '600'},
  metaSmall: {color: C.dim, fontSize: 12, marginTop: 4},
  recent: {marginTop: 32, width: '100%', maxWidth: 560},
  sectionTitle: {color: C.text, fontWeight: '700', fontSize: 15, marginBottom: 8},
  recentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  recentThumb: {width: 44, height: 44, borderRadius: 8},
  recentInfo: {flex: 1, marginLeft: 12},
  recentName: {color: C.text, fontSize: 14},
  smallBtn: {
    marginLeft: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.border,
  },
  smallBtnText: {color: C.text, fontSize: 12},

  stage: {
    flex: 1,
    backgroundColor: C.stage,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stageTop: {
    position: 'absolute',
    top: 24,
    left: 32,
    right: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  stageFrom: {color: C.dim, fontSize: 14},
  closeBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#ffffff14',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: {color: C.text, fontSize: 16},
  card: {
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: '#000',
    borderWidth: 1,
    borderColor: '#ffffff1f',
  },
  playWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBtn: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: '#000000aa',
    borderWidth: 2,
    borderColor: '#ffffffcc',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playIcon: {color: '#fff', fontSize: 32, marginLeft: 6},
  stageBottom: {marginTop: 22, alignItems: 'center', maxWidth: '80%'},
  stageName: {color: C.text, fontSize: 16, fontWeight: '600'},
  progressTrack: {
    marginTop: 10,
    width: 320,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#ffffff1a',
    overflow: 'hidden',
  },
  progressFill: {height: 6, borderRadius: 3, backgroundColor: C.accent2},
  stageActions: {flexDirection: 'row', marginTop: 16},
  stageBtn: {
    marginHorizontal: 6,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#ffffff33',
    backgroundColor: '#ffffff0d',
  },
  stageBtnText: {color: C.text, fontSize: 14, fontWeight: '600'},
  strip: {flexDirection: 'row', marginTop: 18},
  stripThumb: {width: 48, height: 48, borderRadius: 8, marginHorizontal: 4, opacity: 0.8},
});
