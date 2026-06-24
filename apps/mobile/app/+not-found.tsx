import { Link, Stack } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getColors, Space } from '@/constants/Theme';

export default function NotFoundScreen() {
  const C = getColors();

  return (
    <>
      <Stack.Screen options={{ title: 'No encontrada', headerTintColor: C.text }} />
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <View
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: Space.screenH,
          }}
        >
          <Text
            style={{
              textAlign: 'center',
              fontSize: 22,
              fontWeight: '700',
              letterSpacing: -0.3,
              color: C.text,
            }}
          >
            Esta pantalla no existe.
          </Text>
          <Link href="/" asChild>
            <Pressable hitSlop={8} style={{ marginTop: 24 }}>
              <Text style={{ fontSize: 15, fontWeight: '600', color: C.text }}>Volver al inicio</Text>
            </Pressable>
          </Link>
        </View>
      </SafeAreaView>
    </>
  );
}
