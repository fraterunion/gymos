import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BrandButton } from '@/components/BrandButton';
import { Field } from '@/components/Field';
import { MemberBillingCenter } from '@/components/member/MemberBillingCenter';
import { LoadRetryPanel, Skeleton } from '@/components/StudioScreenChrome';
import { StaffAvatar } from '@/components/StaffAvatar';
import { useAuth } from '@/contexts/AuthContext';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { ApiError } from '@/lib/api/errors';
import {
  fetchMemberAttendance,
  fetchMemberPayments,
  fetchMemberProfile,
  fetchMemberSubscriptions,
  fetchMemberTimeline,
  type MemberPaymentDto,
  type MemberProfileDto,
  type MemberSubscriptionDto,
  type MemberTimelineEventDto,
} from '@/lib/api/memberProfileApi';
import { fetchSalesSettings, type SalesSettings } from '@/lib/api/salesApi';
import {
  attestMemberWaiver,
  fetchMemberWaiverStatus,
  waiverStatusLabel,
  type MemberWaiverStatusDto,
} from '@/lib/api/waiverApi';
import {
  deriveMemberOverviewStatus,
  formatProfileDate,
  formatProfileDateTime,
} from '@/lib/memberProfileHelpers';
import { canViewMemberBilling, canPerformBillingActions } from '@/lib/memberBillingHelpers';
import { canAccessMemberProfile } from '@/lib/memberProfilePermissions';
import { canAttestMemberWaiver } from '@/lib/waiverPermissions';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';
import { getColors, Space, type ThemeColors } from '@/constants/Theme';

const CARD_BG = '#141416';

function cardStyle(C: ThemeColors) {
  return {
    backgroundColor: CARD_BG,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: C.separator,
    padding: 24,
  } as const;
}

function SectionLabel({ children }: { children: string }) {
  const C = getColors();
  return (
    <Text
      style={{
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 1.2,
        textTransform: 'uppercase',
        color: C.textMute,
        marginBottom: 14,
        marginTop: 28,
      }}
    >
      {children}
    </Text>
  );
}

function StatusPill({ label, bg, textColor }: { label: string; bg: string; textColor: string }) {
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        borderRadius: 999,
        paddingHorizontal: 14,
        paddingVertical: 8,
        backgroundColor: bg,
      }}
    >
      <Text style={{ fontSize: 13, fontWeight: '700', color: textColor }}>{label}</Text>
    </View>
  );
}

function ActivityRow({
  title,
  subtitle,
  when,
  index,
}: {
  title: string;
  subtitle?: string | null;
  when: string;
  index: number;
}) {
  const C = getColors();
  return (
    <Animated.View
      entering={FadeInDown.delay(index * 35).duration(320)}
      style={{
        flexDirection: 'row',
        gap: 14,
        paddingVertical: 14,
        borderBottomWidth: 1,
        borderBottomColor: C.separator,
      }}
    >
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: 'rgba(255,255,255,0.25)',
          marginTop: 6,
        }}
      />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 15, fontWeight: '600', color: C.text, lineHeight: 20 }}>{title}</Text>
        {subtitle ? (
          <Text style={{ fontSize: 13, color: C.textMute, marginTop: 3, lineHeight: 18 }}>{subtitle}</Text>
        ) : null}
        <Text style={{ fontSize: 12, color: C.textMute, marginTop: 6 }}>{when}</Text>
      </View>
    </Animated.View>
  );
}

function ProfileSkeleton() {
  return (
    <View style={{ padding: Space.screenH, gap: 16 }}>
      <View style={{ flexDirection: 'row', gap: 16, alignItems: 'center' }}>
        <Skeleton width={72} height={72} radius={36} />
        <View style={{ flex: 1, gap: 10 }}>
          <Skeleton width="70%" height={24} />
          <Skeleton width="50%" height={14} />
          <Skeleton width={120} height={28} radius={14} />
        </View>
      </View>
      <Skeleton height={220} radius={28} />
      <Skeleton height={180} radius={28} />
      <Skeleton height={200} radius={28} />
    </View>
  );
}

export default function MemberProfileScreen() {
  const router = useRouter();
  const C = getColors();
  const { primaryColor } = useBranding();
  const { user } = useAuth();
  const { matched } = useMemberStudio();
  const studioId = matched?.studio.id ?? '';
  const role = matched?.role ?? null;

  const params = useLocalSearchParams<{ userId?: string; from?: string }>();
  const userId = typeof params.userId === 'string' ? params.userId : '';
  const from = typeof params.from === 'string' ? params.from : undefined;

  const allowed = canAccessMemberProfile(role);
  const showBilling = canViewMemberBilling(role);
  const loadSalesSettings = canPerformBillingActions(role);
  const canAttestWaiver = canAttestMemberWaiver(role);

  const [salesSettings, setSalesSettings] = useState<SalesSettings | null>(null);
  const [profile, setProfile] = useState<MemberProfileDto | null>(null);
  const [subscriptions, setSubscriptions] = useState<MemberSubscriptionDto[] | null>(null);
  const [waiver, setWaiver] = useState<MemberWaiverStatusDto | null>(null);
  const [timeline, setTimeline] = useState<MemberTimelineEventDto[] | null>(null);
  const [timelineError, setTimelineError] = useState(false);
  const [payments, setPayments] = useState<MemberPaymentDto[] | null>(null);
  const [paymentsError, setPaymentsError] = useState(false);
  const [attendanceCount, setAttendanceCount] = useState<number | null>(null);
  const [attendanceError, setAttendanceError] = useState(false);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  const [attestNote, setAttestNote] = useState('');
  const [attesting, setAttesting] = useState(false);
  const [attestError, setAttestError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    if (!studioId || !userId || !allowed) return;

    setError(null);
    setNotFound(false);
    setForbidden(false);
    setTimelineError(false);
    setPaymentsError(false);
    setAttendanceError(false);

    try {
      const [profileRes, subsRes, waiverRes] = await Promise.all([
        fetchMemberProfile(studioId, userId),
        fetchMemberSubscriptions(studioId, userId).catch(() => null),
        fetchMemberWaiverStatus(studioId, userId).catch(() => null),
      ]);

      setProfile(profileRes);
      setSubscriptions(subsRes);
      setWaiver(waiverRes);

      void fetchMemberTimeline(studioId, userId)
        .then((rows) => setTimeline(rows.slice(0, 8)))
        .catch(() => {
          setTimeline(null);
          setTimelineError(true);
        });

      void fetchMemberPayments(studioId, userId, 8)
        .then((res) => setPayments(res.data))
        .catch(() => {
          setPayments(null);
          setPaymentsError(true);
        });

      void fetchMemberAttendance(studioId, userId, 5)
        .then((res) => setAttendanceCount(res.total))
        .catch(() => {
          setAttendanceCount(null);
          setAttendanceError(true);
        });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setNotFound(true);
      } else if (e instanceof ApiError && e.status === 403) {
        setForbidden(true);
      } else {
        setError(userFacingApiMessage(e, 'No se pudo cargar el perfil'));
      }
      setProfile(null);
    }
  }, [allowed, studioId, userId]);

  useEffect(() => {
    if (!studioId || !allowed || !loadSalesSettings) return;
    fetchSalesSettings(studioId)
      .then(setSalesSettings)
      .catch(() =>
        setSalesSettings({
          frontDeskCanCreateMember: true,
          frontDeskCanIssueCheckout: true,
          frontDeskCanRecordCash: false,
        }),
      );
  }, [studioId, allowed, loadSalesSettings]);

  useEffect(() => {
    if (!allowed || !userId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void loadAll().finally(() => setLoading(false));
  }, [allowed, userId, loadAll]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadAll();
    setRefreshing(false);
  }, [loadAll]);

  const overviewStatus = useMemo(
    () =>
      deriveMemberOverviewStatus({
        subscriptionStatus: profile?.activeSubscription?.status ?? null,
        waiverRequired: waiver?.required ?? null,
        waiverAccepted: waiver?.accepted ?? null,
      }),
    [profile?.activeSubscription?.status, waiver?.accepted, waiver?.required],
  );

  const waiverPending = Boolean(waiver?.required && !waiver.accepted);

  async function handleAttest() {
    if (!studioId || !userId || !waiver?.activeWaiverDocumentId) return;
    setAttesting(true);
    setAttestError(null);
    try {
      await attestMemberWaiver(studioId, userId, {
        waiverDocumentId: waiver.activeWaiverDocumentId,
        attestationNote: attestNote.trim() || undefined,
      });
      setAttestNote('');
      const updated = await fetchMemberWaiverStatus(studioId, userId);
      setWaiver(updated);
    } catch (e) {
      setAttestError(userFacingApiMessage(e, 'No se pudo registrar la firma'));
    } finally {
      setAttesting(false);
    }
  }

  const displayName = profile
    ? `${profile.user.firstName} ${profile.user.lastName}`.trim()
    : '';

  const activityItems = useMemo(() => {
    if (!timeline?.length) return [];
    return timeline.map((ev, i) => ({
      key: `${ev.type}-${ev.occurredAt}-${i}`,
      title: ev.title,
      subtitle: ev.description,
      when: formatProfileDateTime(ev.occurredAt),
      index: i,
    }));
  }, [timeline]);

  if (!allowed) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: '#0A0A0A' }}>
        <View style={{ flex: 1, justifyContent: 'center', padding: Space.screenH }}>
          <Text style={{ fontSize: 20, fontWeight: '800', color: C.text, marginBottom: 12 }}>
            Sin acceso
          </Text>
          <Text style={{ fontSize: 15, lineHeight: 22, color: C.textSub, marginBottom: 28 }}>
            Tu rol no tiene permiso para ver perfiles de miembros.
          </Text>
          <BrandButton label="Volver" accentColor={primaryColor} onPress={() => router.back()} />
        </View>
      </SafeAreaView>
    );
  }

  if (!userId) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: '#0A0A0A' }}>
        <LoadRetryPanel message="Miembro no especificado" onRetry={() => router.back()} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#0A0A0A' }} edges={['bottom']}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: Space.screenH,
          paddingVertical: 12,
          borderBottomWidth: 1,
          borderBottomColor: C.separator,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Atrás"
          onPress={() => router.back()}
          hitSlop={12}
          style={{ padding: 8, marginRight: 8 }}
        >
          <FontAwesome name="chevron-left" size={18} color={C.text} />
        </Pressable>
        <Text style={{ flex: 1, fontSize: 17, fontWeight: '700', color: C.text }}>Perfil del miembro</Text>
      </View>

      {loading && !profile ? (
        <ProfileSkeleton />
      ) : notFound ? (
        <View style={{ flex: 1, justifyContent: 'center', padding: Space.screenH }}>
          <Text style={{ fontSize: 20, fontWeight: '800', color: C.text, marginBottom: 12 }}>
            Miembro no encontrado
          </Text>
          <Text style={{ fontSize: 15, lineHeight: 22, color: C.textSub, marginBottom: 28 }}>
            No encontramos este miembro en el estudio.
          </Text>
          <BrandButton label="Volver" accentColor={primaryColor} onPress={() => router.back()} />
        </View>
      ) : forbidden ? (
        <View style={{ flex: 1, justifyContent: 'center', padding: Space.screenH }}>
          <Text style={{ fontSize: 20, fontWeight: '800', color: C.text, marginBottom: 12 }}>
            Sin permiso
          </Text>
          <Text style={{ fontSize: 15, lineHeight: 22, color: C.textSub, marginBottom: 28 }}>
            No tienes acceso para ver este perfil.
          </Text>
          <BrandButton label="Volver" accentColor={primaryColor} onPress={() => router.back()} />
        </View>
      ) : error && !profile ? (
        <LoadRetryPanel message={error} onRetry={() => void loadAll()} />
      ) : profile ? (
        <ScrollView
          contentContainerStyle={{ padding: Space.screenH, paddingBottom: 48 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={primaryColor} />
          }
        >
          <Animated.View entering={FadeInDown.duration(380)} style={{ marginBottom: 8 }}>
            <View style={{ flexDirection: 'row', gap: 18, alignItems: 'flex-start' }}>
              <StaffAvatar
                userId={profile.user.id}
                firstName={profile.user.firstName}
                lastName={profile.user.lastName}
                size={72}
              />
              <View style={{ flex: 1, paddingTop: 4 }}>
                <Text
                  style={{
                    fontSize: 26,
                    fontWeight: '800',
                    letterSpacing: -0.8,
                    color: C.text,
                    lineHeight: 30,
                  }}
                >
                  {displayName}
                </Text>
                <Text style={{ fontSize: 14, color: C.textMute, marginTop: 6 }}>{profile.user.email}</Text>
                {profile.user.phone ? (
                  <Text style={{ fontSize: 14, color: C.textMute, marginTop: 2 }}>{profile.user.phone}</Text>
                ) : null}
                <View style={{ marginTop: 14 }}>
                  <StatusPill
                    label={overviewStatus.label}
                    bg={overviewStatus.bg}
                    textColor={overviewStatus.textColor}
                  />
                </View>
              </View>
            </View>
          </Animated.View>

          {showBilling ? (
            <MemberBillingCenter
              userId={userId}
              role={role}
              profile={profile}
              subscriptions={subscriptions}
              payments={payments}
              paymentsError={paymentsError}
              salesSettings={salesSettings}
            />
          ) : null}

          <SectionLabel>Carta responsiva</SectionLabel>
          <Animated.View entering={FadeInDown.delay(100).duration(380)} style={cardStyle(C)}>
            {waiver ? (
              <>
                <StatusPill
                  label={waiverStatusLabel(waiver)}
                  bg={
                    waiver.required && !waiver.accepted
                      ? 'rgba(251,191,36,0.12)'
                      : 'rgba(52,211,153,0.12)'
                  }
                  textColor={waiver.required && !waiver.accepted ? C.caution : C.positive}
                />
                {waiver.acceptedAt ? (
                  <Text style={{ fontSize: 14, color: C.textSub, marginTop: 16, lineHeight: 20 }}>
                    Aceptada el {formatProfileDate(waiver.acceptedAt)}
                    {waiver.acceptedVersion ? ` · v${waiver.acceptedVersion}` : ''}
                  </Text>
                ) : waiver.required ? (
                  <Text style={{ fontSize: 14, color: C.textSub, marginTop: 16, lineHeight: 20 }}>
                    El miembro debe firmar la carta responsiva antes de ciertas operaciones en efectivo.
                  </Text>
                ) : (
                  <Text style={{ fontSize: 14, color: C.textSub, marginTop: 16, lineHeight: 20 }}>
                    No se requiere carta responsiva para este estudio.
                  </Text>
                )}

                {waiverPending && canAttestWaiver && waiver.activeWaiverDocumentId ? (
                  <View style={{ marginTop: 20, gap: 12 }}>
                    <Field
                      label="Nota de attestation"
                      value={attestNote}
                      onChangeText={setAttestNote}
                      placeholder="Opcional"
                      multiline
                      style={{ minHeight: 72, textAlignVertical: 'top' }}
                    />
                    {attestError ? (
                      <Text style={{ fontSize: 13, color: '#FCA5A5' }}>{attestError}</Text>
                    ) : null}
                    <BrandButton
                      label={attesting ? 'Registrando…' : 'Registrar firma presencial'}
                      accentColor={primaryColor}
                      variant="ghost"
                      onPress={() => void handleAttest()}
                      disabled={attesting}
                    />
                  </View>
                ) : null}
              </>
            ) : (
              <Text style={{ fontSize: 14, color: C.textMute, lineHeight: 20 }}>
                Estado de carta responsiva no disponible.
              </Text>
            )}
          </Animated.View>

          <SectionLabel>Actividad reciente</SectionLabel>
          <Animated.View entering={FadeInDown.delay(140).duration(380)} style={cardStyle(C)}>
            {activityItems.length > 0 ? (
              activityItems.map((item) => (
                <ActivityRow
                  key={item.key}
                  title={item.title}
                  subtitle={item.subtitle}
                  when={item.when}
                  index={item.index}
                />
              ))
            ) : timelineError ? (
              <Text style={{ fontSize: 14, color: C.textMute, lineHeight: 20 }}>
                Actividad reciente no disponible por ahora.
              </Text>
            ) : (
              <Text style={{ fontSize: 14, color: C.textMute, lineHeight: 20 }}>
                Sin actividad reciente registrada.
              </Text>
            )}
            {!attendanceError && attendanceCount != null ? (
              <Text style={{ fontSize: 13, color: C.textMute, marginTop: 16 }}>
                {attendanceCount} check-in{attendanceCount === 1 ? '' : 's'} en total
              </Text>
            ) : null}
            {profile.bookingStats.totalBookings > 0 ? (
              <Text style={{ fontSize: 13, color: C.textMute, marginTop: 6 }}>
                {profile.bookingStats.totalBookings} reserva
                {profile.bookingStats.totalBookings === 1 ? '' : 's'} ·{' '}
                {profile.bookingStats.attendedCount} asistencias
              </Text>
            ) : null}
          </Animated.View>

          {(from === 'sales' || from === 'directory') ? (
            <SectionLabel>Navegación</SectionLabel>
          ) : null}
          <Animated.View entering={FadeInDown.delay(180).duration(380)} style={{ gap: 12 }}>
            {from === 'sales' ? (
              <BrandButton
                label="Volver a ventas"
                accentColor={primaryColor}
                variant="ghost"
                onPress={() => router.back()}
              />
            ) : null}
            {from === 'directory' ? (
              <BrandButton
                label="Volver al directorio"
                accentColor={primaryColor}
                variant="ghost"
                onPress={() => router.back()}
              />
            ) : null}
          </Animated.View>

          {user?.email ? (
            <Text style={{ fontSize: 11, color: C.textMute, marginTop: 32, textAlign: 'center' }}>
              Operador: {user.email}
            </Text>
          ) : null}
        </ScrollView>
      ) : null}
    </SafeAreaView>
  );
}
