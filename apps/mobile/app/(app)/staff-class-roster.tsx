import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { BrandButton } from '@/components/BrandButton';
import { LoadRetryPanel, ScreenLoader } from '@/components/StudioScreenChrome';
import { useBranding } from '@/contexts/BrandingContext';
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
import {
  DEFAULT_CHECK_IN_EARLY_MINUTES,
  isWithinCheckInWindow,
} from '@/lib/checkInWindow';
import { formatClassRange, formatClassTime } from '@/lib/datetime';
import { canManualCheckIn } from '@/lib/staffRole';
import { staffScanErrorCopy } from '@/lib/staffScanFeedback';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';
import { getColors, Space, type ThemeColors } from '@/constants/Theme';

type RosterRow = {
  bookingId: string;
  userId: string;
  fullName: string;
  initials: string;
  checkedIn: boolean;
  checkedInAt: string | null;
  checkInMethod: string | null;
};

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

function memberInitials(firstName: string, lastName: string): string {
  const a = firstName?.[0] ?? '';
  const b = lastName?.[0] ?? '';
  return `${a}${b}`.toUpperCase() || '?';
}

function formatCheckInMethod(method: string | null): string {
  if (!method) return '';
  switch (method.toUpperCase()) {
    case 'QR':
      return 'QR';
    case 'MANUAL':
      return 'Manual';
    case 'KIOSK':
      return 'Kiosco';
    default:
      return method;
  }
}

function mergeRosterRows(
  roster: ClassRosterEntryDto[],
  attendance: AttendanceSummaryDto[],
): RosterRow[] {
  const byUserId = new Map<string, AttendanceSummaryDto>();
  for (const row of attendance) {
    if (!byUserId.has(row.userId)) {
      byUserId.set(row.userId, row);
    }
  }

  return roster.map((entry) => {
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
    };
  });
}

function SummaryStat({ value, label }: { value: string; label: string }) {
  const C = getColors();
  return (
    <View style={{ flex: 1, alignItems: 'center' }}>
      <Text
        style={{
          fontSize: 24,
          fontWeight: '800',
          letterSpacing: -0.6,
          color: C.text,
          lineHeight: 28,
        }}
      >
        {value}
      </Text>
      <Text
        style={{
          fontSize: 10,
          fontWeight: '700',
          letterSpacing: 0.7,
          textTransform: 'uppercase',
          color: C.textMute,
          marginTop: 4,
        }}
      >
        {label}
      </Text>
    </View>
  );
}

function CheckedInRow({
  row,
  timeZone,
  isLast,
}: {
  row: RosterRow;
  timeZone: string;
  isLast?: boolean;
}) {
  const C = getColors();
  const timeLabel = row.checkedInAt ? formatClassTime(row.checkedInAt, timeZone) : '—';
  const methodLabel = formatCheckInMethod(row.checkInMethod);

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 14,
        borderBottomWidth: isLast ? 0 : 1,
        borderBottomColor: C.separator,
      }}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 18,
          backgroundColor: 'rgba(52,211,153,0.14)',
          alignItems: 'center',
          justifyContent: 'center',
          marginRight: 14,
        }}
      >
        <FontAwesome name="check" size={14} color={C.positive} />
      </View>
      <View style={{ flex: 1 }}>
        <Text
          style={{
            fontSize: 16,
            fontWeight: '600',
            color: C.text,
            letterSpacing: -0.2,
          }}
          numberOfLines={1}
        >
          {row.fullName}
        </Text>
        <Text style={{ fontSize: 13, color: C.textMute, marginTop: 2 }}>
          {timeLabel}
          {methodLabel ? ` · ${methodLabel}` : ''}
        </Text>
      </View>
    </View>
  );
}

function ExpectedRow({
  row,
  canCheckIn,
  checkingIn,
  onCheckIn,
  isLast,
}: {
  row: RosterRow;
  canCheckIn: boolean;
  checkingIn: boolean;
  onCheckIn: () => void;
  isLast?: boolean;
}) {
  const C = getColors();
  const { primaryColor } = useBranding();

  return (
    <View
      style={{
        paddingVertical: 16,
        borderBottomWidth: isLast ? 0 : 1,
        borderBottomColor: C.separator,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: canCheckIn ? 14 : 0 }}>
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            backgroundColor: '#1E1E22',
            borderWidth: 1,
            borderColor: C.separator,
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: 14,
          }}
        >
          <Text style={{ fontSize: 14, fontWeight: '700', color: C.text }}>
            {row.initials}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text
            style={{
              fontSize: 16,
              fontWeight: '600',
              color: C.text,
              letterSpacing: -0.2,
            }}
            numberOfLines={1}
          >
            {row.fullName}
          </Text>
          <Text style={{ fontSize: 13, color: C.textMute, marginTop: 2 }}>
            Sin check-in
          </Text>
        </View>
      </View>
      {canCheckIn ? (
        <BrandButton
          label="Check-in"
          variant="white"
          accentColor={primaryColor}
          loading={checkingIn}
          disabled={checkingIn}
          onPress={onCheckIn}
        />
      ) : null}
    </View>
  );
}

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
  const isInstructor = role === 'INSTRUCTOR';

  const [rows, setRows] = useState<RosterRow[]>([]);
  const [classDetail, setClassDetail] = useState<ScheduledClassDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [checkingInBookingId, setCheckingInBookingId] = useState<string | null>(null);
  const [successName, setSuccessName] = useState<string | null>(null);

  const checkInWindowMinutes =
    classDetail?.checkInWindowMinutes ?? DEFAULT_CHECK_IN_EARLY_MINUTES;
  const showCheckInOps = classDetail
    ? manualCheckInAllowed &&
      isWithinCheckInWindow(classDetail.startsAt, new Date(), checkInWindowMinutes)
    : false;
  const isFutureClass =
    classDetail != null &&
    new Date(classDetail.startsAt).getTime() > Date.now();
  const isPastClass =
    classDetail != null &&
    new Date(classDetail.endsAt).getTime() < Date.now();

  const load = useCallback(
    async (isRefresh = false) => {
      if (!studioId || !classId) return;
      if (isRefresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(null);
      try {
        const [detail, roster, attendance] = await Promise.all([
          fetchScheduledClassById(studioId, classId),
          fetchClassRoster(studioId, classId),
          fetchClassAttendance(studioId, classId),
        ]);
        setClassDetail(detail);
        setRows(mergeRosterRows(roster, attendance));
      } catch (e) {
        setClassDetail(null);
        setError(
          userFacingApiMessage(e, 'No pudimos cargar la lista de la clase. Desliza hacia abajo para actualizar e inténtalo de nuevo.'),
        );
        if (!isRefresh) {
          setRows([]);
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
      if (studioId && classId) {
        void load();
      }
    }, [studioId, classId, load]),
  );

  const checkedInRows = useMemo(() => rows.filter((r) => r.checkedIn), [rows]);
  const expectedRows = useMemo(() => rows.filter((r) => !r.checkedIn), [rows]);

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
    (classDetail?.classTemplate.name ?? className?.trim()) || 'Lista de clase';
  const totalBooked = classDetail?.bookedCount ?? rows.length;
  const checkedInCount = classDetail?.checkedInCount ?? checkedInRows.length;
  const pendingCount = Math.max(0, totalBooked - checkedInCount);
  const waitlistCount = classDetail?.waitlistCount ?? 0;
  const showInitialLoader = loading && !loadedOnce;
  const emptyTitle = isFutureClass
    ? 'No hay reservas para esta clase.'
    : isPastClass
      ? 'No hay registros para esta clase.'
      : 'Aún no hay reservaciones confirmadas.';
  const emptyBody = isFutureClass
    ? 'Cuando los miembros reserven, aparecerán aquí.'
    : isPastClass
      ? 'No hubo reservas confirmadas ni check-ins registrados.'
      : 'Los miembros con reservaciones confirmadas aparecerán aquí.';

  if (!classId) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <Stack.Screen options={{ title: 'Lista de clase' }} />
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

  if (showInitialLoader) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <Stack.Screen options={{ title: headerTitle }} />
        <ScreenLoader />
      </SafeAreaView>
    );
  }

  if (error && rows.length === 0) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <Stack.Screen options={{ title: headerTitle }} />
        <LoadRetryPanel message={error} onRetry={() => void load()} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['left', 'right', 'bottom']}>
      <Stack.Screen options={{ title: headerTitle }} />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: Space.screenH,
          paddingBottom: 40,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load(true)}
            tintColor="rgba(255,255,255,0.4)"
          />
        }
      >
        <Animated.View entering={FadeInDown.duration(420)} style={{ paddingTop: 8, paddingBottom: 20 }}>
          {classDetail ? (
            <Text style={{ fontSize: 14, color: C.textSub, lineHeight: 21, marginBottom: 8 }}>
              {formatClassRange(classDetail.startsAt, classDetail.endsAt, timeZone)}
            </Text>
          ) : null}
          <Text style={{ fontSize: 15, color: C.textSub, lineHeight: 22 }}>
            {checkedInCount} con check-in · {totalBooked} reservados
            {waitlistCount > 0 ? ` · ${waitlistCount} en lista de espera` : ''}
          </Text>
        </Animated.View>

        {successName ? (
          <Animated.View entering={FadeInDown.duration(300)} style={{ marginBottom: 16 }}>
            <View
              style={{
                backgroundColor: 'rgba(52,211,153,0.12)',
                borderRadius: 14,
                borderWidth: 1,
                borderColor: 'rgba(52,211,153,0.25)',
                paddingVertical: 12,
                paddingHorizontal: 16,
              }}
            >
              <Text style={{ fontSize: 14, fontWeight: '600', color: C.positive, textAlign: 'center' }}>
                {successName} registró check-in
              </Text>
            </View>
          </Animated.View>
        ) : null}

        <Animated.View entering={FadeInDown.delay(40).duration(420)}>
          <View style={cardStyle(C)}>
            <View style={{ flexDirection: 'row' }}>
              <SummaryStat value={String(totalBooked)} label="Reservados" />
              <SummaryStat value={String(checkedInCount)} label="Check-in" />
              <SummaryStat value={String(pendingCount)} label="Pendientes" />
            </View>
          </View>
        </Animated.View>

        {rows.length === 0 ? (
          <Animated.View entering={FadeInDown.delay(80).duration(420)}>
            <View style={[cardStyle(C), { alignItems: 'center', paddingVertical: 40, marginTop: 28 }]}>
              <Text
                style={{
                  fontSize: 18,
                  fontWeight: '700',
                  letterSpacing: -0.3,
                  color: C.text,
                  textAlign: 'center',
                  marginBottom: 8,
                }}
              >
                {emptyTitle}
              </Text>
              <Text style={{ fontSize: 14, color: C.textSub, lineHeight: 21, textAlign: 'center' }}>
                {emptyBody}
              </Text>
            </View>
          </Animated.View>
        ) : (
          <>
            {checkedInRows.length > 0 ? (
              <Animated.View entering={FadeInDown.delay(80).duration(420)}>
                <SectionLabel>Check-in</SectionLabel>
                <View style={[cardStyle(C), { paddingVertical: 8, paddingHorizontal: 20 }]}>
                  {checkedInRows.map((row, index) => (
                    <CheckedInRow
                      key={row.bookingId}
                      row={row}
                      timeZone={timeZone}
                      isLast={index === checkedInRows.length - 1}
                    />
                  ))}
                </View>
              </Animated.View>
            ) : null}

            {expectedRows.length > 0 ? (
              <Animated.View entering={FadeInDown.delay(120).duration(420)}>
                <SectionLabel>Esperados</SectionLabel>
                {isInstructor ? (
                  <Text
                    style={{
                      fontSize: 13,
                      color: C.textMute,
                      lineHeight: 19,
                      marginBottom: 14,
                    }}
                  >
                    El check-in manual está disponible para staff y administradores.
                  </Text>
                ) : null}
                <View style={[cardStyle(C), { paddingVertical: 8, paddingHorizontal: 20 }]}>
                  {expectedRows.map((row, index) => (
                    <ExpectedRow
                      key={row.bookingId}
                      row={row}
                      canCheckIn={showCheckInOps}
                      checkingIn={checkingInBookingId === row.bookingId}
                      onCheckIn={() => void handleCheckIn(row)}
                      isLast={index === expectedRows.length - 1}
                    />
                  ))}
                </View>
              </Animated.View>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
