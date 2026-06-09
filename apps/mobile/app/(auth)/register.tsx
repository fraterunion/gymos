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
import { getColors, Space } from '@/constants/Theme';

function searchParam(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0];
}

export default function RegisterScreen() {
  const router = useRouter();
  const C = getColors();
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
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            flexGrow: 1,
            paddingHorizontal: Space.screenH,
            paddingBottom: 40,
            paddingTop: 8,
          }}
        >
          <View style={{ paddingTop: 12, marginBottom: 32 }}>
            <Text
              style={{
                fontSize: 34,
                fontWeight: '800',
                letterSpacing: -1.1,
                color: C.text,
                lineHeight: 40,
              }}
            >
              Join {appDisplayName}
            </Text>
            <Text
              style={{
                fontSize: 15,
                color: C.textSub,
                marginTop: 10,
                lineHeight: 22,
                letterSpacing: -0.1,
              }}
            >
              Create your member account
            </Text>
          </View>

          <View
            style={{
              backgroundColor: '#141416',
              borderRadius: 28,
              borderWidth: 1,
              borderColor: C.separator,
              padding: 28,
            }}
          >
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Field
                  label="First name"
                  autoComplete="given-name"
                  value={firstName}
                  onChangeText={setFirstName}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Field
                  label="Last name"
                  autoComplete="family-name"
                  value={lastName}
                  onChangeText={setLastName}
                />
              </View>
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
              autoComplete="new-password"
              value={password}
              onChangeText={setPassword}
              placeholder="Min. 8 characters"
            />

            {combinedError ? (
              <Text
                style={{
                  marginBottom: 16,
                  textAlign: 'center',
                  fontSize: 14,
                  color: C.negative,
                  lineHeight: 20,
                }}
              >
                {combinedError}
              </Text>
            ) : null}

            <BrandButton
              label="Create account"
              accentColor={primaryColor}
              loading={busy}
              onPress={() => void onSubmit()}
            />
          </View>

          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'center',
              alignItems: 'center',
              marginTop: 28,
              gap: 6,
            }}
          >
            <Text style={{ fontSize: 14, color: C.textMute }}>Already a member?</Text>
            <Link href={{ pathname: '/(auth)/login', params: authLinkParams }} asChild>
              <Pressable hitSlop={8}>
                <Text style={{ fontSize: 14, fontWeight: '600', color: C.text }}>
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
