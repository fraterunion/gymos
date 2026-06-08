import { useEffect, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

import { FitnessImages } from '@/lib/imagery';

type Props = {
  uri?: string | null;
  style?: StyleProp<ViewStyle>;
  vignette?: boolean;
};

const FALLBACK_URI = FitnessImages.performance;

export function ImageSlot({ uri, style, vignette = false }: Props) {
  const [failedUri, setFailedUri] = useState<string | null>(null);

  useEffect(() => {
    setFailedUri(null);
  }, [uri]);

  const primaryUri = uri?.trim() || null;
  const useFallback = !primaryUri || failedUri === primaryUri;
  const sourceUri = useFallback ? FALLBACK_URI : primaryUri;

  if (__DEV__) {
    console.log('[ImageSlot] render', {
      primary: primaryUri,
      fallback: FALLBACK_URI,
      final: sourceUri,
      usingFallback: useFallback,
    });
  }

  return (
    <View style={[{ backgroundColor: '#161618', overflow: 'hidden' }, style]}>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: '#1A1A1C' }]} />
      <Image
        key={sourceUri}
        source={{ uri: sourceUri }}
        style={StyleSheet.absoluteFill}
        resizeMode="cover"
        onLoad={() => {
          if (__DEV__) {
            console.log('[ImageSlot] loaded ✓', sourceUri);
          }
        }}
        onError={(e) => {
          // Always log — visible via adb logcat even in production EAS builds.
          console.warn('[ImageSlot] error', sourceUri, (e.nativeEvent as { error?: string } | undefined)?.error);
          if (!useFallback) {
            setFailedUri(primaryUri);
          }
        }}
      />
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
