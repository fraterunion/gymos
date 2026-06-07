import { useState } from 'react';
import { Image, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

import { FitnessImages } from '@/lib/imagery';

type Props = {
  uri?: string | null;
  style?: StyleProp<ViewStyle>;
  vignette?: boolean;
};

const FALLBACK_URI = FitnessImages.performance;

export function ImageSlot({ uri, style, vignette = false }: Props) {
  const [failed, setFailed] = useState(false);
  const sourceUri = uri && !failed ? uri : FALLBACK_URI;

  return (
    <View style={[{ backgroundColor: '#141416', overflow: 'hidden' }, style]}>
      <Image
        source={{ uri: sourceUri }}
        style={{ width: '100%', height: '100%' }}
        resizeMode="cover"
        onError={() => setFailed(true)}
      />
      {vignette ? (
        <>
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(0,0,0,0.16)',
            }}
          />
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              height: '55%',
              backgroundColor: 'rgba(0,0,0,0.50)',
            }}
          />
        </>
      ) : null}
    </View>
  );
}
