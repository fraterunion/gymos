import { Image } from 'expo-image';
import { View } from 'react-native';

import { getBootWordmarkSource, getBootWordmarkSize } from '@/components/BrandWordmark';

type Props = {
  logoUrl?: string | null;
};

export function PremiumBootScreen({ logoUrl }: Props) {
  const bundled = getBootWordmarkSource();
  const { width, height } = getBootWordmarkSize();
  const source = bundled ?? (logoUrl?.trim() ? { uri: logoUrl.trim() } : null);

  return (
    <View style={{ flex: 1, backgroundColor: '#000000', alignItems: 'center', justifyContent: 'center' }}>
      {source ? (
        <Image
          accessibilityIgnoresInvertColors
          source={source}
          contentFit="contain"
          transition={0}
          style={{ width, height }}
        />
      ) : null}
    </View>
  );
}
