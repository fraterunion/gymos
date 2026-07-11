import { Stack, useRouter, type Href } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BrandButton } from '@/components/BrandButton';
import { Field } from '@/components/Field';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { useBranding } from '@/contexts/BrandingContext';
import {
  addStaffMember,
  type StaffRole,
  type StaffType,
} from '@/lib/api/staffApi';
import { formatStaffRoleLabel } from '@/lib/staffLabels';
import {
  assignableRolesForActor,
  defaultStaffTypeForRole,
  STAFF_TYPE_OPTIONS,
  validatePassword,
} from '@/lib/staffManagement';
import { canManageTeam } from '@/lib/staffRole';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';
import { getColors, Space } from '@/constants/Theme';

function OptionChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const C = getColors();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={{
        paddingVertical: 8,
        paddingHorizontal: 14,
        borderRadius: 100,
        borderWidth: 1,
        borderColor: selected ? 'rgba(255,255,255,0.35)' : C.separator,
        backgroundColor: selected ? 'rgba(255,255,255,0.12)' : 'transparent',
        marginRight: 8,
        marginBottom: 8,
      }}
    >
      <Text
        style={{
          fontSize: 13,
          fontWeight: selected ? '700' : '600',
          color: selected ? C.text : C.textSub,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export default function AddStaffScreen() {
  const router = useRouter();
  const C = getColors();
  const { primaryColor } = useBranding();
  const { matched } = useMemberStudio();
  const studioId = matched?.studio.id;
  const actorRole = matched?.role;

  const roles = useMemo(() => assignableRolesForActor(actorRole), [actorRole]);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [bio, setBio] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<StaffRole>(roles[0] ?? 'STAFF');
  const [staffType, setStaffType] = useState<StaffType>(defaultStaffTypeForRole(role));
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const onRoleChange = useCallback((next: StaffRole) => {
    setRole(next);
    setStaffType(defaultStaffTypeForRole(next));
  }, []);

  if (!canManageTeam(actorRole)) {
    return (
      <>
        <Stack.Screen options={{ title: 'Agregar staff' }} />
        <SafeAreaView style={{ flex: 1, backgroundColor: C.bg, padding: Space.screenH }}>
          <Text style={{ color: C.textSub, textAlign: 'center', marginTop: 40 }}>
            No tienes permiso para agregar staff.
          </Text>
        </SafeAreaView>
      </>
    );
  }

  const validate = (): string | null => {
    if (!firstName.trim()) return 'El nombre es obligatorio.';
    if (!lastName.trim()) return 'El apellido es obligatorio.';
    if (!email.trim()) return 'El correo es obligatorio.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return 'Ingresa un correo válido.';
    }
    const pwdErr = validatePassword(password);
    if (pwdErr) return pwdErr;
    return null;
  };

  const handleSave = async () => {
    if (!studioId) return;
    const err = validate();
    if (err) {
      setFormError(err);
      return;
    }
    setFormError(null);
    setSaving(true);
    try {
      const created = await addStaffMember(studioId, {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim().toLowerCase(),
        role,
        staffType,
        phone: phone.trim() || undefined,
        bio: bio.trim() || undefined,
        temporaryPassword: password.trim(),
        isActive: true,
      });
      router.replace(`/(app)/staff-member/${created.userId}` as Href);
    } catch (e) {
      setFormError(userFacingApiMessage(e, 'No pudimos crear el miembro del equipo.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Agregar staff' }} />
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['left', 'right', 'bottom']}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{
              paddingHorizontal: Space.screenH,
              paddingTop: 16,
              paddingBottom: 40,
            }}
          >
            <Text
              style={{
                fontSize: 24,
                fontWeight: '800',
                letterSpacing: -0.5,
                color: C.text,
                marginBottom: 20,
              }}
            >
              Nuevo miembro
            </Text>

            <Field label="Nombre *" value={firstName} onChangeText={setFirstName} autoCapitalize="words" />
            <Field label="Apellido *" value={lastName} onChangeText={setLastName} autoCapitalize="words" />
            <Field
              label="Correo *"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              autoCorrect={false}
            />
            <Field
              label="Contraseña *"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              showPasswordToggle
              helperText="Mínimo 8 caracteres."
            />
            <Field label="Teléfono" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
            <Field
              label="Biografía"
              value={bio}
              onChangeText={setBio}
              multiline
              style={{ minHeight: 88, textAlignVertical: 'top' }}
            />

            <Text
              style={{
                fontSize: 11,
                fontWeight: '700',
                letterSpacing: 0.6,
                textTransform: 'uppercase',
                color: C.textMute,
                marginBottom: 10,
              }}
            >
              Rol *
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: 12 }}>
              {roles.map((r) => (
                <OptionChip
                  key={r}
                  label={formatStaffRoleLabel(r)}
                  selected={role === r}
                  onPress={() => onRoleChange(r)}
                />
              ))}
            </View>

            <Text
              style={{
                fontSize: 11,
                fontWeight: '700',
                letterSpacing: 0.6,
                textTransform: 'uppercase',
                color: C.textMute,
                marginBottom: 10,
              }}
            >
              Tipo de staff
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: 20 }}>
              {STAFF_TYPE_OPTIONS.map((opt) => (
                <OptionChip
                  key={opt.value}
                  label={opt.label}
                  selected={staffType === opt.value}
                  onPress={() => setStaffType(opt.value)}
                />
              ))}
            </View>

            {formError ? (
              <Text style={{ fontSize: 14, color: C.negative, marginBottom: 16, lineHeight: 20 }}>
                {formError}
              </Text>
            ) : null}

            <BrandButton
              label="Agregar staff"
              accentColor={primaryColor}
              loading={saving}
              onPress={() => void handleSave()}
            />

            <Pressable
              accessibilityRole="button"
              onPress={() => router.back()}
              style={{ marginTop: 16, alignItems: 'center', paddingVertical: Space.sp2 }}
            >
              <Text style={{ fontSize: 15, color: C.textSub }}>Cancelar</Text>
            </Pressable>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </>
  );
}
