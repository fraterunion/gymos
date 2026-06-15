import { useCallback, useEffect, useMemo, useState } from 'react';
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
  const [confirmPassword, setConfirmPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [confirmTouched, setConfirmTouched] = useState(false);

  const passwordsMismatch = useMemo(
    () => confirmPassword.length > 0 && password !== confirmPassword,
    [password, confirmPassword],
  );

  const confirmPasswordError = useMemo(() => {
    if (!confirmTouched && !localError) return null;
    if (passwordsMismatch) return 'Passwords do not match.';
    return null;
  }, [confirmTouched, localError, passwordsMismatch]);

  const canSubmit =
    !busy &&
    firstName.trim().length > 0 &&
    lastName.trim().length > 0 &&
    email.trim().length > 0 &&
    password.length >= 8 &&
    confirmPassword.length > 0 &&
    !passwordsMismatch;

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
    setConfirmTouched(true);

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
    if (!confirmPassword) {
      setLocalError('Please confirm your password.');
      return;
    }
    if (password !== confirmPassword) {
      setLocalError('Passwords do not match.');
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

  const combinedError =
    localError && localError !== 'Passwords do not match.' ? localError : error;

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
              textContentType="emailAddress"
              placeholder="Enter your email"
              helperText="Used for your account, receipts, and support."
              value={email}
              onChangeText={setEmail}
            />
            <Field
              label="Password"
              showPasswordToggle
              secureTextEntry
              autoComplete="new-password"
              textContentType="newPassword"
              value={password}
              onChangeText={setPassword}
              placeholder="Min. 8 characters"
            />
            <Field
              label="Confirm password"
              showPasswordToggle
              secureTextEntry
              autoComplete="new-password"
              textContentType="newPassword"
              value={confirmPassword}
              onChangeText={(value) => {
                setConfirmPassword(value);
                if (!confirmTouched) setConfirmTouched(true);
              }}
              onBlur={() => setConfirmTouched(true)}
              placeholder="Re-enter your password"
              error={confirmPasswordError}
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
              label="Create Account"
              variant="white"
              accentColor={primaryColor}
              loading={busy}
              disabled={!canSubmit}
              onPress={() => void onSubmit()}
            />

            <View style={{ marginTop: 12 }}>
              <Link href={{ pathname: '/(auth)/login', params: authLinkParams }} asChild>
                <Pressable
                  accessibilityRole="button"
                  style={({ pressed }) => ({
                    minHeight: 56,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 14,
                    borderWidth: 1,
                    borderColor: 'rgba(255,255,255,0.35)',
                    backgroundColor: pressed ? 'rgba(255,255,255,0.06)' : 'transparent',
                  })}
                >
                  <Text
                    style={{
                      fontSize: 16,
                      fontWeight: '600',
                      letterSpacing: -0.1,
                      color: C.text,
                    }}
                  >
                    Log In
                  </Text>
                </Pressable>
              </Link>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
