import { Image } from 'expo-image';
import { View } from 'react-native';

import {
  getBootSplashScreenSource,
  getBootWordmarkSource,
  getBootWordmarkSize,
} from '@/components/BrandWordmark';
import { hideNativeSplashWhenReady } from '@/lib/nativeSplash';

type Props = {
  logoUrl?: string | null;
};

function onBootSurfaceLayout() {
  hideNativeSplashWhenReady();
}

export function PremiumBootScreen({ logoUrl }: Props) {
  const fullSplash = getBootSplashScreenSource();

  if (fullSplash) {
    return (
      <View
        style={{ flex: 1, backgroundColor: '#000000' }}
        onLayout={onBootSurfaceLayout}
      >
        <Image
          accessibilityIgnoresInvertColors
          source={fullSplash}
          contentFit="contain"
          transition={0}
          style={{ flex: 1, width: '100%', height: '100%' }}
          cachePolicy="memory-disk"
        />
      </View>
    );
  }

  const bundled = getBootWordmarkSource();
  const { width, height } = getBootWordmarkSize();
  const source = bundled ?? (logoUrl?.trim() ? { uri: logoUrl.trim() } : null);

  return (
    <View
      style={{ flex: 1, backgroundColor: '#000000', alignItems: 'center', justifyContent: 'center' }}
      onLayout={onBootSurfaceLayout}
    >
      {source ? (
        <Image
          accessibilityIgnoresInvertColors
          source={source}
          contentFit="contain"
          transition={0}
          style={{ width, height }}
          cachePolicy="memory-disk"
        />
      ) : null}
    </View>
  );
}
