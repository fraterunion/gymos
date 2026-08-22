import { Platform, Pressable, Text, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';

import { fetchAppleWalletDownloadLink, fetchGoogleWalletSaveUrl } from '@/lib/api/walletApi';
import { classifyWalletButtonError } from '@/lib/walletPassState';
import { getColors, Radius } from '@/constants/Theme';
import { logWalletEvent } from '@/lib/walletAnalytics';

type ButtonPhase = 'idle' | 'loading' | 'not_configured' | 'error';

/**
 * iOS shows only Apple Wallet; Android shows only Google Wallet — matching each platform's
 * actual capability, not equal visual noise for a provider that can't do anything there.
 * Web (dev/QA preview only, no real device) shows both so the flow stays testable.
 */
function usePlatformProviders(): { showApple: boolean; showGoogle: boolean } {
  if (Platform.OS === 'ios') return { showApple: true, showGoogle: false };
  if (Platform.OS === 'android') return { showApple: false, showGoogle: true };
  return { showApple: true, showGoogle: true };
}

function AppleWalletBadge({ studioId }: { studioId: string }) {
  const [phase, setPhase] = useState<ButtonPhase>('idle');
  const C = getColors();

  async function handlePress() {
    if (phase === 'not_configured') return;
    setPhase('loading');
    logWalletEvent('apple_wallet_add_started', { studioId });
    try {
      const { downloadUrl } = await fetchAppleWalletDownloadLink(studioId);
      // Opens an in-app Safari view; iOS content-sniffs the pkpass response and shows the
      // native "Add to Apple Wallet" sheet itself — no native module, no OTA-only limitation.
      await WebBrowser.openBrowserAsync(downloadUrl);
      // Resolves when the browser view is dismissed — iOS gives no signal for whether the
      // member actually tapped "Add" vs "Cancel" inside the system Wallet sheet; this is the
      // closest available proxy for "the flow completed," not literal confirmation.
      logWalletEvent('apple_wallet_add_completed', { studioId });
      setPhase('idle');
    } catch (e) {
      const kind = classifyWalletButtonError(e);
      setPhase(kind);
      logWalletEvent('member_pass_error', { studioId, context: 'apple_wallet_add', kind });
    }
  }

  return (
    <View style={{ marginTop: 12 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Agregar a Apple Wallet"
        accessibilityState={{ disabled: phase === 'loading' || phase === 'not_configured', busy: phase === 'loading' }}
        disabled={phase === 'loading' || phase === 'not_configured'}
        onPress={() => void handlePress()}
        style={{
          minHeight: 50,
          borderRadius: Radius.button,
          backgroundColor: phase === 'not_configured' ? C.surface2 : '#000000',
          // The badge is solid black by Apple's own brand guideline, but this app's page
          // background is also pure black (Theme.ts `bg: '#000000'`) — without a border the
          // button has zero contrast against the page and reads as nothing, not a control.
          borderWidth: 1,
          borderColor: phase === 'not_configured' ? C.separator : 'rgba(255,255,255,0.16)',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          opacity: phase === 'loading' ? 0.6 : 1,
        }}
      >
        <Text style={{ color: phase === 'not_configured' ? C.textMute : '#FFFFFF', fontSize: 16, fontWeight: '700' }}>
          {phase === 'loading' ? 'Abriendo…' : phase === 'not_configured' ? 'Apple Wallet — próximamente' : 'Agregar a Apple Wallet'}
        </Text>
      </Pressable>
      {phase === 'error' ? (
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: C.negative, fontSize: 12, marginTop: 6, textAlign: 'center' }}
        >
          No pudimos abrir Apple Wallet. Inténtalo de nuevo.
        </Text>
      ) : null}
    </View>
  );
}

function GoogleWalletBadge({ studioId }: { studioId: string }) {
  const [phase, setPhase] = useState<ButtonPhase>('idle');
  const C = getColors();

  async function handlePress() {
    if (phase === 'not_configured') return;
    setPhase('loading');
    logWalletEvent('google_wallet_add_started', { studioId });
    try {
      const { saveUrl } = await fetchGoogleWalletSaveUrl(studioId);
      await WebBrowser.openBrowserAsync(saveUrl);
      logWalletEvent('google_wallet_add_opened', { studioId });
      setPhase('idle');
    } catch (e) {
      const kind = classifyWalletButtonError(e);
      setPhase(kind);
      logWalletEvent('member_pass_error', { studioId, context: 'google_wallet_add', kind });
    }
  }

  return (
    <View style={{ marginTop: 12 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Agregar a Google Wallet"
        accessibilityState={{ disabled: phase === 'loading' || phase === 'not_configured', busy: phase === 'loading' }}
        disabled={phase === 'loading' || phase === 'not_configured'}
        onPress={() => void handlePress()}
        style={{
          minHeight: 50,
          borderRadius: Radius.button,
          backgroundColor: phase === 'not_configured' ? C.surface2 : '#FFFFFF',
          borderWidth: 1,
          borderColor: phase === 'not_configured' ? C.separator : 'rgba(0,0,0,0.12)',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          opacity: phase === 'loading' ? 0.6 : 1,
        }}
      >
        <Text style={{ color: phase === 'not_configured' ? C.textMute : '#1F1F1F', fontSize: 16, fontWeight: '700' }}>
          {phase === 'loading' ? 'Abriendo…' : phase === 'not_configured' ? 'Google Wallet — próximamente' : 'Agregar a Google Wallet'}
        </Text>
      </Pressable>
      {phase === 'error' ? (
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: C.negative, fontSize: 12, marginTop: 6, textAlign: 'center' }}
        >
          No pudimos abrir Google Wallet. Inténtalo de nuevo.
        </Text>
      ) : null}
    </View>
  );
}

export function WalletButtons({ studioId }: { studioId: string }) {
  const { showApple, showGoogle } = usePlatformProviders();
  return (
    <View>
      {showApple ? <AppleWalletBadge studioId={studioId} /> : null}
      {showGoogle ? <GoogleWalletBadge studioId={studioId} /> : null}
    </View>
  );
}
