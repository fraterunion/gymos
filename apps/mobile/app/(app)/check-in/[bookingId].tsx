import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BrandButton } from '@/components/BrandButton';
import { createBookingQr, fetchBookingAttendance, type AttendanceSummaryDto } from '@/lib/api/checkInsApi';
import { ApiError } from '@/lib/api/errors';
import {
  isAfterCheckInWindow,
  isBeforeCheckInWindow,
  isWithinCheckInWindow,
  msUntilCheckInOpens,
} from '@/lib/checkInWindow';
import { formatClassRange } from '@/lib/datetime';
import { scheduledClassTitle } from '@/lib/classUtils';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { useStudioActivity } from '@/contexts/StudioActivityContext';

function friendlyApiMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const m = e.message.toLowerCase();
    if (e.status === 404) return 'This reservation could not be found.';
    if (e.status === 403) return 'You do not have access to this reservation.';
    if (m.includes('outside') && m.includes('window')) {
      return 'Check-in is only available shortly before class starts through a short window after start time.';
    }
    if (m.includes('already checked in')) return 'You are already checked in for this class.';
    if (m.includes('expired') || m.includes('invalid')) return 'This code is no longer valid. Generate a new one.';
    if (m.includes('only confirmed')) return 'Only active reservations can show a check-in code.';
    if (m.includes('already used')) return 'This code was already used. Generate a new one.';
    return e.message;
  }
  return 'Something went wrong. Please try again.';
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m <= 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

export default function CheckInQrScreen() {
  const raw = useLocalSearchParams<{ bookingId: string | string[] }>().bookingId;
  const bookingId = typeof raw === 'string' ? raw : raw?.[0] ?? '';
  const { primaryColor } = useBranding();
  const matched = useMemberStudio().matched;
  const { classes, myBookings, refresh } = useStudioActivity();

  const studioId = matched?.studio.id ?? '';
  const timeZone = matched?.studio.timezone ?? 'UTC';

  const booking = useMemo(
    () => myBookings.find((b) => b.id === bookingId),
    [myBookings, bookingId],
  );

  const [hasLoadedAttendance, setHasLoadedAttendance] = useState(false);
  const [attendance, setAttendance] = useState<AttendanceSummaryDto | null>(null);
  const [qrToken, setQrToken] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingQr, setLoadingQr] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const classStartsAt = booking?.scheduledClass.startsAt ?? null;
  const inWindow = classStartsAt ? isWithinCheckInWindow(classStartsAt) : false;
  const tooEarly = classStartsAt ? isBeforeCheckInWindow(classStartsAt) : false;
  const tooLate = classStartsAt ? isAfterCheckInWindow(classStartsAt) : false;

  const secondsLeft = useMemo(() => {
    if (!expiresAt) return 0;
    const exp = new Date(expiresAt).getTime();
    return Math.max(0, Math.floor((exp - Date.now()) / 1000));
  }, [expiresAt, tick]);

  const qrExpired = Boolean(expiresAt && secondsLeft <= 0 && qrToken);

  useEffect(() => {
    if (!expiresAt || !qrToken || secondsLeft <= 0) return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [expiresAt, qrToken, secondsLeft]);

  const loadAttendance = useCallback(async () => {
    if (!studioId || !bookingId) return null;
    setError(null);
    const res = await fetchBookingAttendance(studioId, bookingId);
    setAttendance(res.attendance);
    setHasLoadedAttendance(true);
    if (res.attendance) {
      setQrToken(null);
      setExpiresAt(null);
    }
    return res.attendance;
  }, [studioId, bookingId]);

  const requestQr = useCallback(async () => {
    if (!studioId || !bookingId || !classStartsAt) return;
    if (!isWithinCheckInWindow(classStartsAt)) {
      setError(null);
      return;
    }
    setLoadingQr(true);
    setError(null);
    try {
      const res = await createBookingQr(studioId, bookingId);
      setQrToken(res.qrToken);
      setExpiresAt(res.expiresAt);
      setTick(0);
    } catch (e) {
      setQrToken(null);
      setExpiresAt(null);
      setError(friendlyApiMessage(e));
    } finally {
      setLoadingQr(false);
    }
  }, [studioId, bookingId, classStartsAt]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!studioId || !bookingId) {
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const att = await loadAttendance();
        if (cancelled) return;
        if (!att && classStartsAt && isWithinCheckInWindow(classStartsAt)) {
          await requestQr();
        }
      } catch (e) {
        if (!cancelled) {
          setHasLoadedAttendance(true);
          setAttendance(null);
          setError(friendlyApiMessage(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [studioId, bookingId, classStartsAt, loadAttendance, requestQr]);

  useFocusEffect(
    useCallback(() => {
      if (!studioId || !bookingId) return;
      void (async () => {
        try {
          const att = await loadAttendance();
          if (att) {
            setQrToken(null);
            setExpiresAt(null);
          }
        } catch {
          // pull-to-refresh covers recovery
        }
      })();
    }, [studioId, bookingId, loadAttendance]),
  );

  async function onRefresh() {
    setError(null);
    try {
      const att = await loadAttendance();
      if (att) return;
      if (qrExpired || !qrToken) {
        if (classStartsAt && isWithinCheckInWindow(classStartsAt)) {
          await requestQr();
        }
      }
      await refresh();
    } catch (e) {
      setError(friendlyApiMessage(e));
    }
  }

  if (!matched || !studioId) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-neutral-50 dark:bg-neutral-950">
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  if (!bookingId) {
    return (
      <SafeAreaView className="flex-1 bg-neutral-50 px-6 pt-4 dark:bg-neutral-950">
        <Text className="text-center text-neutral-600 dark:text-neutral-400">Missing booking.</Text>
      </SafeAreaView>
    );
  }

  if (!booking) {
    return (
      <SafeAreaView className="flex-1 bg-neutral-50 px-6 pt-4 dark:bg-neutral-950">
        <Text className="text-center text-lg font-medium text-neutral-800 dark:text-neutral-100">
          Reservation not in your list
        </Text>
        <Text className="mt-3 text-center text-sm leading-5 text-neutral-500 dark:text-neutral-400">
          Pull down to refresh, or open this screen from My bookings after your schedule syncs.
        </Text>
        <View className="mt-8">
          <BrandButton label="Refresh" accentColor={primaryColor} onPress={() => void onRefresh()} />
        </View>
      </SafeAreaView>
    );
  }

  const title = scheduledClassTitle(booking.scheduledClassId, classes);
  const when = formatClassRange(booking.scheduledClass.startsAt, booking.scheduledClass.endsAt, timeZone);

  const checkedIn = hasLoadedAttendance && attendance !== null;

  return (
    <SafeAreaView className="flex-1 bg-neutral-50 dark:bg-neutral-950" edges={['bottom', 'left', 'right']}>
      <ScrollView
        className="flex-1 px-5 pt-2"
        contentContainerClassName="pb-12"
        refreshControl={
          <RefreshControl
            refreshing={loading || loadingQr}
            onRefresh={() => void onRefresh()}
            tintColor={primaryColor}
          />
        }>
        <Text className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          Check-in
        </Text>
        <Text className="mt-1 text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
          {title}
        </Text>
        <Text className="mt-2 text-base text-neutral-600 dark:text-neutral-400">{when}</Text>

        {!hasLoadedAttendance && loading ? (
          <View className="mt-16 items-center">
            <ActivityIndicator size="large" color={primaryColor} />
          </View>
        ) : checkedIn && attendance ? (
          <View className="mt-10 items-center rounded-3xl border border-emerald-200/80 bg-emerald-50 px-6 py-10 dark:border-emerald-900/50 dark:bg-emerald-950/40">
            <View className="mb-4 h-14 w-14 items-center justify-center rounded-full bg-emerald-600">
              <Text className="text-2xl text-white">✓</Text>
            </View>
            <Text className="text-center text-xl font-semibold text-emerald-900 dark:text-emerald-100">
              Checked in
            </Text>
            <Text className="mt-3 text-center text-sm leading-5 text-emerald-800/90 dark:text-emerald-200/90">
              You are on the roster for this class. Enjoy your session.
            </Text>
            <Text className="mt-6 text-center text-xs text-neutral-500 dark:text-neutral-400">
              {new Intl.DateTimeFormat(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short',
              }).format(new Date(attendance.checkedInAt))}
            </Text>
          </View>
        ) : !classStartsAt ? (
          <Text className="mt-8 text-center text-neutral-600 dark:text-neutral-400">Unable to load class time.</Text>
        ) : tooLate ? (
          <View className="mt-10 rounded-3xl border border-neutral-200 bg-white px-6 py-10 dark:border-neutral-800 dark:bg-neutral-900">
            <Text className="text-center text-lg font-semibold text-neutral-900 dark:text-neutral-50">
              Check-in window closed
            </Text>
            <Text className="mt-3 text-center text-sm leading-6 text-neutral-600 dark:text-neutral-400">
              The check-in period for this class has ended. If you still need help, speak with the front desk.
            </Text>
            <View className="mt-8">
              <BrandButton label="Refresh status" accentColor={primaryColor} onPress={() => void onRefresh()} />
            </View>
          </View>
        ) : tooEarly ? (
          <View className="mt-10 rounded-3xl border border-neutral-200 bg-white px-6 py-10 dark:border-neutral-800 dark:bg-neutral-900">
            <Text className="text-center text-lg font-semibold text-neutral-900 dark:text-neutral-50">
              Check-in opens soon
            </Text>
            <Text className="mt-3 text-center text-sm leading-6 text-neutral-600 dark:text-neutral-400">
              You can show a check-in code starting 15 minutes before class through a short window after start
              time.
            </Text>
            {tooEarly && msUntilCheckInOpens(classStartsAt) > 0 ? (
              <Text className="mt-6 text-center text-sm font-medium text-neutral-700 dark:text-neutral-300">
                Opens in ~{Math.ceil(msUntilCheckInOpens(classStartsAt) / 60000)} min
              </Text>
            ) : null}
            <View className="mt-8">
              <BrandButton label="Refresh status" accentColor={primaryColor} onPress={() => void onRefresh()} />
            </View>
          </View>
        ) : qrExpired ? (
          <View className="mt-10">
            <View className="rounded-3xl border border-amber-200 bg-amber-50 px-6 py-8 dark:border-amber-900/40 dark:bg-amber-950/30">
              <Text className="text-center text-base font-semibold text-amber-900 dark:text-amber-100">
                Code expired
              </Text>
              <Text className="mt-2 text-center text-sm text-amber-900/80 dark:text-amber-200/80">
                Generate a fresh code for the front desk.
              </Text>
            </View>
            <View className="mt-6">
              <BrandButton
                label="Show new code"
                accentColor={primaryColor}
                loading={loadingQr}
                onPress={() => void requestQr()}
              />
            </View>
          </View>
        ) : qrToken ? (
          <View className="mt-10 items-center">
            <View className="w-full max-w-[320px] overflow-hidden rounded-3xl border border-neutral-200 bg-white p-8 shadow-sm dark:border-neutral-700 dark:bg-neutral-950">
              <View className="items-center rounded-2xl bg-white p-4">
                <QRCode value={qrToken} size={220} color="#0a0a0a" backgroundColor="#ffffff" />
              </View>
              <Text className="mt-6 text-center text-sm font-medium text-neutral-800 dark:text-neutral-100">
                Show this code at the front desk
              </Text>
              <Text className="mt-2 text-center text-xs leading-5 text-neutral-500 dark:text-neutral-400">
                Staff will scan it to confirm your arrival. Do not share this screen with anyone else.
              </Text>
              <View className="mt-6 rounded-2xl bg-neutral-100 px-4 py-3 dark:bg-neutral-900">
                <Text className="text-center text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                  Refreshes in
                </Text>
                <Text className="mt-1 text-center text-lg font-semibold tabular-nums text-neutral-900 dark:text-neutral-50">
                  {formatCountdown(secondsLeft)}
                </Text>
              </View>
            </View>
            <View className="mt-8 w-full max-w-[320px]">
              <BrandButton
                label="Refresh code"
                variant="ghost"
                accentColor={primaryColor}
                loading={loadingQr}
                onPress={() => void requestQr()}
              />
            </View>
          </View>
        ) : (
          <View className="mt-10">
            {error ? (
              <View className="mb-6 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 dark:border-red-900/40 dark:bg-red-950/30">
                <Text className="text-center text-sm text-red-800 dark:text-red-200">{error}</Text>
              </View>
            ) : null}
            <BrandButton
              label={loadingQr ? 'Preparing…' : 'Show check-in code'}
              accentColor={primaryColor}
              loading={loadingQr}
              onPress={() => void requestQr()}
            />
          </View>
        )}

        {error && hasLoadedAttendance && inWindow && qrToken && !qrExpired && !checkedIn ? (
          <Text className="mt-6 text-center text-sm text-red-600 dark:text-red-400">{error}</Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
