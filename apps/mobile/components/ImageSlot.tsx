import { useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import type { LayoutChangeEvent, StyleProp, ViewStyle } from 'react-native';

import { FitnessImages } from '@/lib/imagery';

type Props = {
  uri?: string | null;
  style?: StyleProp<ViewStyle>;
  vignette?: boolean;
};

const FALLBACK_URI = FitnessImages.performance;

// Incrementing ID so each slot instance is identifiable across logs.
let _slotCounter = 0;

type DebugStatus = '...' | 'LOADING' | 'OK' | string; // string covers 'ERR: ...'

export function ImageSlot({ uri, style, vignette = false }: Props) {
  const slotId = useRef(++_slotCounter).current;
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const [debugStatus, setDebugStatus] = useState<DebugStatus>('...');
  const [layoutDims, setLayoutDims] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    setFailedUri(null);
    setDebugStatus('...');
  }, [uri]);

  const primaryUri = uri?.trim() || null;
  const useFallback = !primaryUri || failedUri === primaryUri;
  const sourceUri = useFallback ? FALLBACK_URI : primaryUri;

  // ── Always-on diagnostics ─────────────────────────────────────────────────
  // Not gated on __DEV__ — readable via:  adb logcat | grep ImageSlotNativeDebug
  console.log(
    `[ImageSlotNativeDebug] id=${slotId} RENDER` +
    ` | uri_prop=${String(uri ?? 'undefined')}` +
    ` | primary=${String(primaryUri)}` +
    ` | fallback=${FALLBACK_URI}` +
    ` | failedUri=${String(failedUri)}` +
    ` | final=${sourceUri}` +
    ` | usingFallback=${useFallback}`,
  );
  // ─────────────────────────────────────────────────────────────────────────

  function handleLayout(e: LayoutChangeEvent) {
    const { width, height } = e.nativeEvent.layout;
    setLayoutDims({ w: width, h: height });
    console.log(
      `[ImageSlotNativeDebug] id=${slotId} LAYOUT | width=${width} height=${height}`,
    );
  }

  const isError = debugStatus.startsWith('ERR');
  const overlayLabel = !sourceUri ? 'NO URI' : `${useFallback ? 'FB' : 'PRI'} ${debugStatus}`;
  const labelColor = !sourceUri || isError ? '#FF4444' : debugStatus === 'OK' ? '#00FF88' : '#FFAA00';

  return (
    <View
      onLayout={handleLayout}
      style={[{ backgroundColor: '#161618', overflow: 'hidden' }, style]}
    >
      <View style={[StyleSheet.absoluteFill, { backgroundColor: '#1A1A1C' }]} />

      <Image
        key={sourceUri}
        source={{ uri: sourceUri }}
        style={StyleSheet.absoluteFill}
        resizeMode="cover"
        onLoadStart={() => {
          setDebugStatus('LOADING');
          console.log(
            `[ImageSlotNativeDebug] id=${slotId} onLoadStart | uri=${sourceUri}`,
          );
        }}
        onLoad={() => {
          setDebugStatus('OK');
          console.log(
            `[ImageSlotNativeDebug] id=${slotId} onLoad OK | uri=${sourceUri}`,
          );
        }}
        onError={(e) => {
          const err =
            (e.nativeEvent as { error?: string } | undefined)?.error ?? 'unknown';
          setDebugStatus(`ERR: ${err.slice(0, 60)}`);
          // Always log — visible in adb logcat on production builds.
          console.warn(
            `[ImageSlotNativeDebug] id=${slotId} onError | uri=${sourceUri} | error=${err}`,
          );
          if (!useFallback) {
            setFailedUri(primaryUri);
          }
        }}
      />

      {/* ── TEMP DEBUG OVERLAY — remove after diagnosis ───────────────────── */}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: 2,
          left: 2,
          backgroundColor: 'rgba(0,0,0,0.80)',
          borderRadius: 3,
          paddingHorizontal: 4,
          paddingVertical: 2,
        }}
      >
        <Text
          numberOfLines={2}
          style={{ color: labelColor, fontSize: 8, fontWeight: '700' }}
        >
          {overlayLabel}
          {layoutDims ? ` [${layoutDims.w}x${layoutDims.h}]` : ''}
        </Text>
      </View>
      {/* ─────────────────────────────────────────────────────────────────── */}

      {vignette ? (
        <>
          <View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.12)' }]}
          />
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              height: '50%',
              backgroundColor: 'rgba(0,0,0,0.42)',
            }}
          />
        </>
      ) : null}
    </View>
  );
}
