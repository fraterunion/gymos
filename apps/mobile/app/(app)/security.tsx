import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BrandButton } from '@/components/BrandButton';
import { Field } from '@/components/Field';
import { useAuth } from '@/contexts/AuthContext';
import { useBranding } from '@/contexts/BrandingContext';
import { ApiError } from '@/lib/api/errors';
import { getColors, Space } from '@/constants/Theme';

/**
 * Perfil → Seguridad → Cambiar contraseña. Available to members and staff alike (it is a
 * user-level credential, not a studio role).
 *
 * The server revokes every session on success and returns fresh credentials for this
 * device, which the auth context adopts — so the user stays signed in HERE and is signed
 * out everywhere else. The copy says exactly that.
 */

const MIN_PASSWORD_LENGTH = 8;

export default function SecurityScreen() {
  const router = useRouter();
  const C = getColors();
  const { primaryColor } = useBranding();
  const { changePassword } = useAuth();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit() {
    setError(null);
    if (!currentPassword) {
      setError('Ingresa tu contraseña actual.');
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`La nueva contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
      return;
    }
    if (newPassword === currentPassword) {
      setError('La nueva contraseña debe ser diferente a la actual.');
      return;
    }
    if (newPassword !== confirm) {
      setError('Las contraseñas no coinciden.');
      return;
    }
    setBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
      setDone(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirm('');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setError('La contraseña actual es incorrecta.');
      } else if (e instanceof ApiError && e.status === 400) {
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
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Seguridad' }} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            flexGrow: 1,
            paddingHorizontal: Space.screenH,
            paddingTop: 16,
            paddingBottom: 40,
          }}
        >
          <Text
            style={{
              fontSize: 28,
              fontWeight: '800',
              letterSpacing: -0.8,
              color: C.text,
              marginBottom: 8,
            }}
          >
            Cambiar contraseña
          </Text>
          <Text style={{ fontSize: 15, color: C.textSub, lineHeight: 22, marginBottom: 28 }}>
            Al cambiarla se cerrarán las sesiones en tus otros dispositivos.
          </Text>

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
              <>
                <Text
                  style={{
                    fontSize: 15,
                    color: C.text,
                    lineHeight: 22,
                    marginBottom: 20,
                    textAlign: 'center',
                  }}
                >
                  Tu contraseña fue actualizada. Cerramos la sesión en tus otros dispositivos.
                </Text>
                <BrandButton
                  label="Listo"
                  variant="white"
                  accentColor={primaryColor}
                  onPress={() => router.back()}
                />
              </>
            ) : (
              <>
                <Field
                  label="Contraseña actual"
                  showPasswordToggle
                  secureTextEntry
                  autoComplete="password"
                  textContentType="password"
                  placeholder="Tu contraseña actual"
                  value={currentPassword}
                  onChangeText={setCurrentPassword}
                />
                <Field
                  label="Nueva contraseña"
                  showPasswordToggle
                  secureTextEntry
                  autoComplete="password-new"
                  textContentType="newPassword"
                  placeholder="Mínimo 8 caracteres"
                  value={newPassword}
                  onChangeText={setNewPassword}
                />
                <Field
                  label="Confirmar nueva contraseña"
                  showPasswordToggle
                  secureTextEntry
                  autoComplete="password-new"
                  textContentType="newPassword"
                  placeholder="Repite la nueva contraseña"
                  value={confirm}
                  onChangeText={setConfirm}
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
                  label="Actualizar contraseña"
                  variant="white"
                  accentColor={primaryColor}
                  loading={busy}
                  onPress={() => void onSubmit()}
                />
              </>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
