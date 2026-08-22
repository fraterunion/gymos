import { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';
import QRCode from 'react-native-qrcode-svg';

import { BrandButton } from '@/components/BrandButton';
import { LoadRetryPanel, Skeleton } from '@/components/StudioScreenChrome';
import { WalletButtons } from '@/components/WalletButtons';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { fetchMyMemberProfile, type MyMemberProfileDto } from '@/lib/api/membershipApi';
import { fetchWalletBarcode, fetchWalletReissue } from '@/lib/api/walletApi';
import { getCachedBarcode, setCachedBarcode } from '@/lib/walletCredentialStore';
import { deriveMiPaseState } from '@/lib/walletPassState';
import { logWalletEvent } from '@/lib/walletAnalytics';
import { getColors, Radius, Space } from '@/constants/Theme';

const QR_SIZE = 220;

export default function MiPaseScreen() {
  const C = getColors();
  const { appDisplayName, primaryColor } = useBranding();
  const { matched } = useMemberStudio();
  const studioId = matched?.studio.id ?? '';

  const [profile, setProfile] = useState<MyMemberProfileDto | null>(null);
  const [cachedBarcode, setCachedBarcodeState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<unknown>(null);
  const [barcodeUnavailable, setBarcodeUnavailable] = useState(false);
  const [resetting, setResetting] = useState(false);

  const load = useCallback(async () => {
    if (!studioId) return;
    setLoading(true);
    setFetchError(null);
    setBarcodeUnavailable(false);
    try {
      const profileRes = await fetchMyMemberProfile(studioId);
      setProfile(profileRes);

      const userId = profileRes.user.id;
      const alreadyCached = await getCachedBarcode(studioId, userId);
      if (alreadyCached) {
        // Never re-fetch once cached locally — reopening Mi Pase must not touch the backend
        // for identity again, only for the member-context fields (name/plan) above.
        setCachedBarcodeState(alreadyCached);
      } else {
        const barcodeRes = await fetchWalletBarcode(studioId);
        if (barcodeRes.barcode) {
          await setCachedBarcode(studioId, userId, barcodeRes.barcode);
          setCachedBarcodeState(barcodeRes.barcode);
        } else {
          // A credential already exists but this device/session never received its raw
          // value and has no local cache — same "needs help at reception" outcome as an
          // explicit reissue, not a transient failure to retry.
          setBarcodeUnavailable(true);
        }
      }
      logWalletEvent('member_pass_viewed', { studioId });
    } catch (e) {
      setFetchError(e);
    } finally {
      setLoading(false);
    }
  }, [studioId]);

  useEffect(() => {
    void load();
  }, [load]);

  const performReset = useCallback(async () => {
    if (!studioId || !profile) return;
    setResetting(true);
    logWalletEvent('member_pass_reset_confirmed', { studioId });
    try {
      const result = await fetchWalletReissue(studioId);
      await setCachedBarcode(studioId, profile.user.id, result.barcode);
      setCachedBarcodeState(result.barcode);
      setBarcodeUnavailable(false);
      setFetchError(null);
      logWalletEvent('member_pass_reset_succeeded', { studioId });
    } catch {
      logWalletEvent('member_pass_reset_failed', { studioId });
      Alert.alert('No se pudo actualizar tu pase', 'Inténtalo de nuevo en un momento.');
    } finally {
      setResetting(false);
    }
  }, [studioId, profile]);

  const handleResetPass = useCallback(() => {
    Alert.alert(
      'Actualizar pase',
      'Esto invalidará tu código anterior. Si agregaste tu pase a Wallet, tendrás que volver a agregarlo.',
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Actualizar pase', style: 'destructive', onPress: () => void performReset() },
      ],
    );
  }, [performReset]);

  if (!studioId) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Skeleton width={280} height={360} radius={Radius.card} />
        </View>
      </SafeAreaView>
    );
  }

  const state = deriveMiPaseState({ loading, cachedBarcode, fetchError, barcodeUnavailable });

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['top', 'left', 'right', 'bottom']}>
      <ScrollView
        contentContainerStyle={{ flexGrow: 1, paddingHorizontal: Space.screenH, paddingTop: 24, paddingBottom: 48 }}
      >
        <Text
          style={{ fontSize: 32, fontWeight: '800', letterSpacing: -1, color: C.text, marginBottom: 24 }}
          accessibilityRole="header"
        >
          Mi Pase
        </Text>

        {state.kind === 'loading' ? (
          <Animated.View entering={FadeInDown.duration(250)}>
            <Skeleton width="100%" height={420} radius={Radius.card} />
          </Animated.View>
        ) : state.kind === 'not_eligible' ? (
          <LoadRetryPanel
            message="Tu cuenta no tiene una membresía activa en este estudio. Contacta a recepción si crees que esto es un error."
            onRetry={() => void load()}
          />
        ) : state.kind === 'reissue_required' ? (
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
            <Text style={{ fontSize: 20, fontWeight: '700', color: C.text, textAlign: 'center', marginBottom: 8 }}>
              Tu pase necesita actualizarse
            </Text>
            <Text style={{ fontSize: 14, color: C.textSub, textAlign: 'center', lineHeight: 21, marginBottom: 20 }}>
              No pudimos recuperar tu pase automáticamente.
            </Text>
            <View style={{ alignSelf: 'stretch' }}>
              <BrandButton
                label="Actualizar pase"
                variant="white"
                accentColor={primaryColor}
                loading={resetting}
                onPress={handleResetPass}
              />
            </View>
          </View>
        ) : state.kind === 'network_error' ? (
          <LoadRetryPanel message={state.message} onRetry={() => void load()} />
        ) : (
          <MiPaseCard
            appDisplayName={appDisplayName}
            primaryColor={primaryColor}
            memberName={memberDisplayName(profile)}
            planName={profile?.activeSubscription?.plan.name ?? null}
            barcode={state.barcode}
            studioId={studioId}
          />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function memberDisplayName(profile: MyMemberProfileDto | null): string {
  if (!profile) return '';
  return `${profile.user.firstName} ${profile.user.lastName}`.trim();
}

function MiPaseCard({
  appDisplayName,
  primaryColor,
  memberName,
  planName,
  barcode,
  studioId,
}: {
  appDisplayName: string;
  primaryColor: string;
  memberName: string;
  planName: string | null;
  barcode: string;
  studioId: string;
}) {
  const C = getColors();
  return (
    <Animated.View entering={FadeInDown.duration(300)}>
      <View
        style={{
          backgroundColor: '#0A0A0A',
          borderRadius: Radius.card,
          borderWidth: 1,
          borderColor: C.separator,
          overflow: 'hidden',
        }}
      >
        <View style={{ height: 3, backgroundColor: primaryColor }} />
        <View style={{ padding: 28, alignItems: 'center' }}>
          <Text
            style={{
              fontSize: 12,
              fontWeight: '700',
              letterSpacing: 1.2,
              textTransform: 'uppercase',
              color: 'rgba(255,255,255,0.5)',
              marginBottom: 6,
            }}
          >
            {appDisplayName}
          </Text>
          <Text style={{ fontSize: 22, fontWeight: '800', color: '#FFFFFF', marginBottom: 2, textAlign: 'center' }}>
            {memberName || 'Miembro'}
          </Text>
          {planName ? (
            <Text style={{ fontSize: 14, color: 'rgba(255,255,255,0.6)', marginBottom: 20 }}>{planName}</Text>
          ) : (
            <View style={{ marginBottom: 20 }} />
          )}

          {/* The QR is functional infrastructure, not a design surface: plain black-on-white,
              no gradients/branding overlaid on it, generous quiet-zone padding, sized well
              above typical scanner minimums so it reads reliably from another device. */}
          <View
            style={{ backgroundColor: '#FFFFFF', padding: 16, borderRadius: 12 }}
            accessible
            accessibilityLabel="Código QR de tu pase de miembro"
            accessibilityRole="image"
          >
            <QRCode value={barcode} size={QR_SIZE} color="#0A0A0A" backgroundColor="#FFFFFF" />
          </View>

          <Text style={{ marginTop: 20, fontSize: 13, fontWeight: '600', color: 'rgba(255,255,255,0.7)' }}>
            Pase de miembro
          </Text>
          <Text
            style={{
              marginTop: 8,
              fontSize: 12,
              color: 'rgba(255,255,255,0.45)',
              textAlign: 'center',
              lineHeight: 17,
              maxWidth: 260,
            }}
          >
            El acceso se confirma en recepción.
          </Text>
        </View>
      </View>

      <View style={{ marginTop: 24 }}>
        <WalletButtons studioId={studioId} />
      </View>
    </Animated.View>
  );
}
