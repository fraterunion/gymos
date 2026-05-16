import { Image, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

type Props = {
  /** Remote or local image URI. When absent, renders an atmospheric dark placeholder. */
  uri?: string | null;
  style?: StyleProp<ViewStyle>;
  /**
   * Applies a bottom-to-top vignette (simulated gradient) so text overlaid at the
   * bottom of the slot remains legible. Defaults to true.
   */
  vignette?: boolean;
};

const FILL = { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0 };

export function ImageSlot({ uri, style, vignette = true }: Props) {
  return (
    <View style={[{ backgroundColor: '#141414', overflow: 'hidden' }, style]}>
      {uri ? (
        <Image source={{ uri }} style={FILL} resizeMode="cover" />
      ) : (
        // Atmospheric placeholder — layered dark tones simulate a studio environment.
        // Two subtle lighter patches give the impression of off-camera light sources.
        <>
          <View style={{ ...FILL, backgroundColor: '#171717' }} />
          <View
            style={{
              position: 'absolute',
              top: '8%',
              left: '12%',
              right: '35%',
              bottom: '35%',
              backgroundColor: 'rgba(255,255,255,0.022)',
              borderRadius: 999,
            }}
          />
          <View
            style={{
              position: 'absolute',
              top: '45%',
              right: '8%',
              width: '22%',
              bottom: '18%',
              backgroundColor: 'rgba(255,255,255,0.010)',
              borderRadius: 999,
            }}
          />
        </>
      )}

      {/*
        Simulated bottom-to-top vignette: four stacked semi-transparent layers that
        progressively darken toward the bottom. Alpha compositing gives ~0.70 effective
        opacity at the base — enough for white text to read clearly.
      */}
      {vignette && (
        <>
          <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '80%', backgroundColor: 'rgba(0,0,0,0.12)' }} />
          <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '60%', backgroundColor: 'rgba(0,0,0,0.22)' }} />
          <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '40%', backgroundColor: 'rgba(0,0,0,0.35)' }} />
          <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '22%', backgroundColor: 'rgba(0,0,0,0.35)' }} />
        </>
      )}
    </View>
  );
}
