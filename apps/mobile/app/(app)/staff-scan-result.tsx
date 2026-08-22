import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { BrandButton } from '@/components/BrandButton';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { registerManualClassAttendance } from '@/lib/api/checkInsApi';
import { formatClassTime } from '@/lib/datetime';
import { canRegisterManualAttendance } from '@/lib/staffRole';
import { staffScanErrorCopy } from '@/lib/staffScanFeedback';
import type { WalletWalkInCandidate } from '@/lib/walletPassState';
import { getColors, Radius, Space } from '@/constants/Theme';

function searchParam(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0];
}

function parseWalkInCandidates(raw: string | undefined): WalletWalkInCandidate[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as WalletWalkInCandidate[]) : [];
  } catch {
    return [];
  }
}

function DetailRow({ label, value }: { label: string; value: string }) {
  const C = getColors();
  return (
    <View style={{ marginBottom: 14 }}>
      <Text
        style={{
          fontSize: 11,
          fontWeight: '700',
          letterSpacing: 0.8,
          textTransform: 'uppercase',
          color: C.textMute,
          marginBottom: 4,
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          fontSize: 16,
          fontWeight: '600',
          letterSpacing: -0.2,
          color: C.text,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

export default function StaffScanResultScreen() {
  const router = useRouter();
  const C = getColors();
  const { primaryColor } = useBranding();
  const { matched } = useMemberStudio();
  const studioId = matched?.studio.id;
  const [walkInBusy, setWalkInBusy] = useState(false);

  const params = useLocalSearchParams<{
    outcome?: string | string[];
    title?: string | string[];
    message?: string | string[];
    memberName?: string | string[];
    memberId?: string | string[];
    walkInCandidates?: string | string[];
    className?: string | string[];
    classStartTime?: string | string[];
    checkedInAt?: string | string[];
    timeZone?: string | string[];
  }>();

  const outcome = searchParam(params.outcome);
  const isSuccess = outcome === 'success';
  const isNoBooking = outcome === 'no_booking';

  const errorTitle = searchParam(params.title) ?? 'Check-in fallido';
  const errorMessage =
    searchParam(params.message) ?? 'No pudimos completar este check-in. Inténtalo de nuevo.';

  const memberName = searchParam(params.memberName) ?? 'Miembro';
  const className = searchParam(params.className) ?? 'Clase programada';
  const classStartTime = searchParam(params.classStartTime) ?? '—';
  const checkedInAtRaw = searchParam(params.checkedInAt);
  const timeZone = searchParam(params.timeZone) ?? 'UTC';
  const checkedInLabel = checkedInAtRaw
    ? formatClassTime(checkedInAtRaw, timeZone)
    : '—';

  const memberId = searchParam(params.memberId);
  const walkInCandidates = parseWalkInCandidates(searchParam(params.walkInCandidates));
  // Role is re-checked here, not trusted from navigation params: the scan tab admits STAFF,
  // but walk-in attendance is FRONT_DESK | ADMIN | OWNER only. The API enforces this too.
  const walkInAllowed =
    isNoBooking && canRegisterManualAttendance(matched?.role) && walkInCandidates.length > 0;

  function scanAnother() {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(app)/(staff-tabs)/scan' as Href);
    }
  }

  async function registerWalkIn(candidate: WalletWalkInCandidate) {
    if (!studioId || !memberId || walkInBusy) return;
    setWalkInBusy(true);
    try {
      const attendance = await registerManualClassAttendance(studioId, candidate.scheduledClassId, {
        userId: memberId,
      });
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
      // Entitlement, credits and overrides are decided by the manual-attendance endpoint —
      // surface its refusal verbatim rather than guessing at the reason here.
      const { title, message } = staffScanErrorCopy(e);
      const errorParams = new URLSearchParams({ outcome: 'error', title, message });
      router.replace(`/(app)/staff-scan-result?${errorParams.toString()}` as Href);
    } finally {
      setWalkInBusy(false);
    }
  }

  function openWalkIn() {
    if (walkInCandidates.length === 1) {
      void registerWalkIn(walkInCandidates[0]!);
      return;
    }
    const selectParams = new URLSearchParams({
      mode: 'walkin',
      memberName,
      memberId: memberId ?? '',
      candidates: JSON.stringify(walkInCandidates),
      timeZone,
    });
    router.push(`/(app)/staff-scan-select?${selectParams.toString()}` as Href);
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['left', 'right', 'top', 'bottom']}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          flexGrow: 1,
          paddingHorizontal: Space.screenH,
          paddingTop: 28,
          paddingBottom: 40,
          justifyContent: 'center',
        }}
      >
        <Animated.View entering={FadeInDown.duration(300)}>
          <View
            style={{
              backgroundColor: C.surface1,
              borderRadius: Radius.card,
              borderWidth: 1,
              borderColor: C.separator,
              padding: 28,
              alignItems: 'center',
            }}
          >
            <View
              style={{
                width: 72,
                height: 72,
                borderRadius: 36,
                backgroundColor: isSuccess
                  ? 'rgba(52,211,153,0.14)'
                  : isNoBooking
                    ? 'rgba(250,204,21,0.14)'
                    : 'rgba(248,113,113,0.14)',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 20,
              }}
            >
              <FontAwesome
                name={isSuccess ? 'check' : isNoBooking ? 'calendar-o' : 'times'}
                size={32}
                color={isSuccess ? C.positive : isNoBooking ? C.text : C.negative}
              />
            </View>

            <Text
              style={{
                fontSize: 28,
                fontWeight: '800',
                letterSpacing: -0.8,
                color: C.text,
                textAlign: 'center',
                marginBottom: 8,
              }}
            >
              {isSuccess ? 'Entrada registrada' : isNoBooking ? 'Sin reserva' : errorTitle}
            </Text>

            {isSuccess ? (
              <View style={{ alignSelf: 'stretch', marginTop: 12, marginBottom: 8 }}>
                <DetailRow label="Miembro" value={memberName} />
                <DetailRow label="Clase" value={className} />
                <DetailRow label="Inicio de clase" value={classStartTime} />
                <DetailRow label="Check-in a las" value={checkedInLabel} />
              </View>
            ) : isNoBooking ? (
              <>
                <Text
                  style={{
                    fontSize: 18,
                    fontWeight: '700',
                    letterSpacing: -0.3,
                    color: C.text,
                    textAlign: 'center',
                    marginBottom: 6,
                  }}
                >
                  {memberName}
                </Text>
                <Text
                  style={{
                    fontSize: 15,
                    color: C.textSub,
                    lineHeight: 23,
                    textAlign: 'center',
                    marginBottom: 8,
                    maxWidth: 300,
                  }}
                >
                  No tiene una reserva para una clase en este momento.
                </Text>
              </>
            ) : (
              <Text
                style={{
                  fontSize: 15,
                  color: C.textSub,
                  lineHeight: 23,
                  textAlign: 'center',
                  marginBottom: 8,
                  maxWidth: 300,
                }}
              >
                {errorMessage}
              </Text>
            )}

            {walkInAllowed ? (
              <View style={{ alignSelf: 'stretch', marginTop: 20 }}>
                <BrandButton
                  label="Registrar entrada sin reserva"
                  variant="white"
                  accentColor={primaryColor}
                  loading={walkInBusy}
                  onPress={openWalkIn}
                />
              </View>
            ) : null}

            <View style={{ alignSelf: 'stretch', marginTop: walkInAllowed ? 12 : 20 }}>
              <BrandButton
                label={isSuccess || isNoBooking ? 'Escanear otro' : 'Reintentar'}
                variant={walkInAllowed ? 'ghost' : 'white'}
                accentColor={primaryColor}
                onPress={scanAnother}
              />
            </View>
          </View>
        </Animated.View>
      </ScrollView>
    </SafeAreaView>
  );
}
