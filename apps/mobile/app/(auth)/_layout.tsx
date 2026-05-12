import { Stack } from 'expo-router';

export default function AuthLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerShadowVisible: false,
        headerTitle: '',
        headerStyle: { backgroundColor: 'transparent' },
        headerTintColor: '#171717',
        contentStyle: { backgroundColor: 'transparent' },
      }}
    />
  );
}
