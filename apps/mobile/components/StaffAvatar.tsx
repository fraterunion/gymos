import { Image } from 'expo-image';
import { Text, View, type ViewStyle } from 'react-native';

import { staffAvatarPalette, staffInitials } from '@/lib/staffAvatar';

type Props = {
  userId: string;
  firstName: string;
  lastName?: string | null;
  photoUrl?: string | null;
  size?: number;
  style?: ViewStyle;
};

export function StaffAvatar({
  userId,
  firstName,
  lastName,
  photoUrl,
  size = 48,
  style,
}: Props) {
  const palette = staffAvatarPalette(userId);
  const initials = staffInitials(firstName, lastName);
  const fontSize = Math.round(size * 0.36);

  return (
    <View
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: palette.bg,
          borderWidth: 1,
          borderColor: palette.ring,
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        },
        style,
      ]}
    >
      {photoUrl ? (
        <Image
          source={{ uri: photoUrl }}
          style={{ width: size, height: size }}
          contentFit="cover"
          accessibilityLabel={`Foto de ${firstName}`}
        />
      ) : (
        <Text
          style={{
            fontSize,
            fontWeight: '800',
            letterSpacing: -0.5,
            color: palette.text,
          }}
        >
          {initials}
        </Text>
      )}
    </View>
  );
}
