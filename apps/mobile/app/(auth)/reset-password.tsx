import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BrandButton } from '@/components/BrandButton';
import { Field } from '@/components/Field';
import { useBranding } from '@/contexts/BrandingContext';
import { resetPasswordRequest } from '@/lib/api/auth';
import { ApiError } from '@/lib/api/errors';
import { getColors, Space } from '@/constants/Theme';

/**
 * Step 2 of recovery. Reached either by deep link (<scheme>://reset-password?token=…, which
 * expo-router maps onto this route) or manually from the confirmation screen.
 *
 * The API answers every bad-token case — unknown, expired, already used, superseded — with
 * one identical error, and so does this screen: distinguishing them would tell an attacker
 * which tokens once existed. The recovery action is the same in all cases: request a new link.
 */

const MIN_PASSWORD_LENGTH = 8;

function searchParam(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0];
}

export default function ResetPasswordScreen() {
  const router = useRouter();
  const C = getColors();
  const { primaryColor } = useBranding();
  const params = useLocalSearchParams<{ token?: string | string[] }>();

  const [token, setToken] = useState(searchParam(params.token) ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit() {
    setError(null);
    if (!token.trim()) {
      setError('Falta el código de restablecimiento. Abre el enlace de tu correo.');
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
      return;
    }
    if (password !== confirm) {
      setError('Las contraseñas no coinciden.');
      return;
    }
    setBusy(true);
    try {
      await resetPasswordRequest(token.trim(), password);
      setDone(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) {
        setError(
          'El restablecimiento de contraseña no está disponible. Contacta a tu estudio para recuperar tu acceso.',
        );
      } else if (e instanceof ApiError && e.status === 400) {
        // Server-supplied, already generic (invalid/expired/used share one message).
        setError(e.message);
      } else if (e instanceof ApiError && e.status === 429) {
        setError('Demasiados intentos. Espera unos minutos e inténtalo de nuevo.');
      } else {
        setError('No pudimos actualizar tu contraseña. Revisa tu conexión e inténtalo de nuevo.');
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
              {done ? 'Contraseña actualizada' : 'Nueva contraseña'}
            </Text>
            <Text
              style={{
                fontSize: 15,
                color: C.textSub,
                marginTop: 10,
                lineHeight: 22,
              }}
            >
              {done
                ? 'Tu contraseña fue actualizada y se cerraron las demás sesiones. Ya puedes iniciar sesión.'
                : `Elige una contraseña de al menos ${MIN_PASSWORD_LENGTH} caracteres.`}
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
            {done ? (
              <BrandButton
                label="Iniciar sesión"
                variant="white"
                accentColor={primaryColor}
                onPress={() => router.replace('/(auth)/login' as Href)}
              />
            ) : (
              <>
                {searchParam(params.token) ? null : (
                  <Field
                    label="Código del correo"
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="Pega aquí el código del enlace"
                    value={token}
                    onChangeText={setToken}
                  />
                )}
                <Field
                  label="Nueva contraseña"
                  showPasswordToggle
                  secureTextEntry
                  autoComplete="password-new"
                  textContentType="newPassword"
                  placeholder="Mínimo 8 caracteres"
                  value={password}
                  onChangeText={setPassword}
                />
                <Field
                  label="Confirmar contraseña"
                  showPasswordToggle
                  secureTextEntry
                  autoComplete="password-new"
                  textContentType="newPassword"
                  placeholder="Repite tu contraseña"
                  value={confirm}
                  onChangeText={setConfirm}
                />

                {error ? (
                  <View style={{ marginBottom: 16 }}>
                    <Text
                      style={{
                        textAlign: 'center',
                        fontSize: 14,
                        color: C.negative,
                        lineHeight: 20,
                      }}
                    >
                      {error}
                    </Text>
                  </View>
                ) : null}

                <BrandButton
                  label="Guardar contraseña"
                  variant="white"
                  accentColor={primaryColor}
                  loading={busy}
                  onPress={() => void onSubmit()}
                />

                <View style={{ marginTop: 12 }}>
                  <BrandButton
                    label="Solicitar un enlace nuevo"
                    variant="ghost"
                    accentColor={primaryColor}
                    onPress={() => router.replace('/(auth)/forgot-password' as Href)}
                  />
                </View>
              </>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
