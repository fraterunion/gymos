import { useCallback, useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { Link, useFocusEffect, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BrandButton } from '@/components/BrandButton';
import { Field } from '@/components/Field';
import { useAuth } from '@/contexts/AuthContext';
import { useBranding } from '@/contexts/BrandingContext';

function searchParam(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0];
}

export default function LoginScreen() {
  const router = useRouter();
  const searchParams = useLocalSearchParams<{
    returnTo?: string | string[];
    intent?: string | string[];
  }>();
  const returnTo = searchParam(searchParams.returnTo);
  const intent = searchParam(searchParams.intent);
  const destination = returnTo || '/(app)/(tabs)';
  const authLinkParams = {
    ...(returnTo ? { returnTo } : {}),
    ...(intent ? { intent } : {}),
  };

  const { user, hydrated, login, busy, error, clearError } = useAuth();
  const { primaryColor, appDisplayName, logoUrl } = useBranding();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (hydrated && user) {
      router.replace(destination as Href);
    }
  }, [hydrated, user, router, destination]);

  useFocusEffect(
    useCallback(() => {
      clearError();
    }, [clearError]),
  );

  async function onSubmit() {
    setLocalError(null);
    if (!email.trim() || !password) {
      setLocalError('Enter email and password.');
      return;
    }
    try {
      await login(email.trim(), password);
    } catch {
      // surfaced via context error or local
    }
  }

  const combinedError = localError || error;

  return (
    <SafeAreaView className="flex-1 bg-neutral-50 dark:bg-neutral-950">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1">
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerClassName="grow px-6 pb-10 pt-4"
          contentContainerStyle={{ flexGrow: 1 }}>
          <View className="mb-10 mt-4">
            <Text className="text-3xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
              Welcome back
            </Text>
            <Text className="mt-2 text-base text-neutral-600 dark:text-neutral-400">
              Sign in to {appDisplayName}
            </Text>
          </View>

          <Field
            label="Email"
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
          />
          <Field
            label="Password"
            secureTextEntry
            autoComplete="password"
            value={password}
            onChangeText={setPassword}
          />

          {combinedError ? (
            <Text className="mb-4 text-center text-sm text-red-500">{combinedError}</Text>
          ) : null}

          <BrandButton
            label="Sign in"
            accentColor={primaryColor}
            loading={busy}
            onPress={() => void onSubmit()}
          />

          <View className="mt-10 flex-row justify-center gap-1">
            <Text className="text-neutral-600 dark:text-neutral-400">New here?</Text>
            <Link href={{ pathname: '/(auth)/register', params: authLinkParams }} asChild>
              <Pressable>
                <Text className="font-semibold" style={{ color: primaryColor }}>
                  Create an account
                </Text>
              </Pressable>
            </Link>
          </View>

          {logoUrl ? (
            <View className="mt-auto items-center pt-12 opacity-40">
              <Text className="text-xs text-neutral-500">Secured member access</Text>
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
