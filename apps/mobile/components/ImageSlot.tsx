import { Image, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

// Diagnostic phase — overlays, animations, and placeholders stripped out.
// Red background confirms container has dimensions.
// Raw Image with no wrappers or opacity.

type Props = {
  uri?: string | null;
  style?: StyleProp<ViewStyle>;
  vignette?: boolean; // ignored until images are confirmed working
};

export function ImageSlot({ uri, style }: Props) {
  return (
    <View style={[{ backgroundColor: 'red' }, style]}>
      <Image
        source={{ uri: uri ?? 'https://picsum.photos/800/600' }}
        style={{ width: '100%', height: '100%' }}
        resizeMode="cover"
      />
    </View>
  );
}
