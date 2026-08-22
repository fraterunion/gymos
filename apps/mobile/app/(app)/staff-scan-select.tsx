import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { BrandButton } from '@/components/BrandButton';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { submitStaffManualCheckIn } from '@/lib/api/checkInsApi';
import { staffScanErrorCopy } from '@/lib/staffScanFeedback';
import { formatClassTime } from '@/lib/datetime';
import { getColors, Space } from '@/constants/Theme';
import type { WalletCandidate } from '@/lib/walletPassState';

function searchParam(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0];
}

/**
 * Resolves Phase 1's WALLET_MULTIPLE_ELIGIBLE_BOOKINGS ambiguity. Staff picks one candidate;
 * the selection is submitted via the SAME canonical /check-ins/manual endpoint (performCheckIn
 * core) every other check-in path uses — no separate attendance-writing logic here.
 */
export default function StaffScanSelectScreen() {
  const router = useRouter();
  const C = getColors();
  const { primaryColor } = useBranding();
  const { matched } = useMemberStudio();
  const studioId = matched?.studio.id ?? '';

  const params = useLocalSearchParams<{
    memberName?: string | string[];
    candidates?: string | string[];
    timeZone?: string | string[];
  }>();

  const memberName = searchParam(params.memberName) ?? 'Miembro';
  const timeZone = searchParam(params.timeZone) ?? 'UTC';
  const candidates = parseCandidates(searchParam(params.candidates));

  const [submittingId, setSubmittingId] = useState<string | null>(null);

  async function selectCandidate(candidate: WalletCandidate) {
    if (submittingId || !studioId) return;
    setSubmittingId(candidate.bookingId);
    try {
      const attendance = await submitStaffManualCheckIn(studioId, candidate.bookingId);
      const successParams = new URLSearchParams({
        outcome: 'success',
        memberName: `${attendance.user.firstName} ${attendance.user.lastName}`.trim(),
        className: candidate.className,
        classStartTime: formatClassTime(candidate.startsAt, timeZone),
        checkedInAt: attendance.checkedInAt,
        timeZone,
      });
      router.replace(`/(app)/staff-scan-result?${successParams.toString()}` as Href);
    } catch (e) {
      const { title, message } = staffScanErrorCopy(e);
      const errorParams = new URLSearchParams({ outcome: 'error', title, message });
      router.replace(`/(app)/staff-scan-result?${errorParams.toString()}` as Href);
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
            {memberName} tiene más de una reservación disponible en este momento:
          </Text>

          {candidates.length === 0 ? (
            <Text style={{ fontSize: 14, color: C.textMute }}>
              No pudimos leer las reservaciones disponibles. Vuelve a escanear.
            </Text>
          ) : (
            <View style={{ gap: 12 }}>
              {candidates.map((c) => (
                <BrandButton
                  key={c.bookingId}
                  label={`${c.className} · ${formatClassTime(c.startsAt, timeZone)}`}
                  variant="white"
                  accentColor={primaryColor}
                  loading={submittingId === c.bookingId}
                  disabled={submittingId !== null && submittingId !== c.bookingId}
                  onPress={() => void selectCandidate(c)}
                />
              ))}
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

function parseCandidates(raw: string | undefined): WalletCandidate[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is WalletCandidate =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as WalletCandidate).bookingId === 'string' &&
        typeof (c as WalletCandidate).className === 'string' &&
        typeof (c as WalletCandidate).startsAt === 'string',
    );
  } catch {
    return [];
  }
}
