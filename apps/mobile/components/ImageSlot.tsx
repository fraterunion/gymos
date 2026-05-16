import { Image, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

type Props = {
  /** Remote or local image URI. Fades in on load over the atmospheric placeholder. */
  uri?: string | null;
  style?: StyleProp<ViewStyle>;
  /**
   * Bottom-to-top vignette so overlaid text stays legible. Defaults to true.
   */
  vignette?: boolean;
};

const FILL = { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0 };

function FadeImage({ uri }: { uri: string }) {
  const opacity = useSharedValue(0);
  const animStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View style={[FILL, animStyle]}>
      <Image
        source={{ uri }}
        style={FILL}
        resizeMode="cover"
        onLoad={() => { opacity.value = withTiming(1, { duration: 700 }); }}
      />
    </Animated.View>
  );
}

export function ImageSlot({ uri, style, vignette = true }: Props) {
  return (
    <View style={[{ backgroundColor: '#0F0F11', overflow: 'hidden' }, style]}>
      {/* Atmospheric placeholder — always present beneath the image */}
      <View style={{ ...FILL, backgroundColor: '#161618' }} />
      {/* Warm off-camera key light top-left */}
      <View
        style={{
          position: 'absolute',
          top: '-12%',
          left: '-8%',
          width: '65%',
          height: '55%',
          backgroundColor: 'rgba(255,210,140,0.024)',
          borderRadius: 999,
        }}
      />
      {/* Cool rim back-light bottom-right */}
      <View
        style={{
          position: 'absolute',
          bottom: '15%',
          right: '-10%',
          width: '38%',
          height: '42%',
          backgroundColor: 'rgba(90,140,255,0.016)',
          borderRadius: 999,
        }}
      />

      {/* Real image fades in on top once loaded */}
      {uri ? <FadeImage key={uri} uri={uri} /> : null}

      {/* Cinematic bottom vignette — 4-layer composite */}
      {vignette && (
        <>
          <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '80%', backgroundColor: 'rgba(0,0,0,0.14)' }} />
          <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '60%', backgroundColor: 'rgba(0,0,0,0.26)' }} />
          <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '40%', backgroundColor: 'rgba(0,0,0,0.40)' }} />
          <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '22%', backgroundColor: 'rgba(0,0,0,0.42)' }} />
        </>
      )}
    </View>
  );
}
