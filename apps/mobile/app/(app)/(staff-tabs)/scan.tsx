import { CameraView, useCameraPermissions } from 'expo-camera';
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { BrandButton } from '@/components/BrandButton';
import { TAB_BAR_CLEARANCE } from '@/components/FloatingTabBar';
import { LoadRetryPanel } from '@/components/StudioScreenChrome';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { submitStaffQrScan } from '@/lib/api/checkInsApi';
import { getStudioSlug } from '@/lib/env';
import {
  resolveStaffScanClassDetails,
  staffScanErrorCopy,
} from '@/lib/staffScanFeedback';
import { canAccessStaffScan } from '@/lib/staffRole';
import { getColors, Space } from '@/constants/Theme';

const SCAN_FRAME_SIZE = 248;

function ScanReticle() {
  return (
    <View
      pointerEvents="none"
      style={{
        width: SCAN_FRAME_SIZE,
        height: SCAN_FRAME_SIZE,
        borderRadius: 28,
        borderWidth: 2,
        borderColor: 'rgba(255,255,255,0.82)',
        backgroundColor: 'transparent',
      }}
    />
  );
}

function PermissionState({ onEnable }: { onEnable: () => void }) {
  const C = getColors();
  const { primaryColor } = useBranding();

  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 32,
      }}
    >
      <Text
        style={{
          fontSize: 22,
          fontWeight: '800',
          letterSpacing: -0.5,
          color: C.text,
          textAlign: 'center',
          marginBottom: 10,
        }}
      >
        Camera access required
      </Text>
      <Text
        style={{
          fontSize: 15,
          color: C.textSub,
          lineHeight: 22,
          textAlign: 'center',
          marginBottom: 28,
          maxWidth: 280,
        }}
      >
        Allow camera access to scan member QR codes.
      </Text>
      <View style={{ alignSelf: 'stretch' }}>
        <BrandButton label="Enable Camera" variant="white" accentColor={primaryColor} onPress={onEnable} />
      </View>
    </View>
  );
}

function UnsupportedState({ message }: { message: string }) {
  const C = getColors();
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 32,
      }}
    >
      <Text
        style={{
          fontSize: 17,
          fontWeight: '700',
          color: C.text,
          textAlign: 'center',
          marginBottom: 8,
        }}
      >
        Scanner unavailable
      </Text>
      <Text style={{ fontSize: 14, color: C.textSub, lineHeight: 21, textAlign: 'center' }}>
        {message}
      </Text>
    </View>
  );
}

export default function StaffScanScreen() {
  const router = useRouter();
  const C = getColors();
  const { appDisplayName } = useBranding();
  const { matched, refetch } = useMemberStudio();
  const role = matched?.role;
  const studioId = matched?.studio.id;
  const timeZone = matched?.studio.timezone ?? 'UTC';
  const studioSlug = getStudioSlug();

  useFocusEffect(
    useCallback(() => {
      if (!canAccessStaffScan(role)) {
        router.replace('/(app)/(staff-tabs)/today' as Href);
      }
    }, [role, router]),
  );

  const [permission, requestPermission] = useCameraPermissions();
  const [submitting, setSubmitting] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);

  const scanLockRef = useRef(false);
  const lastTokenRef = useRef<string | null>(null);

  const resetScanState = useCallback(() => {
    scanLockRef.current = false;
    lastTokenRef.current = null;
    setSubmitting(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (!canAccessStaffScan(role)) return;
      resetScanState();
    }, [role, resetScanState]),
  );

  const handleBarcode = useCallback(
    async ({ data }: { data: string }) => {
      const qrToken = data?.trim();
      if (!qrToken || !studioId || scanLockRef.current || submitting) return;
      if (lastTokenRef.current === qrToken) return;

      scanLockRef.current = true;
      lastTokenRef.current = qrToken;
      setSubmitting(true);

      try {
        const attendance = await submitStaffQrScan(studioId, qrToken);
        const memberName = `${attendance.user.firstName} ${attendance.user.lastName}`.trim();
        const classDetails = await resolveStaffScanClassDetails(
          attendance.scheduledClassId,
          studioSlug,
          timeZone,
        );

        const successParams = new URLSearchParams({
          outcome: 'success',
          memberName,
          className: classDetails.className,
          classStartTime: classDetails.classStartTime,
          checkedInAt: attendance.checkedInAt,
          timeZone,
        });
        router.push(`/(app)/staff-scan-result?${successParams.toString()}` as Href);
      } catch (e) {
        const { title, message } = staffScanErrorCopy(e);
        const errorParams = new URLSearchParams({
          outcome: 'error',
          title,
          message,
        });
        router.push(`/(app)/staff-scan-result?${errorParams.toString()}` as Href);
      } finally {
        setSubmitting(false);
      }
    },
    [studioId, studioSlug, timeZone, submitting, router],
  );

  if (!canAccessStaffScan(role)) {
    return <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} />;
  }

  if (!studioId) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <LoadRetryPanel
          message="We could not load your studio. Check your connection and try again."
          onRetry={() => void refetch()}
        />
      </SafeAreaView>
    );
  }

  if (Platform.OS === 'web') {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['left', 'right', 'top']}>
        <UnsupportedState message={`QR scanning requires the ${appDisplayName} mobile app on iOS or Android.`} />
      </SafeAreaView>
    );
  }

  if (!permission) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['left', 'right', 'top']}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color="rgba(255,255,255,0.4)" />
        </View>
      </SafeAreaView>
    );
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['left', 'right', 'top']}>
        <PermissionState onEnable={() => void requestPermission()} />
      </SafeAreaView>
    );
  }

  const scanningEnabled = cameraReady && !submitting;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['left', 'right', 'top']}>
      <View style={{ flex: 1, paddingHorizontal: Space.screenH, paddingBottom: TAB_BAR_CLEARANCE }}>
        <Animated.View entering={FadeInDown.duration(420)} style={{ paddingTop: 20, paddingBottom: 20 }}>
          <Text
            style={{
              fontSize: 32,
              fontWeight: '800',
              letterSpacing: -1.0,
              color: C.text,
              lineHeight: 38,
            }}
          >
            Scan Member QR
          </Text>
          <Text
            style={{
              fontSize: 15,
              color: C.textSub,
              lineHeight: 22,
              marginTop: 8,
              letterSpacing: -0.1,
            }}
          >
            Point the camera at the member&apos;s check-in code.
          </Text>
        </Animated.View>

        <View
          style={{
            flex: 1,
            borderRadius: 28,
            borderWidth: 1,
            borderColor: C.separator,
            overflow: 'hidden',
            backgroundColor: '#141416',
            minHeight: 360,
          }}
        >
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onCameraReady={() => setCameraReady(true)}
            onBarcodeScanned={scanningEnabled ? handleBarcode : undefined}
          />

          <View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.38)' }]}
          />

          <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
            <ScanReticle />
          </View>

          {submitting ? (
            <View
              style={[
                StyleSheet.absoluteFill,
                {
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: 'rgba(0,0,0,0.55)',
                },
              ]}
            >
              <ActivityIndicator color="#FFFFFF" size="large" />
              <Text
                style={{
                  marginTop: 14,
                  fontSize: 15,
                  fontWeight: '600',
                  color: '#FFFFFF',
                  letterSpacing: -0.1,
                }}
              >
                Checking in…
              </Text>
            </View>
          ) : null}
        </View>

        <Text
          style={{
            marginTop: 16,
            fontSize: 13,
            color: C.textMute,
            textAlign: 'center',
            lineHeight: 19,
          }}
        >
          QR codes expire after a few minutes.
        </Text>

        <Text
          style={{
            marginTop: 10,
            fontSize: 11,
            letterSpacing: 0.8,
            color: C.textMute,
            textTransform: 'uppercase',
            textAlign: 'center',
          }}
        >
          QR validation is secured by {appDisplayName}.
        </Text>
      </View>
    </SafeAreaView>
  );
}
