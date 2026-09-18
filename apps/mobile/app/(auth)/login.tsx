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
import { fetchAuthCapabilities } from '@/lib/api/auth';
import {
  RECOVERY_PROBE_FAILED,
  RECOVERY_PROBE_PENDING,
  recoveryProbeResolved,
  shouldShowForgotPasswordAction,
  type RecoveryProbeState,
} from '@/lib/auth/passwordRecovery';
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
  // Recovery is a per-environment capability. The decision lives in a pure module so the
  // "a failed probe must never hide the way back in" rule is covered by tests.
  const [recoveryProbe, setRecoveryProbe] = useState<RecoveryProbeState>(RECOVERY_PROBE_PENDING);
  const recoveryAvailable = shouldShowForgotPasswordAction(recoveryProbe);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const caps = await fetchAuthCapabilities();
        if (!cancelled) setRecoveryProbe(recoveryProbeResolved(caps.passwordRecoveryEnabled));
      } catch {
        // Never blocks login, and deliberately leaves the action visible.
        if (!cancelled) setRecoveryProbe(RECOVERY_PROBE_FAILED);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
      setLocalError('Ingresa tu correo y contraseña.');
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
              Bienvenido de nuevo
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
              Inicia sesión en {appDisplayName}
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
              label="Correo"
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              placeholder="Ingresa tu correo"
              value={email}
              onChangeText={setEmail}
            />
            <Field
              label="Contraseña"
              showPasswordToggle
              secureTextEntry
              autoComplete="password"
              textContentType="password"
              placeholder="Ingresa tu contraseña"
              value={password}
              onChangeText={setPassword}
            />

            {recoveryAvailable ? (
              <View style={{ marginTop: -6, marginBottom: 18, alignItems: 'flex-end' }}>
                <Link href={'/(auth)/forgot-password' as Href} asChild>
                  <Pressable
                    accessibilityRole="link"
                    accessibilityLabel="¿Olvidaste tu contraseña?"
                    accessibilityHint="Abre la pantalla para recibir instrucciones por correo"
                    hitSlop={{ top: 12, bottom: 12, left: 16, right: 8 }}
                    style={({ pressed }) => ({
                      paddingVertical: 8,
                      paddingHorizontal: 2,
                      opacity: pressed ? 0.6 : 1,
                    })}
                  >
                    <Text
                      style={{
                        fontSize: 14,
                        fontWeight: '600',
                        letterSpacing: -0.1,
                        color: C.textSub,
                      }}
                    >
                      ¿Olvidaste tu contraseña?
                    </Text>
                  </Pressable>
                </Link>
              </View>
            ) : null}

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
              label="Iniciar sesión"
              variant="white"
              accentColor={primaryColor}
              loading={busy}
              onPress={() => void onSubmit()}
            />

            <View style={{ marginTop: 16 }}>
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
                    Crear una cuenta
                  </Text>
                </Pressable>
              </Link>
            </View>
          </View>

          <View style={{ marginTop: 'auto', alignItems: 'center', paddingTop: 48, opacity: 0.4 }}>
            <Text style={{ fontSize: 11, letterSpacing: 0.8, color: C.textMute, textTransform: 'uppercase' }}>
              Acceso seguro para miembros
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
