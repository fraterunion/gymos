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
import { WaiverRegisterSection } from '@/components/WaiverGate';
import { useAuth } from '@/contexts/AuthContext';
import { useBranding } from '@/contexts/BrandingContext';
import { fetchPublicWaiver, type PublicWaiverDto } from '@/lib/api/waiverApi';
import { getStudioSlug } from '@/lib/env';
import { getColors, Space } from '@/constants/Theme';

function searchParam(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0];
}

const PASSWORDS_MISMATCH = 'Las contraseñas no coinciden.';

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
  const [waiver, setWaiver] = useState<PublicWaiverDto | null>(null);
  const [waiverLoading, setWaiverLoading] = useState(false);
  const [waiverAccepted, setWaiverAccepted] = useState(false);

  const studioSlug = getStudioSlug();

  useEffect(() => {
    if (!studioSlug) {
      setWaiver(null);
      return;
    }
    setWaiverLoading(true);
    void fetchPublicWaiver(studioSlug)
      .then((doc) => setWaiver(doc))
      .catch(() => setWaiver(null))
      .finally(() => setWaiverLoading(false));
  }, [studioSlug]);

  const waiverRequired = Boolean(studioSlug && waiver);

  const passwordsMismatch = useMemo(
    () => confirmPassword.length > 0 && password !== confirmPassword,
    [password, confirmPassword],
  );

  const confirmPasswordError = useMemo(() => {
    if (!confirmTouched && !localError) return null;
    if (passwordsMismatch) return PASSWORDS_MISMATCH;
    return null;
  }, [confirmTouched, localError, passwordsMismatch]);

  const canSubmit =
    !busy &&
    firstName.trim().length > 0 &&
    lastName.trim().length > 0 &&
    email.trim().length > 0 &&
    password.length >= 8 &&
    confirmPassword.length > 0 &&
    !passwordsMismatch &&
    (!waiverRequired || waiverAccepted);

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
      setLocalError('El nombre y apellido son obligatorios.');
      return;
    }
    if (!email.trim()) {
      setLocalError('El correo es obligatorio.');
      return;
    }
    if (password.length < 8) {
      setLocalError('La contraseña debe tener al menos 8 caracteres.');
      return;
    }
    if (!confirmPassword) {
      setLocalError('Confirma tu contraseña.');
      return;
    }
    if (password !== confirmPassword) {
      setLocalError(PASSWORDS_MISMATCH);
      return;
    }
    if (waiverRequired && (!waiverAccepted || !waiver)) {
      setLocalError('Debes aceptar la Carta Responsiva para crear tu cuenta.');
      return;
    }

    try {
      await register({
        email: email.trim(),
        password,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        ...(studioSlug ? { studioSlug } : {}),
        ...(waiverRequired && waiver
          ? { waiverAccepted: true, waiverDocumentId: waiver.id }
          : {}),
      });
    } catch {
      // error in context
    }
  }

  const combinedError =
    localError && localError !== PASSWORDS_MISMATCH ? localError : error;

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
              Únete a {appDisplayName}
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
              Crea tu cuenta de miembro
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
                  label="Nombre"
                  autoComplete="given-name"
                  value={firstName}
                  onChangeText={setFirstName}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Field
                  label="Apellido"
                  autoComplete="family-name"
                  value={lastName}
                  onChangeText={setLastName}
                />
              </View>
            </View>
            <Field
              label="Correo"
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              textContentType="emailAddress"
              placeholder="Ingresa tu correo"
              helperText="Se usa para tu cuenta, recibos y soporte."
              value={email}
              onChangeText={setEmail}
            />
            <Field
              label="Contraseña"
              showPasswordToggle
              secureTextEntry
              autoComplete="new-password"
              textContentType="newPassword"
              value={password}
              onChangeText={setPassword}
              placeholder="Mín. 8 caracteres"
            />
            <Field
              label="Confirmar contraseña"
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
              placeholder="Vuelve a ingresar tu contraseña"
              error={confirmPasswordError}
            />

            <WaiverRegisterSection
              waiver={waiver}
              checked={waiverAccepted}
              onCheckedChange={setWaiverAccepted}
              loading={waiverLoading}
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
              label="Crear cuenta"
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
                    Iniciar sesión
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
