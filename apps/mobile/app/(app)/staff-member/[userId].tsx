import { Stack, useFocusEffect, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { LoadRetryPanel, ScreenLoader } from '@/components/StudioScreenChrome';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { fetchStaffMember, type StaffMemberDto } from '@/lib/api/staffApi';
import { formatStaffRoleLabel, formatStaffType } from '@/lib/staffLabels';
import { canAccessTeamTab } from '@/lib/staffRole';
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
    padding: 24,
  } as const;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  const C = getColors();
  return (
    <View style={{ marginBottom: 16 }}>
      <Text
        style={{
          fontSize: 11,
          fontWeight: '700',
          letterSpacing: 1.1,
          textTransform: 'uppercase',
          color: C.textMute,
          marginBottom: 6,
        }}
      >
        {label}
      </Text>
      <Text style={{ fontSize: 15, color: C.text, lineHeight: 22 }}>{value}</Text>
    </View>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-MX', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default function StaffMemberDetailScreen() {
  const C = getColors();
  const router = useRouter();
  const { matched } = useMemberStudio();
  const studioId = matched?.studio.id;
  const actorRole = matched?.role;
  const { userId } = useLocalSearchParams<{ userId?: string | string[] }>();
  const targetUserId = searchParam(userId);

  const [member, setMember] = useState<StaffMemberDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    } catch (e) {
      setMember(null);
      setError(userFacingApiMessage(e, 'No pudimos cargar este miembro del equipo.'));
    } finally {
      setLoading(false);
    }
  }, [studioId, targetUserId, actorRole]);

  useFocusEffect(
    useCallback(() => {
      if (!canAccessTeamTab(actorRole)) {
        router.replace('/(app)/(staff-tabs)/today' as Href);
        return;
      }
      void load();
    }, [actorRole, load, router]),
  );

  const fullName = member
    ? `${member.user.firstName} ${member.user.lastName}`.trim()
    : 'Miembro del equipo';

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
          <ScrollView
            contentContainerStyle={{
              paddingHorizontal: Space.screenH,
              paddingTop: 16,
              paddingBottom: 40,
            }}
          >
            <Animated.View entering={FadeInDown.duration(420)}>
              <View style={cardStyle(C)}>
                <Text
                  style={{
                    fontSize: 26,
                    fontWeight: '800',
                    letterSpacing: -0.6,
                    color: C.text,
                    marginBottom: 12,
                  }}
                >
                  {member.user.firstName} {member.user.lastName}
                </Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
                  <View
                    style={{
                      backgroundColor: 'rgba(255,255,255,0.10)',
                      borderRadius: 100,
                      paddingVertical: 5,
                      paddingHorizontal: 10,
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 11,
                        fontWeight: '700',
                        letterSpacing: 0.5,
                        textTransform: 'uppercase',
                        color: '#FFFFFF',
                      }}
                    >
                      {formatStaffRoleLabel(member.role)}
                    </Text>
                  </View>
                  {member.staffProfile ? (
                    <View
                      style={{
                        backgroundColor: 'rgba(255,255,255,0.06)',
                        borderRadius: 100,
                        paddingVertical: 5,
                        paddingHorizontal: 10,
                      }}
                    >
                      <Text
                        style={{
                          fontSize: 11,
                          fontWeight: '700',
                          letterSpacing: 0.5,
                          textTransform: 'uppercase',
                          color: C.textSub,
                        }}
                      >
                        {formatStaffType(member.staffProfile.staffType)}
                      </Text>
                    </View>
                  ) : null}
                  <View
                    style={{
                      backgroundColor: (member.staffProfile?.isActive ?? true)
                        ? 'rgba(16,185,129,0.15)'
                        : 'rgba(255,255,255,0.06)',
                      borderRadius: 100,
                      paddingVertical: 5,
                      paddingHorizontal: 10,
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 11,
                        fontWeight: '700',
                        letterSpacing: 0.5,
                        textTransform: 'uppercase',
                        color: (member.staffProfile?.isActive ?? true) ? '#6EE7B7' : C.textMute,
                      }}
                    >
                      {(member.staffProfile?.isActive ?? true) ? 'Activo' : 'Inactivo'}
                    </Text>
                  </View>
                </View>

                <DetailRow label="Correo" value={member.user.email} />
                {member.user.phone || member.staffProfile?.phone ? (
                  <DetailRow
                    label="Teléfono"
                    value={member.user.phone ?? member.staffProfile?.phone ?? '—'}
                  />
                ) : null}
                <DetailRow label="Se unió" value={formatDate(member.joinedAt)} />
                <DetailRow
                  label="Clases próximas"
                  value={String(member.assignedClassesCount)}
                />
                {member.staffProfile?.bio ? (
                  <DetailRow label="Biografía" value={member.staffProfile.bio} />
                ) : null}
              </View>
            </Animated.View>

            {member.staffProfile?.specialties && member.staffProfile.specialties.length > 0 ? (
              <Animated.View entering={FadeInDown.delay(80).duration(420)}>
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
                  Especialidades
                </Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {member.staffProfile.specialties.map((s) => (
                    <View
                      key={s}
                      style={{
                        backgroundColor: '#141416',
                        borderWidth: 1,
                        borderColor: C.separator,
                        borderRadius: 100,
                        paddingVertical: 6,
                        paddingHorizontal: 12,
                      }}
                    >
                      <Text style={{ fontSize: 13, color: C.textSub }}>{s}</Text>
                    </View>
                  ))}
                </View>
              </Animated.View>
            ) : null}

            <Text
              style={{
                fontSize: 13,
                color: C.textMute,
                textAlign: 'center',
                lineHeight: 20,
                marginTop: 32,
                paddingHorizontal: 8,
              }}
            >
              Los cambios del equipo se administran desde el panel de administración web.
            </Text>
          </ScrollView>
        )}
      </SafeAreaView>
    </>
  );
}
