import Constants from 'expo-constants';
import { Image, Text, View } from 'react-native';

import { getColors } from '@/constants/Theme';

type Props = {
  /** Remote brand logo (from branding API). Falls back to a typographic lockup. */
  logoUrl?: string | null;
};

/**
 * Brand lockup for boot/loading surfaces.
 *
 * Uses the build-time app display name (APP_DISPLAY_NAME via app.config.js) so it
 * works before branding has hydrated and never shows the studio slug.
 * When a real logo asset is added (e.g. assets/brand/ares-training-club-logo.png),
 * swap the typographic fallback for an <Image source={require(...)}> here.
 */
export function BrandWordmark({ logoUrl }: Props) {
  const C = getColors();
  const displayName = Constants.expoConfig?.name?.trim() || 'GymOS';

  if (logoUrl) {
    return (
      <Image
        accessibilityIgnoresInvertColors
        source={{ uri: logoUrl }}
        resizeMode="contain"
        style={{ width: 220, height: 88 }}
      />
    );
  }

  const [first, ...rest] = displayName.split(/\s+/);
  const tagline = rest.join(' ');

  return (
    <View style={{ alignItems: 'center' }}>
      <Text
        style={{
          fontSize: 42,
          fontWeight: '900',
          letterSpacing: 8,
          color: C.text,
          textTransform: 'uppercase',
          textAlign: 'center',
        }}
      >
        {first}
      </Text>
      {tagline ? (
        <Text
          style={{
            marginTop: 8,
            fontSize: 13,
            fontWeight: '600',
            letterSpacing: 5,
            color: 'rgba(255,255,255,0.55)',
            textTransform: 'uppercase',
            textAlign: 'center',
          }}
        >
          {tagline}
        </Text>
      ) : null}
    </View>
  );
}
