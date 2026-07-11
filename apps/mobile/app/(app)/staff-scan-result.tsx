import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { BrandButton } from '@/components/BrandButton';
import { useBranding } from '@/contexts/BrandingContext';
import { formatClassTime } from '@/lib/datetime';
import { getColors, Radius, Space } from '@/constants/Theme';

function searchParam(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0];
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
  const params = useLocalSearchParams<{
    outcome?: string | string[];
    title?: string | string[];
    message?: string | string[];
    memberName?: string | string[];
    className?: string | string[];
    classStartTime?: string | string[];
    checkedInAt?: string | string[];
    timeZone?: string | string[];
  }>();

  const outcome = searchParam(params.outcome);
  const isSuccess = outcome === 'success';

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

  function scanAnother() {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(app)/(staff-tabs)/scan' as Href);
    }
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
                backgroundColor: isSuccess ? 'rgba(52,211,153,0.14)' : 'rgba(248,113,113,0.14)',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 20,
              }}
            >
              <FontAwesome
                name={isSuccess ? 'check' : 'times'}
                size={32}
                color={isSuccess ? C.positive : C.negative}
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
              {isSuccess ? 'Check-in registrado' : errorTitle}
            </Text>

            {isSuccess ? (
              <View style={{ alignSelf: 'stretch', marginTop: 12, marginBottom: 8 }}>
                <DetailRow label="Miembro" value={memberName} />
                <DetailRow label="Clase" value={className} />
                <DetailRow label="Inicio de clase" value={classStartTime} />
                <DetailRow label="Check-in a las" value={checkedInLabel} />
              </View>
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

            <View style={{ alignSelf: 'stretch', marginTop: 20 }}>
              <BrandButton
                label={isSuccess ? 'Escanear otro' : 'Reintentar'}
                variant="white"
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
