import Constants from 'expo-constants';
import { Image } from 'expo-image';
import { PixelRatio, Text, View } from 'react-native';

import { getWhitelabelBuildProfile } from '@/lib/env';

/** Logical display width on boot surfaces. Asset is 1800px+ for @3x sharpness. */
const BOOT_LOGO_WIDTH = 228;

type ImageSource = number | { uri: string };

const LOCAL_BRAND_LOGOS: Record<string, ImageSource> = {
  ares: require('../assets/branding/ares/splash-wordmark.png'),
};

/** Intrinsic size of the bundled Ares splash wordmark (1800 × 461). */
const ARES_WORDMARK_ASPECT = 461 / 1800;

type Props = {
  /** Remote brand logo (from branding API). Used when no bundled logo exists. */
  logoUrl?: string | null;
  /** Override display width in logical pixels (default: boot width). */
  width?: number;
};

export function getBootWordmarkSource(): ImageSource | null {
  return LOCAL_BRAND_LOGOS[getWhitelabelBuildProfile()] ?? null;
}

export function getBootWordmarkSize(width = BOOT_LOGO_WIDTH): { width: number; height: number } {
  const profile = getWhitelabelBuildProfile();
  const aspect = profile === 'ares' ? ARES_WORDMARK_ASPECT : 82 / 240;
  const w = width;
  const h = Math.round(w * aspect);
  return { width: w, height: h };
}

/**
 * Brand lockup for boot/loading surfaces.
 *
 * Resolution order: bundled per-profile logo → remote branding logoUrl →
 * typographic lockup from the build-time app display name (APP_DISPLAY_NAME
 * via app.config.js), which never shows the studio slug.
 */
export function BrandWordmark({ logoUrl, width = BOOT_LOGO_WIDTH }: Props) {
  const localLogo = getBootWordmarkSource();
  const { width: w, height: h } = getBootWordmarkSize(width);

  if (localLogo) {
    return (
      <Image
        accessibilityIgnoresInvertColors
        source={localLogo}
        contentFit="contain"
        transition={0}
        style={{ width: w, height: h }}
        // Hint RN to pick a full-resolution decode on retina devices.
        cachePolicy="memory-disk"
      />
    );
  }

  if (logoUrl) {
    return (
      <Image
        accessibilityIgnoresInvertColors
        source={{ uri: logoUrl }}
        contentFit="contain"
        transition={0}
        style={{ width: w, height: h }}
        cachePolicy="memory-disk"
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
          color: '#FFFFFF',
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

/** Minimum bundled asset pixel width for the current display size (@3x safe). */
export function requiredWordmarkPixelWidth(displayWidth = BOOT_LOGO_WIDTH): number {
  return Math.ceil(displayWidth * PixelRatio.get());
}
