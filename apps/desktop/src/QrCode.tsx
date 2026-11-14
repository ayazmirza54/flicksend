import React, {useMemo} from 'react';
import {StyleSheet, View} from 'react-native';
import qrcode from 'qrcode-generator';

interface Props {
  value: string;
  size: number;
  color?: string;
  background?: string;
}

/**
 * Renders a QR code with plain Views (no SVG dependency, works on RN Windows).
 * Consecutive dark modules in a row are merged into one View to keep the tree small.
 */
export function QrCode({value, size, color = '#0b0b10', background = '#ffffff'}: Props) {
  const {rows, count} = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    const runs: Array<Array<[number, number]>> = [];
    for (let r = 0; r < n; r++) {
      const row: Array<[number, number]> = [];
      let c = 0;
      while (c < n) {
        if (qr.isDark(r, c)) {
          const start = c;
          while (c < n && qr.isDark(r, c)) {
            c++;
          }
          row.push([start, c - start]);
        } else {
          c++;
        }
      }
      runs.push(row);
    }
    return {rows: runs, count: n};
  }, [value]);

  const quiet = 4; // quiet-zone modules on each side
  const cell = Math.floor(size / (count + quiet * 2));
  const inner = cell * count;
  const outer = inner + cell * quiet * 2;

  return (
    <View style={[styles.box, {width: outer, height: outer, backgroundColor: background}]}>
      <View style={{width: inner, height: inner, margin: cell * quiet}}>
        {rows.map((row, r) =>
          row.map(([start, len]) => (
            <View
              key={`${r}-${start}`}
              style={{
                position: 'absolute',
                top: r * cell,
                left: start * cell,
                width: len * cell,
                height: cell,
                backgroundColor: color,
              }}
            />
          )),
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    borderRadius: 16,
    overflow: 'hidden',
  },
});
