import Constants from 'expo-constants';
import { Image, Text, View, type ImageSourcePropType } from 'react-native';

import { getColors } from '@/constants/Theme';
import { getWhitelabelBuildProfile } from '@/lib/env';

type Props = {
  /** Remote brand logo (from branding API). Used when no bundled logo exists. */
  logoUrl?: string | null;
};

/**
 * Bundled brand logos per white-label profile. These win over the remote
 * logoUrl because they are available before branding hydrates (boot/loading)
 * and are the approved marks for the build.
 */
const LOCAL_BRAND_LOGOS: Record<string, ImageSourcePropType> = {
  ares: require('../assets/brand/ares-training-club-logo.png'),
};

/**
 * Brand lockup for boot/loading surfaces.
 *
 * Resolution order: bundled per-profile logo → remote branding logoUrl →
 * typographic lockup from the build-time app display name (APP_DISPLAY_NAME
 * via app.config.js), which never shows the studio slug.
 */
export function BrandWordmark({ logoUrl }: Props) {
  const C = getColors();
  const localLogo = LOCAL_BRAND_LOGOS[getWhitelabelBuildProfile()];

  if (localLogo) {
    return (
      <Image
        accessibilityIgnoresInvertColors
        source={localLogo}
        resizeMode="contain"
        style={{ width: 240, height: 82 }}
      />
    );
  }

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

  const displayName = Constants.expoConfig?.name?.trim() || 'GymOS';
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
