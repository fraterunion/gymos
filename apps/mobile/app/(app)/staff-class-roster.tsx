import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { LoadRetryPanel, ScreenLoader } from '@/components/StudioScreenChrome';
import {
  MemberRow,
  StatCard,
  TabStrip,
} from '@/components/staff/StaffPrimitives';
import { RegisterAttendanceModal } from '@/components/staff/RegisterAttendanceModal';
import { getColors, Radius, Space } from '@/constants/Theme';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { ApiError } from '@/lib/api/errors';
import {
  fetchClassAttendance,
  fetchClassRoster,
  staffForceCheckIn,
  type AttendanceSummaryDto,
  type ClassRosterEntryDto,
} from '@/lib/api/checkInsApi';
import { fetchScheduledClassById, type ScheduledClassDetailDto } from '@/lib/api/scheduleApi';
import { fetchClassWaitlist, type ClassWaitlistEntryDto } from '@/lib/api/staffWaitlistApi';
import {
  DEFAULT_CHECK_IN_EARLY_MINUTES,
  isWithinCheckInWindow,
} from '@/lib/checkInWindow';
import { formatClassRange, formatClassTime } from '@/lib/datetime';
import { canManualCheckIn, canRegisterManualAttendance } from '@/lib/staffRole';
import { staffScanErrorCopy } from '@/lib/staffScanFeedback';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';

type RosterRow = {
  bookingId: string;
  userId: string;
  fullName: string;
  initials: string;
  checkedIn: boolean;
  checkedInAt: string | null;
  checkInMethod: string | null;
  isWalkIn: boolean;
};

type Segment = 'reservations' | 'waitlist' | 'attendance';

function searchParam(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0];
}

function memberInitials(firstName: string, lastName: string): string {
  const a = firstName?.[0] ?? '';
  const b = lastName?.[0] ?? '';
  return `${a}${b}`.toUpperCase() || '?';
}

function formatCheckInMethod(method: string | null): string {
  if (!method) return '';
  switch (method.toUpperCase()) {
    case 'QR': return 'QR';
    case 'MANUAL': return 'Manual';
    case 'KIOSK': return 'Kiosco';
    default: return method;
  }
}

function mergeRosterRows(
  roster: ClassRosterEntryDto[],
  attendance: AttendanceSummaryDto[],
): RosterRow[] {
  const byUserId = new Map<string, AttendanceSummaryDto>();
  for (const row of attendance) {
    if (!byUserId.has(row.userId)) byUserId.set(row.userId, row);
  }
  const rosterUserIds = new Set(roster.map((entry) => entry.userId));
  const rows: RosterRow[] = roster.map((entry) => {
    const att = byUserId.get(entry.userId);
    const fullName = `${entry.user.firstName} ${entry.user.lastName}`.trim();
    return {
      bookingId: entry.id,
      userId: entry.userId,
      fullName,
      initials: memberInitials(entry.user.firstName, entry.user.lastName),
      checkedIn: Boolean(att),
      checkedInAt: att?.checkedInAt ?? null,
      checkInMethod: att?.checkInMethod ?? null,
      isWalkIn: false,
    };
  });
  for (const att of attendance) {
    if (rosterUserIds.has(att.userId)) continue;
    rows.push({
      bookingId: `walk-in-${att.userId}`,
      userId: att.userId,
      fullName: `${att.user.firstName} ${att.user.lastName}`.trim(),
      initials: memberInitials(att.user.firstName, att.user.lastName),
      checkedIn: true,
      checkedInAt: att.checkedInAt,
      checkInMethod: att.checkInMethod,
      isWalkIn: true,
    });
  }
  return rows;
}

function ManualBadge() {
  const C = getColors();
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: C.separator,
        borderRadius: 999,
        paddingHorizontal: 8,
        paddingVertical: 2,
        backgroundColor: 'rgba(255,255,255,0.06)',
      }}
    >
      <Text style={{ fontSize: 10, fontWeight: '700', letterSpacing: 0.6, color: C.textMute }}>
        MANUAL
      </Text>
    </View>
  );
}

function classStatusLabel(status: string | undefined): string {
  if (!status) return 'Programada';
  if (status === 'CANCELLED') return 'Cancelada';
  if (status === 'COMPLETED') return 'Completada';
  return status;
}

function CheckInButton({
  loading,
  onPress,
}: {
  loading: boolean;
  onPress: () => void;
}) {
  const C = getColors();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={loading}
      style={{
        paddingHorizontal: Space.sp2,
        paddingVertical: 8,
        borderRadius: Radius.button,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.25)',
        opacity: loading ? 0.5 : 1,
        minWidth: 80,
        alignItems: 'center',
      }}
    >
      <Text style={{ fontSize: 13, fontWeight: '700', color: C.text }}>
        {loading ? '…' : 'Check-in'}
      </Text>
    </Pressable>
  );
}

const SEGMENT_OPTIONS: { id: Segment; label: string }[] = [
  { id: 'reservations', label: 'Reservas' },
  { id: 'waitlist', label: 'Espera' },
  { id: 'attendance', label: 'Asistencia' },
];

export default function StaffClassRosterScreen() {
  const C = getColors();
  const params = useLocalSearchParams<{
    classId?: string | string[];
    className?: string | string[];
  }>();
  const classId = searchParam(params.classId);
  const className = searchParam(params.className);

  const { matched, refetch } = useMemberStudio();
  const studioId = matched?.studio.id;
  const timeZone = matched?.studio.timezone ?? 'UTC';
  const role = matched?.role;
  const manualCheckInAllowed = canManualCheckIn(role);
  const registerAttendanceAllowed = canRegisterManualAttendance(role);
  const isInstructor = role === 'INSTRUCTOR';

  const [segment, setSegment] = useState<Segment>('reservations');
  const [rows, setRows] = useState<RosterRow[]>([]);
  const [waitlist, setWaitlist] = useState<ClassWaitlistEntryDto[]>([]);
  const [waitlistNote, setWaitlistNote] = useState<string | null>(null);
  const [classDetail, setClassDetail] = useState<ScheduledClassDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [checkingInBookingId, setCheckingInBookingId] = useState<string | null>(null);
  const [successName, setSuccessName] = useState<string | null>(null);
  const [registerModalVisible, setRegisterModalVisible] = useState(false);

  const checkInWindowMinutes =
    classDetail?.checkInWindowMinutes ?? DEFAULT_CHECK_IN_EARLY_MINUTES;
  const showCheckInOps = classDetail
    ? manualCheckInAllowed &&
      isWithinCheckInWindow(classDetail.startsAt, new Date(), checkInWindowMinutes)
    : false;

  const load = useCallback(
    async (isRefresh = false) => {
      if (!studioId || !classId) return;
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      setWaitlistNote(null);
      try {
        const [detail, roster, attendance] = await Promise.all([
          fetchScheduledClassById(studioId, classId),
          fetchClassRoster(studioId, classId),
          fetchClassAttendance(studioId, classId),
        ]);
        setClassDetail(detail);
        setRows(mergeRosterRows(roster, attendance));

        try {
          const w = await fetchClassWaitlist(studioId, classId);
          setWaitlist(w.filter((e) => e.status === 'WAITING'));
        } catch (e) {
          setWaitlist([]);
          if (e instanceof ApiError && (e.status === 403 || e.status === 401)) {
            setWaitlistNote('No tienes acceso a la lista de espera.');
          }
        }
      } catch (e) {
        setClassDetail(null);
        setError(
          userFacingApiMessage(e, 'No pudimos cargar la lista de la clase. Desliza hacia abajo para actualizar e inténtalo de nuevo.'),
        );
        if (!isRefresh) {
          setRows([]);
          setWaitlist([]);
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
        setLoadedOnce(true);
      }
    },
    [studioId, classId],
  );

  useFocusEffect(
    useCallback(() => {
      if (studioId && classId) void load();
    }, [studioId, classId, load]),
  );

  const checkedInRows = useMemo(() => rows.filter((r) => r.checkedIn), [rows]);
  const expectedRows = useMemo(() => rows.filter((r) => !r.checkedIn), [rows]);
  const reservedUserIds = useMemo(
    () => new Set(rows.filter((r) => !r.isWalkIn).map((r) => r.userId)),
    [rows],
  );

  const handleRegisteredAttendance = useCallback((attendance: AttendanceSummaryDto) => {
    setRows((prev) => {
      const existing = prev.find((r) => r.userId === attendance.userId);
      if (existing) {
        return prev.map((r) =>
          r.userId === attendance.userId
            ? {
                ...r,
                checkedIn: true,
                checkedInAt: attendance.checkedInAt,
                checkInMethod: attendance.checkInMethod,
              }
            : r,
        );
      }
      return [
        ...prev,
        {
          bookingId: `walk-in-${attendance.userId}`,
          userId: attendance.userId,
          fullName: `${attendance.user.firstName} ${attendance.user.lastName}`.trim(),
          initials: memberInitials(attendance.user.firstName, attendance.user.lastName),
          checkedIn: true,
          checkedInAt: attendance.checkedInAt,
          checkInMethod: attendance.checkInMethod,
          isWalkIn: true,
        },
      ];
    });
    setSuccessName(`${attendance.user.firstName} ${attendance.user.lastName}`.trim());
    setTimeout(() => setSuccessName(null), 3000);
  }, []);

  const handleCheckIn = useCallback(
    async (row: RosterRow) => {
      if (!studioId || !showCheckInOps) return;
      setCheckingInBookingId(row.bookingId);
      try {
        const attendance = await staffForceCheckIn(studioId, row.userId, row.bookingId);
        setRows((prev) =>
          prev.map((r) =>
            r.bookingId === row.bookingId
              ? {
                  ...r,
                  checkedIn: true,
                  checkedInAt: attendance.checkedInAt,
                  checkInMethod: attendance.checkInMethod,
                }
              : r,
          ),
        );
        setSuccessName(row.fullName);
        setTimeout(() => setSuccessName(null), 3000);
      } catch (e) {
        const { title, message } = staffScanErrorCopy(e);
        Alert.alert(title, message);
        if (
          e instanceof ApiError &&
          (e.message.toLowerCase().includes('already checked in') ||
            e.message.toLowerCase().includes('time window') ||
            e.message.toLowerCase().includes('not yet available'))
        ) {
          void load(true);
        }
      } finally {
        setCheckingInBookingId(null);
      }
    },
    [studioId, showCheckInOps, load],
  );

  const headerTitle =
    (classDetail?.classTemplate.name ?? className?.trim()) || 'Detalle de clase';
  const totalBooked = classDetail?.bookedCount ?? rows.length;
  const checkedInCount = Math.max(classDetail?.checkedInCount ?? 0, checkedInRows.length);
  const waitlistCount = classDetail?.waitlistCount ?? waitlist.length;
  const capacity = classDetail?.capacity ?? 0;

  const isFutureClass =
    classDetail != null && new Date(classDetail.startsAt).getTime() > Date.now();
  const isPastClass =
    classDetail != null && new Date(classDetail.endsAt).getTime() < Date.now();

  const emptyTitle = isFutureClass
    ? 'Sin reservas aún.'
    : isPastClass
      ? 'Sin registros para esta clase.'
      : 'Sin reservaciones confirmadas.';
  const emptyBody = isFutureClass
    ? 'Cuando los miembros reserven, aparecerán aquí.'
    : isPastClass
      ? 'No hubo reservas confirmadas ni check-ins registrados.'
      : 'Los miembros con reservaciones confirmadas aparecerán aquí.';

  const coachName = classDetail?.instructor
    ? `${classDetail.instructor.firstName} ${classDetail.instructor.lastName}`
    : 'Sin coach asignado';

  if (!classId) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <Stack.Screen options={{ title: 'Detalle de clase' }} />
        <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 32 }}>
          <Text style={{ textAlign: 'center', fontSize: 15, lineHeight: 22, color: C.textSub }}>
            Falta información de la clase. Regresa e inténtalo de nuevo.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!studioId) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <Stack.Screen options={{ title: headerTitle }} />
        <LoadRetryPanel
          message="No pudimos cargar tu estudio. Revisa tu conexión e inténtalo de nuevo."
          onRetry={() => void refetch()}
        />
      </SafeAreaView>
    );
  }

  if (loading && !loadedOnce) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <Stack.Screen options={{ title: headerTitle }} />
        <ScreenLoader />
      </SafeAreaView>
    );
  }

  if (error && rows.length === 0 && !classDetail) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <Stack.Screen options={{ title: headerTitle }} />
        <LoadRetryPanel message={error} onRetry={() => void load()} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['left', 'right', 'bottom']}>
      <Stack.Screen options={{ title: headerTitle, headerLargeTitle: false }} />

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: Space.screenH, paddingBottom: 40 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor="rgba(255,255,255,0.35)" />
        }
      >
        {/* ── Class hero ── */}
        <Animated.View entering={FadeInDown.duration(300)} style={{ paddingTop: 8, paddingBottom: Space.sp4 }}>
          <Text
            style={{
              fontSize: 36,
              fontWeight: '800',
              letterSpacing: -1.4,
              color: C.text,
              lineHeight: 40,
              marginBottom: 10,
            }}
          >
            {headerTitle}
          </Text>
          {classDetail ? (
            <>
              <Text style={{ fontSize: 16, fontWeight: '600', color: C.textSub, lineHeight: 22, marginBottom: 4 }}>
                {formatClassRange(classDetail.startsAt, classDetail.endsAt, timeZone)}
              </Text>
              <Text style={{ fontSize: 14, color: C.textMute, marginBottom: 4 }}>{coachName}</Text>
              <Text style={{ fontSize: 13, color: C.textMute }}>
                {classStatusLabel(classDetail.status)}
                {!showCheckInOps ? ' · Solo lectura' : ''}
              </Text>
            </>
          ) : null}
        </Animated.View>

        {/* ── Check-in success — inline text, no banner card ── */}
        {successName ? (
          <Animated.View entering={FadeInDown.duration(300)} style={{ marginBottom: Space.sp3 }}>
            <Text style={{ fontSize: 14, fontWeight: '600', color: C.positive }}>
              {successName} · Check-in registrado
            </Text>
          </Animated.View>
        ) : null}

        {/* ── Stats — open metric row, no card containers ── */}
        <Animated.View entering={FadeInDown.delay(40).duration(300)}>
          <View style={{ flexDirection: 'row', marginBottom: Space.sp4 }}>
            <StatCard value={String(totalBooked)} label="Confirmados" />
            <StatCard value={String(waitlistCount)} label="Espera" />
            <StatCard value={String(checkedInCount)} label="Check-in" />
            <StatCard value={String(capacity)} label="Capacidad" />
          </View>
        </Animated.View>

        {/* ── Tab strip — GymOS signature ── */}
        <TabStrip<Segment>
          options={SEGMENT_OPTIONS}
          value={segment}
          onChange={setSegment}
        />

        {/* ── Reservations segment ── */}
        {segment === 'reservations' ? (
          expectedRows.length === 0 && rows.length === 0 ? (
            <View style={{ paddingTop: Space.sp3, paddingBottom: Space.sp4 }}>
              <Text style={{ fontSize: 17, fontWeight: '600', color: C.text }}>{emptyTitle}</Text>
              <Text style={{ fontSize: 14, color: C.textSub, marginTop: 6, lineHeight: 21 }}>{emptyBody}</Text>
            </View>
          ) : (
            <View>
              {isInstructor ? (
                <Text style={{ fontSize: 13, color: C.textMute, paddingVertical: Space.sp2, lineHeight: 19 }}>
                  El check-in manual está disponible para staff y administradores.
                </Text>
              ) : null}
              {expectedRows.map((row, index) => (
                <MemberRow
                  key={row.bookingId}
                  initials={row.initials}
                  name={row.fullName}
                  subtitle="Sin check-in"
                  index={index}
                  trailing={
                    showCheckInOps ? (
                      <CheckInButton
                        loading={checkingInBookingId === row.bookingId}
                        onPress={() => void handleCheckIn(row)}
                      />
                    ) : (
                      <FontAwesome name="chevron-right" size={12} color={C.textMute} />
                    )
                  }
                />
              ))}
              {expectedRows.length === 0 && rows.length > 0 ? (
                <Text style={{ fontSize: 14, color: C.textSub, textAlign: 'center', paddingVertical: Space.sp5 }}>
                  Todos ya tienen check-in.
                </Text>
              ) : null}
            </View>
          )
        ) : null}

        {/* ── Waitlist segment ── */}
        {segment === 'waitlist' ? (
          waitlist.length === 0 ? (
            <View style={{ paddingTop: Space.sp3, paddingBottom: Space.sp4 }}>
              <Text style={{ fontSize: 17, fontWeight: '600', color: C.text }}>
                {waitlistNote ?? 'Sin lista de espera.'}
              </Text>
              <Text style={{ fontSize: 14, color: C.textSub, marginTop: 6, lineHeight: 21 }}>
                {waitlistNote
                  ? 'Contacta a un administrador si necesitas acceso.'
                  : 'Nadie en espera para esta clase.'}
              </Text>
            </View>
          ) : (
            <View>
              {waitlist.map((entry, index) => (
                <MemberRow
                  key={entry.id}
                  initials={memberInitials(entry.user.firstName, entry.user.lastName)}
                  name={`${entry.user.firstName} ${entry.user.lastName}`}
                  subtitle={`Posición ${entry.position}`}
                  index={index}
                />
              ))}
            </View>
          )
        ) : null}

        {/* ── Attendance segment ── */}
        {segment === 'attendance' ? (
          checkedInRows.length === 0 ? (
            <View style={{ paddingTop: Space.sp3, paddingBottom: Space.sp4 }}>
              <Text style={{ fontSize: 17, fontWeight: '600', color: C.text }}>Sin check-ins aún.</Text>
              <Text style={{ fontSize: 14, color: C.textSub, marginTop: 6, lineHeight: 21 }}>
                Los miembros que registren asistencia aparecerán aquí.
              </Text>
            </View>
          ) : (
            <View>
              {checkedInRows.map((row, index) => {
                const timeLabel = row.checkedInAt ? formatClassTime(row.checkedInAt, timeZone) : '—';
                const methodLabel = formatCheckInMethod(row.checkInMethod);
                return (
                  <MemberRow
                    key={row.bookingId}
                    initials={row.initials}
                    name={row.fullName}
                    subtitle={`${timeLabel}${methodLabel ? ` · ${methodLabel}` : ''}`}
                    badge={row.isWalkIn ? <ManualBadge /> : undefined}
                    index={index}
                  />
                );
              })}
            </View>
          )
        ) : null}

        {registerAttendanceAllowed ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => setRegisterModalVisible(true)}
            style={{
              marginTop: Space.sp4,
              marginBottom: Space.sp3,
              paddingVertical: 16,
              borderRadius: Radius.button,
              backgroundColor: C.text,
              alignItems: 'center',
            }}
          >
            <Text style={{ fontSize: 15, fontWeight: '700', color: C.bg }}>+ Agregar asistencia</Text>
          </Pressable>
        ) : null}

        {showCheckInOps && expectedRows.length > 0 ? (
          <Text style={{ fontSize: 12, color: C.textMute, textAlign: 'center', marginBottom: Space.sp3 }}>
            Ventana de check-in activa
          </Text>
        ) : null}
      </ScrollView>

      {studioId && classId ? (
        <RegisterAttendanceModal
          visible={registerModalVisible}
          studioId={studioId}
          classId={classId}
          classStartsAt={classDetail?.startsAt}
          timeZone={timeZone}
          reservedUserIds={reservedUserIds}
          onClose={() => setRegisterModalVisible(false)}
          onRegistered={handleRegisteredAttendance}
        />
      ) : null}
    </SafeAreaView>
  );
}
