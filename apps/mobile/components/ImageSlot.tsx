import { useState } from 'react';
import { Image, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

/**
 * Flip to false once images are confirmed loading in the target build.
 * When true every ImageSlot renders a small badge:
 *   blue   = URI provided
 *   grey   = no URI (placeholder only)
 *   amber  = loading
 *   green  = loaded ✓
 *   red    = load error ✗
 */
const SHOW_IMAGE_DEBUG = true;

type Props = {
  /** Remote image URI. Fades in over the atmospheric placeholder when loaded. */
  uri?: string | null;
  style?: StyleProp<ViewStyle>;
  /** Bottom-to-top vignette for text legibility. Defaults to true. */
  vignette?: boolean;
};

const FILL = { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0 };

type ImgState = 'loading' | 'loaded' | 'error';

const DEBUG_BADGE: Record<ImgState, string> = {
  loading: 'rgba(180,120,0,0.92)',
  loaded:  'rgba(0,160,0,0.92)',
  error:   'rgba(200,0,0,0.92)',
};

function FadeImage({ uri }: { uri: string }) {
  const [imgState, setImgState] = useState<ImgState>('loading');
  const opacity = useSharedValue(0);
  const animStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <>
      <Animated.View style={[FILL, animStyle]}>
        <Image
          source={{ uri }}
          style={FILL}
          resizeMode="cover"
          onLoad={() => {
            console.log(`[ImageSlot] ✓ loaded: ${uri.slice(0, 100)}`);
            setImgState('loaded');
            opacity.value = withTiming(1, { duration: 700 });
          }}
          onError={({ nativeEvent: { error } }) => {
            console.warn(`[ImageSlot] ✗ error: ${uri.slice(0, 100)}`, error);
            setImgState('error');
          }}
        />
      </Animated.View>

      {SHOW_IMAGE_DEBUG ? (
        <View
          style={{
            position: 'absolute',
            top: 5,
            right: 5,
            backgroundColor: DEBUG_BADGE[imgState],
            paddingHorizontal: 5,
            paddingVertical: 2,
            borderRadius: 3,
          }}
        >
          <Text style={{ fontSize: 8, fontWeight: '800', color: '#fff', letterSpacing: 0.3 }}>
            {imgState === 'loaded' ? 'IMG OK' : imgState === 'error' ? 'IMG ERR' : 'IMG…'}
          </Text>
        </View>
      ) : null}
    </>
  );
}

export function ImageSlot({ uri, style, vignette = true }: Props) {
  return (
    <View style={[{ backgroundColor: '#0F0F11', overflow: 'hidden' }, style]}>
      {/* Atmospheric placeholder — always visible beneath the real image */}
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

      {/* URI presence badge — bottom-left corner */}
      {SHOW_IMAGE_DEBUG ? (
        <View
          style={{
            position: 'absolute',
            bottom: 5,
            left: 5,
            backgroundColor: uri ? 'rgba(0,70,200,0.92)' : 'rgba(70,70,70,0.92)',
            paddingHorizontal: 5,
            paddingVertical: 2,
            borderRadius: 3,
          }}
        >
          <Text style={{ fontSize: 8, fontWeight: '800', color: '#fff', letterSpacing: 0.3 }}>
            {uri ? 'URI ✓' : 'NO URI'}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
