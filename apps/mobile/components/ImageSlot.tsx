import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

import { FitnessImages } from '@/lib/imagery';

type Props = {
  uri?: string | null;
  style?: StyleProp<ViewStyle>;
  vignette?: boolean;
};

const FALLBACK_URI = FitnessImages.performance;

export function ImageSlot({ uri, style, vignette = false }: Props) {
  const sourceUri = uri?.trim() || null;

  return (
    <View style={[{ backgroundColor: '#161618', overflow: 'hidden' }, style]}>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: '#1A1A1C' }]} />
      <Image
        source={sourceUri ? { uri: sourceUri } : undefined}
        placeholder={{ uri: FALLBACK_URI }}
        contentFit="cover"
        style={StyleSheet.absoluteFill}
        onError={() => {
          if (__DEV__) {
            console.warn('[ImageSlot] failed to load:', sourceUri);
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
