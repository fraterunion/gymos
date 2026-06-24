import { Stack } from 'expo-router';
import { useColorScheme } from 'react-native';

export default function BillingStackLayout() {
  const colorScheme = useColorScheme();
  const headerBg = colorScheme === 'dark' ? '#0a0a0a' : '#fafafa';

  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerShadowVisible: false,
        headerStyle: { backgroundColor: headerBg },
        headerTintColor: colorScheme === 'dark' ? '#fafafa' : '#171717',
        headerBackTitle: 'Atrás',
        headerTitleStyle: { fontWeight: '600', fontSize: 17 },
      }}>
      <Stack.Screen name="success" options={{ title: 'Pago' }} />
      <Stack.Screen name="cancel" options={{ title: 'Pago' }} />
      <Stack.Screen name="return" options={{ title: 'Membresía' }} />
    </Stack>
  );
}
