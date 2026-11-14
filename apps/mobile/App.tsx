import {StatusBar} from 'expo-status-bar';
import {useCallback, useEffect, useState} from 'react';
import {ActivityIndicator, StyleSheet, View} from 'react-native';
import {GestureHandlerRootView} from 'react-native-gesture-handler';
import type {Pairing} from '../../shared/protocol';
import {FlickScreen} from './src/FlickScreen';
import {PairScreen} from './src/PairScreen';
import {clearPairing, loadPairing} from './src/storage';
import {C} from './src/theme';

type State =
  | {phase: 'loading'}
  | {phase: 'pair'}
  | {phase: 'ready'; pairing: Pairing; host: string | null};

export default function App() {
  const [state, setState] = useState<State>({phase: 'loading'});

  useEffect(() => {
    loadPairing().then(p =>
      setState(p ? {phase: 'ready', pairing: p, host: null} : {phase: 'pair'}),
    );
  }, []);

  const unpair = useCallback(async () => {
    await clearPairing();
    setState({phase: 'pair'});
  }, []);

  return (
    <GestureHandlerRootView style={styles.root}>
      <StatusBar style="light" />
      {state.phase === 'loading' && (
        <View style={styles.center}>
          <ActivityIndicator color={C.accent} />
        </View>
      )}
      {state.phase === 'pair' && (
        <PairScreen onPaired={(pairing, host) => setState({phase: 'ready', pairing, host})} />
      )}
      {state.phase === 'ready' && (
        <FlickScreen pairing={state.pairing} initialHost={state.host} onUnpair={unpair} />
      )}
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: C.bg},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center'},
});
