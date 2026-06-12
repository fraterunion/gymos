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
import { getColors, Space } from '@/constants/Theme';

function searchParam(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0];
}

export default function LoginScreen() {
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

  const { user, hydrated, login, busy, error, clearError } = useAuth();
  const { primaryColor, appDisplayName } = useBranding();
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
              Welcome back
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
              Sign in to {appDisplayName}
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
            <Field
              label="Email"
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              placeholder="Enter your email"
              value={email}
              onChangeText={setEmail}
            />
            <Field
              label="Password"
              secureTextEntry
              autoComplete="password"
              placeholder="Enter your password"
              value={password}
              onChangeText={setPassword}
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
              label="Log In"
              variant="white"
              accentColor={primaryColor}
              loading={busy}
              onPress={() => void onSubmit()}
            />

            <View style={{ marginTop: 12 }}>
              <Link href={{ pathname: '/(auth)/register', params: authLinkParams }} asChild>
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
                    Create an account
                  </Text>
                </Pressable>
              </Link>
            </View>
          </View>

          <View style={{ marginTop: 'auto', alignItems: 'center', paddingTop: 48, opacity: 0.4 }}>
            <Text style={{ fontSize: 11, letterSpacing: 0.8, color: C.textMute, textTransform: 'uppercase' }}>
              Secured member access
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
