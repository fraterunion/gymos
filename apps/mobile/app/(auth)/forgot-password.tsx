import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BrandButton } from '@/components/BrandButton';
import { Field } from '@/components/Field';
import { useBranding } from '@/contexts/BrandingContext';
import { forgotPasswordRequest } from '@/lib/api/auth';
import { ApiError } from '@/lib/api/errors';
import { canSubmitRecoveryRequest, normalizeRecoveryEmail } from '@/lib/auth/passwordRecovery';
import { getColors, Space } from '@/constants/Theme';

/**
 * Step 1 of recovery. The server answers identically whether or not the address exists, so
 * this screen shows one confirmation state and never hints at account existence.
 */
export default function ForgotPasswordScreen() {
  const router = useRouter();
  const C = getColors();
  const { primaryColor, slug: studioSlug } = useBranding();

  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit() {
    setError(null);
    // Also blocks a second request while one is in flight (double tap on a slow network).
    if (!canSubmitRecoveryRequest(email, busy)) {
      if (!busy) setError('Ingresa tu correo.');
      return;
    }
    const trimmed = normalizeRecoveryEmail(email);
    setBusy(true);
    try {
      await forgotPasswordRequest(trimmed, studioSlug || undefined);
      setSent(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) {
        // Recovery is switched off for this environment — the same answer for everyone,
        // so this still reveals nothing about the address.
        setError(
          'El restablecimiento de contraseña no está disponible. Contacta a tu estudio para recuperar tu acceso.',
        );
      } else if (e instanceof ApiError && e.status === 429) {
        setError('Demasiados intentos. Espera unos minutos e inténtalo de nuevo.');
      } else if (e instanceof ApiError && e.status === 400) {
        setError('Ingresa un correo válido.');
      } else {
        setError('No pudimos enviar el correo. Revisa tu conexión e inténtalo de nuevo.');
      }
    } finally {
      setBusy(false);
    }
  }

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
                fontSize: 32,
                fontWeight: '800',
                letterSpacing: -1,
                color: C.text,
                lineHeight: 38,
              }}
            >
              {sent ? 'Revisa tu correo' : '¿Olvidaste tu contraseña?'}
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
              {sent
                ? 'Si existe una cuenta asociada a este correo, recibirás instrucciones para restablecer tu contraseña.'
                : 'Ingresa el correo asociado a tu cuenta y te enviaremos instrucciones para crear una nueva contraseña.'}
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
            {sent ? (
              <>
                <Text
                  style={{
                    fontSize: 14,
                    color: C.textSub,
                    lineHeight: 21,
                    marginBottom: 20,
                  }}
                >
                  El enlace caduca en 30 minutos y solo puede utilizarse una vez. Si no lo
                  encuentras, revisa tu carpeta de spam.
                </Text>
                <BrandButton
                  label="Volver a iniciar sesión"
                  variant="white"
                  accentColor={primaryColor}
                  onPress={() => router.replace('/(auth)/login' as Href)}
                />
                <View style={{ marginTop: 12 }}>
                  {/* Fallback for a member whose mail client strips the link: the same
                      generic-error reset screen, reached by pasting the code. */}
                  <BrandButton
                    label="Ya tengo un código"
                    variant="ghost"
                    accentColor={primaryColor}
                    onPress={() => router.push('/(auth)/reset-password' as Href)}
                  />
                </View>
              </>
            ) : (
              <>
                <Field
                  label="Correo"
                  autoCapitalize="none"
                  autoComplete="email"
                  keyboardType="email-address"
                  placeholder="Ingresa tu correo"
                  value={email}
                  onChangeText={setEmail}
                />

                {error ? (
                  <Text
                    style={{
                      marginBottom: 16,
                      textAlign: 'center',
                      fontSize: 14,
                      color: C.negative,
                      lineHeight: 20,
                    }}
                  >
                    {error}
                  </Text>
                ) : null}

                <BrandButton
                  label="Enviar instrucciones"
                  variant="white"
                  accentColor={primaryColor}
                  loading={busy}
                  onPress={() => void onSubmit()}
                />

                <View style={{ marginTop: 12 }}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => router.back()}
                    style={({ pressed }) => ({
                      minHeight: 56,
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 14,
                      backgroundColor: pressed ? 'rgba(255,255,255,0.06)' : 'transparent',
                    })}
                  >
                    <Text style={{ fontSize: 15, fontWeight: '600', color: C.textSub }}>
                      Volver
                    </Text>
                  </Pressable>
                </View>
              </>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
