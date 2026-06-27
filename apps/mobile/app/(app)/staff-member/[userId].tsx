import { Stack, useFocusEffect, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { BrandButton } from '@/components/BrandButton';
import { Field } from '@/components/Field';
import { LoadRetryPanel, ScreenLoader } from '@/components/StudioScreenChrome';
import { StaffAvatar } from '@/components/StaffAvatar';
import { useAuth } from '@/contexts/AuthContext';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import {
  activateStaffMember,
  deactivateStaffMember,
  fetchStaffMember,
  updateStaffMember,
  type StaffMemberDto,
  type StaffRole,
  type StaffType,
} from '@/lib/api/staffApi';
import { formatStaffRoleLabel, formatStaffType, getStaffRoleChipStyle } from '@/lib/staffLabels';
import {
  assignableRolesForActor,
  canActorManageTarget,
  defaultStaffTypeForRole,
  STAFF_TYPE_OPTIONS,
  validatePassword,
} from '@/lib/staffManagement';
import { canAccessTeamTab, canManageTeam } from '@/lib/staffRole';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';
import { getColors, Space, type ThemeColors } from '@/constants/Theme';

function searchParam(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0];
}

function cardStyle(C: ThemeColors) {
  return {
    backgroundColor: '#141416',
    borderRadius: 28,
    borderWidth: 1,
    borderColor: C.separator,
    padding: 20,
  } as const;
}

function SectionTitle({ children }: { children: string }) {
  const C = getColors();
  return (
    <Text
      style={{
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 1.2,
        textTransform: 'uppercase',
        color: C.textMute,
        marginTop: 28,
        marginBottom: 12,
      }}
    >
      {children}
    </Text>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  const C = getColors();
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={{ fontSize: 12, color: C.textMute, marginBottom: 4 }}>{label}</Text>
      <Text style={{ fontSize: 16, color: C.text, lineHeight: 22 }}>{value}</Text>
    </View>
  );
}

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

export default function StaffMemberDetailScreen() {
  const C = getColors();
  const router = useRouter();
  const { primaryColor } = useBranding();
  const { user } = useAuth();
  const { matched } = useMemberStudio();
  const studioId = matched?.studio.id;
  const actorRole = matched?.role;
  const actorUserId = user?.id;
  const canManage = canManageTeam(actorRole);
  const assignableRoles = useMemo(() => assignableRolesForActor(actorRole), [actorRole]);

  const { userId } = useLocalSearchParams<{ userId?: string | string[] }>();
  const targetUserId = searchParam(userId);

  const [member, setMember] = useState<StaffMemberDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<StaffRole>('STAFF');
  const [staffType, setStaffType] = useState<StaffType>('OTHER');
  const [photoUrl, setPhotoUrl] = useState('');

  const [resetVisible, setResetVisible] = useState(false);
  const [photoVisible, setPhotoVisible] = useState(false);
  const [resetPassword, setResetPassword] = useState('');
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const populateForm = useCallback((data: StaffMemberDto) => {
    setFirstName(data.user.firstName);
    setLastName(data.user.lastName);
    setEmail(data.user.email);
    setPhone(data.user.phone ?? data.staffProfile?.phone ?? '');
    setRole(data.role);
    setStaffType((data.staffProfile?.staffType as StaffType) ?? defaultStaffTypeForRole(data.role));
    setPhotoUrl(data.staffProfile?.photoUrl ?? '');
  }, []);

  const load = useCallback(async () => {
    if (!canAccessTeamTab(actorRole)) return;
    if (!studioId || !targetUserId) {
      setLoading(false);
      setError('Falta el miembro del equipo.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await fetchStaffMember(studioId, targetUserId);
      setMember(data);
      populateForm(data);
    } catch (e) {
      setMember(null);
      setError(userFacingApiMessage(e, 'No pudimos cargar este miembro del equipo.'));
    } finally {
      setLoading(false);
    }
  }, [studioId, targetUserId, actorRole, populateForm]);

  useFocusEffect(
    useCallback(() => {
      if (!canAccessTeamTab(actorRole)) {
        router.replace('/(app)/(staff-tabs)/today' as Href);
        return;
      }
      void load();
    }, [actorRole, load, router]),
  );

  const isActive = member?.staffProfile?.isActive ?? true;
  const isOwner = member?.role === 'OWNER';
  const isSelf = Boolean(actorUserId && targetUserId && actorUserId === targetUserId);
  const canManageThisMember = Boolean(member && canManage && canActorManageTarget(actorRole, member.role));

  const handleSave = async () => {
    if (!studioId || !targetUserId || !member) return;
    if (!firstName.trim() || !lastName.trim() || !email.trim()) {
      setFormError('Nombre, apellido y correo son obligatorios.');
      return;
    }
    setFormError(null);
    setSaving(true);
    try {
      const payload: Parameters<typeof updateStaffMember>[2] = {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim().toLowerCase(),
        phone: phone.trim() || undefined,
        staffType,
        photoUrl: photoUrl.trim() || undefined,
      };
      if (!isOwner && role !== member.role) {
        payload.role = role;
      }
      const updated = await updateStaffMember(studioId, targetUserId, payload);
      setMember(updated);
      populateForm(updated);
      setEditing(false);
    } catch (e) {
      setFormError(userFacingApiMessage(e, 'No pudimos guardar los cambios.'));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = () => {
    if (!studioId || !targetUserId || !member) return;
    const nextActive = !isActive;
    const title = nextActive ? 'Reactivar staff' : 'Desactivar staff';
    const message = nextActive
      ? `¿Reactivar a ${member.user.firstName} ${member.user.lastName}?`
      : `¿Desactivar a ${member.user.firstName} ${member.user.lastName}? Ya no podrá acceder al estudio.`;

    Alert.alert(title, message, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: nextActive ? 'Reactivar' : 'Desactivar',
        style: nextActive ? 'default' : 'destructive',
        onPress: () => {
          void (async () => {
            setSaving(true);
            try {
              if (nextActive) {
                await activateStaffMember(studioId, targetUserId);
              } else {
                await deactivateStaffMember(studioId, targetUserId);
              }
              const updated = await fetchStaffMember(studioId, targetUserId);
              setMember(updated);
              populateForm(updated);
            } catch (e) {
              Alert.alert('Error', userFacingApiMessage(e, 'No pudimos actualizar el estado.'));
            } finally {
              setSaving(false);
            }
          })();
        },
      },
    ]);
  };

  const handleResetPassword = async () => {
    if (!studioId || !targetUserId) return;
    const pwdErr = validatePassword(resetPassword);
    if (pwdErr) {
      setResetError(pwdErr);
      return;
    }
    setResetError(null);
    setResetting(true);
    try {
      await updateStaffMember(studioId, targetUserId, {
        temporaryPassword: resetPassword.trim(),
      });
      setResetPassword('');
      setResetVisible(false);
      Alert.alert('Listo', 'La contraseña se restableció correctamente.');
    } catch (e) {
      setResetError(userFacingApiMessage(e, 'No pudimos restablecer la contraseña.'));
    } finally {
      setResetting(false);
    }
  };

  const fullName = member
    ? `${member.user.firstName} ${member.user.lastName}`.trim()
    : 'Miembro del equipo';

  const roleStyle = member ? getStaffRoleChipStyle(member.role) : getStaffRoleChipStyle('STAFF');

  return (
    <>
      <Stack.Screen options={{ title: fullName }} />
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['left', 'right', 'bottom']}>
        {loading ? (
          <ScreenLoader />
        ) : error || !member ? (
          <LoadRetryPanel
            message={error ?? 'Miembro del equipo no encontrado.'}
            onRetry={() => void load()}
          />
        ) : (
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
              <Animated.View entering={FadeInDown.duration(420)} style={{ alignItems: 'center', marginBottom: 8 }}>
                <StaffAvatar
                  userId={member.userId}
                  firstName={member.user.firstName}
                  lastName={member.user.lastName}
                  photoUrl={editing ? photoUrl || null : member.staffProfile?.photoUrl}
                  size={88}
                />
                <Text
                  style={{
                    fontSize: 26,
                    fontWeight: '800',
                    letterSpacing: -0.6,
                    color: C.text,
                    marginTop: 16,
                    textAlign: 'center',
                  }}
                >
                  {member.user.firstName} {member.user.lastName}
                </Text>
                <View
                  style={{
                    backgroundColor: roleStyle.bg,
                    borderRadius: 100,
                    paddingVertical: 6,
                    paddingHorizontal: 12,
                    marginTop: 12,
                  }}
                >
                  <Text
                    style={{
                      fontSize: 11,
                      fontWeight: '700',
                      letterSpacing: 0.5,
                      textTransform: 'uppercase',
                      color: roleStyle.text,
                    }}
                  >
                    {formatStaffRoleLabel(member.role)}
                  </Text>
                </View>
              </Animated.View>

              {canManageThisMember && !editing ? (
                <View style={{ marginTop: 20 }}>
                  <BrandButton
                    label="Editar"
                    variant="white"
                    accentColor={primaryColor}
                    onPress={() => setEditing(true)}
                  />
                </View>
              ) : null}

              <SectionTitle>Información personal</SectionTitle>
              <View style={cardStyle(C)}>
                {editing && canManageThisMember ? (
                  <>
                    {canManageThisMember ? (
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => setPhotoVisible(true)}
                        style={{ marginBottom: 16 }}
                      >
                        <Text style={{ fontSize: 15, fontWeight: '600', color: primaryColor }}>
                          Cambiar foto
                        </Text>
                      </Pressable>
                    ) : null}
                    <Field label="Nombre" value={firstName} onChangeText={setFirstName} autoCapitalize="words" />
                    <Field label="Apellido" value={lastName} onChangeText={setLastName} autoCapitalize="words" />
                    <Field
                      label="Correo"
                      value={email}
                      onChangeText={setEmail}
                      autoCapitalize="none"
                      keyboardType="email-address"
                      autoCorrect={false}
                    />
                    <Field label="Teléfono" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
                  </>
                ) : (
                  <>
                    <DetailRow label="Nombre" value={member.user.firstName} />
                    <DetailRow label="Apellido" value={member.user.lastName} />
                    <DetailRow label="Correo" value={member.user.email} />
                    <DetailRow
                      label="Teléfono"
                      value={member.user.phone ?? member.staffProfile?.phone ?? '—'}
                    />
                  </>
                )}
              </View>

              <SectionTitle>Rol</SectionTitle>
              <View style={cardStyle(C)}>
                {editing && canManageThisMember && !isOwner ? (
                  <>
                    <Text style={{ fontSize: 12, color: C.textMute, marginBottom: 10 }}>Rol</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: 12 }}>
                      {assignableRoles.map((r) => (
                        <OptionChip
                          key={r}
                          label={formatStaffRoleLabel(r)}
                          selected={role === r}
                          onPress={() => {
                            setRole(r);
                            setStaffType(defaultStaffTypeForRole(r));
                          }}
                        />
                      ))}
                    </View>
                    <Text style={{ fontSize: 12, color: C.textMute, marginBottom: 10 }}>Tipo de staff</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                      {STAFF_TYPE_OPTIONS.map((opt) => (
                        <OptionChip
                          key={opt.value}
                          label={opt.label}
                          selected={staffType === opt.value}
                          onPress={() => setStaffType(opt.value)}
                        />
                      ))}
                    </View>
                  </>
                ) : (
                  <>
                    <DetailRow label="Rol" value={formatStaffRoleLabel(member.role)} />
                    <DetailRow
                      label="Tipo de staff"
                      value={
                        member.staffProfile
                          ? formatStaffType(member.staffProfile.staffType)
                          : '—'
                      }
                    />
                  </>
                )}
              </View>

              <SectionTitle>Estado</SectionTitle>
              <View style={cardStyle(C)}>
                <DetailRow label="Estado" value={isActive ? 'Activo' : 'Inactivo'} />
              </View>

              {canManageThisMember ? (
                <>
                  <SectionTitle>Seguridad</SectionTitle>
                  <View style={cardStyle(C)}>
                    <BrandButton
                      label="Restablecer contraseña"
                      variant="ghost"
                      accentColor={primaryColor}
                      onPress={() => {
                        setResetPassword('');
                        setResetError(null);
                        setResetVisible(true);
                      }}
                    />
                  </View>

                  <SectionTitle>Zona de riesgo</SectionTitle>
                  <View style={cardStyle(C)}>
                    <BrandButton
                      label={isActive ? 'Desactivar' : 'Reactivar'}
                      variant="ghost"
                      accentColor={primaryColor}
                      disabled={saving || (isSelf && isOwner)}
                      onPress={handleToggleActive}
                    />
                  </View>
                </>
              ) : null}

              {editing && canManageThisMember ? (
                <View style={{ marginTop: 24, gap: 12 }}>
                  {formError ? (
                    <Text style={{ fontSize: 14, color: C.negative, marginBottom: 4 }}>{formError}</Text>
                  ) : null}
                  <BrandButton
                    label="Guardar cambios"
                    accentColor={primaryColor}
                    loading={saving}
                    onPress={() => void handleSave()}
                  />
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      populateForm(member);
                      setEditing(false);
                      setFormError(null);
                    }}
                    style={{ alignItems: 'center', paddingVertical: 12 }}
                  >
                    <Text style={{ fontSize: 15, color: C.textSub }}>Cancelar</Text>
                  </Pressable>
                </View>
              ) : !canManageThisMember ? (
                <Text
                  style={{
                    fontSize: 13,
                    color: C.textMute,
                    textAlign: 'center',
                    lineHeight: 20,
                    marginTop: 32,
                  }}
                >
                  Solo lectura. Los cambios del equipo los administran OWNER y ADMIN.
                </Text>
              ) : null}
            </ScrollView>
          </KeyboardAvoidingView>
        )}

        <Modal visible={resetVisible} animationType="slide" transparent>
          <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.55)' }}>
            <View
              style={{
                backgroundColor: '#141416',
                borderTopLeftRadius: 24,
                borderTopRightRadius: 24,
                padding: Space.screenH,
                paddingBottom: 40,
              }}
            >
              <Text style={{ fontSize: 20, fontWeight: '800', color: C.text, marginBottom: 8 }}>
                Restablecer contraseña
              </Text>
              <Text style={{ fontSize: 14, color: C.textSub, marginBottom: 20, lineHeight: 20 }}>
                Ingresa una nueva contraseña para {member?.user.firstName}. Mínimo 8 caracteres.
              </Text>
              <Field
                label="Nueva contraseña"
                value={resetPassword}
                onChangeText={setResetPassword}
                secureTextEntry
                showPasswordToggle
              />
              {resetError ? (
                <Text style={{ fontSize: 14, color: C.negative, marginBottom: 12 }}>{resetError}</Text>
              ) : null}
              <BrandButton
                label="Restablecer contraseña"
                accentColor={primaryColor}
                loading={resetting}
                onPress={() => void handleResetPassword()}
              />
              <Pressable
                accessibilityRole="button"
                onPress={() => setResetVisible(false)}
                style={{ marginTop: 12, alignItems: 'center', paddingVertical: 12 }}
              >
                <Text style={{ fontSize: 15, color: C.textSub }}>Cancelar</Text>
              </Pressable>
            </View>
          </View>
        </Modal>

        <Modal visible={photoVisible} animationType="slide" transparent>
          <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.55)' }}>
            <View
              style={{
                backgroundColor: '#141416',
                borderTopLeftRadius: 24,
                borderTopRightRadius: 24,
                padding: Space.screenH,
                paddingBottom: 40,
              }}
            >
              <Text style={{ fontSize: 20, fontWeight: '800', color: C.text, marginBottom: 8 }}>
                Cambiar foto
              </Text>
              <Text style={{ fontSize: 14, color: C.textSub, marginBottom: 20, lineHeight: 20 }}>
                Pega la URL de una imagen. La subida directa desde el dispositivo estará disponible
                pronto.
              </Text>
              <View style={{ alignItems: 'center', marginBottom: 20 }}>
                <StaffAvatar
                  userId={member?.userId ?? 'preview'}
                  firstName={firstName || member?.user.firstName || '?'}
                  lastName={lastName || member?.user.lastName}
                  photoUrl={photoUrl || null}
                  size={96}
                />
              </View>
              <Field
                label="URL de la foto"
                value={photoUrl}
                onChangeText={setPhotoUrl}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="https://..."
              />
              <BrandButton
                label="Usar esta foto"
                accentColor={primaryColor}
                onPress={() => setPhotoVisible(false)}
              />
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setPhotoUrl(member?.staffProfile?.photoUrl ?? '');
                  setPhotoVisible(false);
                }}
                style={{ marginTop: 12, alignItems: 'center', paddingVertical: 12 }}
              >
                <Text style={{ fontSize: 15, color: C.textSub }}>Cancelar</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    </>
  );
}
