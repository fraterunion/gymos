import { Stack } from 'expo-router';

export default function AuthLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerShadowVisible: false,
        headerTitle: '',
        headerStyle: { backgroundColor: 'transparent' },
        headerTintColor: '#FFFFFF',
        contentStyle: { backgroundColor: '#0A0A0A' },
      }}
    />
  );
}
