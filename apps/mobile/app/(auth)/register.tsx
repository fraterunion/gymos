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
import { getStudioSlug } from '@/lib/env';

function searchParam(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0];
}

export default function RegisterScreen() {
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

  const { user, hydrated, register, busy, error, clearError } = useAuth();
  const { primaryColor, appDisplayName } = useBranding();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
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
    if (!firstName.trim() || !lastName.trim()) {
      setLocalError('First and last name are required.');
      return;
    }
    if (!email.trim()) {
      setLocalError('Email is required.');
      return;
    }
    if (password.length < 8) {
      setLocalError('Password must be at least 8 characters.');
      return;
    }
    try {
      const studioSlug = getStudioSlug();
      await register({
        email: email.trim(),
        password,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        ...(studioSlug ? { studioSlug } : {}),
      });
    } catch {
      // error in context
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
          <View className="mb-8 mt-4">
            <Text className="text-3xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
              Join {appDisplayName}
            </Text>
            <Text className="mt-2 text-base text-neutral-600 dark:text-neutral-400">
              Create your member account
            </Text>
          </View>

          <Field label="First name" autoComplete="given-name" value={firstName} onChangeText={setFirstName} />
          <Field label="Last name" autoComplete="family-name" value={lastName} onChangeText={setLastName} />
          <Field
            label="Email"
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
          />
          <Field
            label="Password (min 8 characters)"
            secureTextEntry
            autoComplete="new-password"
            value={password}
            onChangeText={setPassword}
          />

          {combinedError ? (
            <Text className="mb-4 text-center text-sm text-red-500">{combinedError}</Text>
          ) : null}

          <BrandButton
            label="Create account"
            accentColor={primaryColor}
            loading={busy}
            onPress={() => void onSubmit()}
          />

          <View className="mt-10 flex-row justify-center gap-1">
            <Text className="text-neutral-600 dark:text-neutral-400">Already a member?</Text>
            <Link href={{ pathname: '/(auth)/login', params: authLinkParams }} asChild>
              <Pressable>
                <Text className="font-semibold" style={{ color: primaryColor }}>
                  Sign in
                </Text>
              </Pressable>
            </Link>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
