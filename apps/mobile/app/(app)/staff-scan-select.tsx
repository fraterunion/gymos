import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { BrandButton } from '@/components/BrandButton';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { registerManualClassAttendance, submitStaffManualCheckIn } from '@/lib/api/checkInsApi';
import { staffScanErrorCopy } from '@/lib/staffScanFeedback';
import { formatClassTime } from '@/lib/datetime';
import { getColors, Space } from '@/constants/Theme';
import type { WalletCandidate, WalletWalkInCandidate } from '@/lib/walletPassState';

function searchParam(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0];
}

/**
 * Disambiguation picker for a scanned member, in two modes:
 *
 *   booking — WALLET_MULTIPLE_ELIGIBLE_BOOKINGS. Staff picks which reservation to check in.
 *   walkin  — WALLET_NO_ELIGIBLE_BOOKING with several classes open. Staff picks which class
 *             to register the member into without a reservation.
 *
 * Neither mode writes attendance here: booking mode posts to the canonical /check-ins/manual
 * (performCheckIn), walk-in mode posts to /classes/:id/manual-attendance, which owns the
 * entitlement/credit/override rules. This screen only decides WHICH class, never WHETHER.
 */
export default function StaffScanSelectScreen() {
  const router = useRouter();
  const C = getColors();
  const { primaryColor } = useBranding();
  const { matched } = useMemberStudio();
  const studioId = matched?.studio.id ?? '';

  const params = useLocalSearchParams<{
    mode?: string | string[];
    memberName?: string | string[];
    memberId?: string | string[];
    candidates?: string | string[];
    timeZone?: string | string[];
  }>();

  const isWalkIn = searchParam(params.mode) === 'walkin';
  const memberName = searchParam(params.memberName) ?? 'Miembro';
  const memberId = searchParam(params.memberId);
  const timeZone = searchParam(params.timeZone) ?? 'UTC';
  const candidates = parseCandidates(searchParam(params.candidates), isWalkIn);

  const [submittingId, setSubmittingId] = useState<string | null>(null);

  function goToResult(search: URLSearchParams) {
    router.replace(`/(app)/staff-scan-result?${search.toString()}` as Href);
  }

  async function selectCandidate(candidate: SelectableCandidate) {
    const key = candidateKey(candidate);
    if (submittingId || !studioId) return;
    setSubmittingId(key);
    try {
      const attendance =
        isWalkIn || !('bookingId' in candidate)
          ? await registerManualClassAttendance(studioId, candidate.scheduledClassId, {
              userId: memberId ?? null,
            })
          : await submitStaffManualCheckIn(studioId, candidate.bookingId);

      goToResult(
        new URLSearchParams({
          outcome: 'success',
          memberName: `${attendance.user.firstName} ${attendance.user.lastName}`.trim(),
          className: candidate.className,
          classStartTime: formatClassTime(candidate.startsAt, timeZone),
          checkedInAt: attendance.checkedInAt,
          timeZone,
        }),
      );
    } catch (e) {
      const { title, message } = staffScanErrorCopy(e);
      goToResult(new URLSearchParams({ outcome: 'error', title, message }));
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['left', 'right', 'top', 'bottom']}>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: Space.screenH, paddingTop: 28, paddingBottom: 40 }}
      >
        <Animated.View entering={FadeInDown.duration(250)}>
          <Text
            style={{ fontSize: 28, fontWeight: '800', letterSpacing: -0.8, color: C.text, marginBottom: 8 }}
            accessibilityRole="header"
          >
            Selecciona la clase
          </Text>
          <Text style={{ fontSize: 15, color: C.textSub, lineHeight: 22, marginBottom: 24 }}>
            {isWalkIn
              ? `Registrarás la entrada de ${memberName} sin reserva en:`
              : `${memberName} tiene más de una reservación disponible en este momento:`}
          </Text>

          {candidates.length === 0 ? (
            <Text style={{ fontSize: 14, color: C.textMute }}>
              {isWalkIn
                ? 'No hay clases disponibles en este momento. Vuelve a escanear.'
                : 'No pudimos leer las reservaciones disponibles. Vuelve a escanear.'}
            </Text>
          ) : (
            <View style={{ gap: 12 }}>
              {candidates.map((c) => {
                const key = candidateKey(c);
                return (
                  <BrandButton
                    key={key}
                    label={`${c.className} · ${formatClassTime(c.startsAt, timeZone)}`}
                    variant="white"
                    accentColor={primaryColor}
                    loading={submittingId === key}
                    disabled={submittingId !== null && submittingId !== key}
                    onPress={() => void selectCandidate(c)}
                  />
                );
              })}
            </View>
          )}

          <View style={{ marginTop: 24 }}>
            <BrandButton
              label="Cancelar"
              variant="ghost"
              accentColor={primaryColor}
              disabled={submittingId !== null}
              onPress={() => router.back()}
            />
          </View>
        </Animated.View>
      </ScrollView>
    </SafeAreaView>
  );
}

type SelectableCandidate = WalletCandidate | WalletWalkInCandidate;

function candidateKey(candidate: SelectableCandidate): string {
  return 'bookingId' in candidate ? candidate.bookingId : candidate.scheduledClassId;
}

function parseCandidates(raw: string | undefined, isWalkIn: boolean): SelectableCandidate[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c): c is SelectableCandidate => {
      if (typeof c !== 'object' || c === null) return false;
      const shape = c as Partial<WalletCandidate>;
      if (typeof shape.className !== 'string' || typeof shape.startsAt !== 'string') return false;
      return isWalkIn
        ? typeof shape.scheduledClassId === 'string'
        : typeof shape.bookingId === 'string';
    });
  } catch {
    return [];
  }
}
