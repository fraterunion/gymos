import type { ReactNode } from 'react';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useCallback, useEffect, useState } from 'react';
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BrandButton } from '@/components/BrandButton';
import { ScreenLoader } from '@/components/StudioScreenChrome';
import { useAuth } from '@/contexts/AuthContext';
import { useBranding } from '@/contexts/BrandingContext';
import {
  acceptWaiver,
  fetchMyWaiverStatus,
  fetchPublicWaiver,
  type PublicWaiverDto,
  type WaiverStatusDto,
} from '@/lib/api/waiverApi';
import { TimeoutError } from '@/lib/api/errors';
import { computeLoadedPhase, type GatePhase } from '@/lib/waiver/gateStateMachine';
import {
  logWaiverInvariantViolation,
  logWaiverLoadFailed,
} from '@/lib/waiver/waiverDiagnostics';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';
import { getColors, Space } from '@/constants/Theme';

export const WAIVER_CHECKBOX_LABEL =
  'He leído y acepto la Carta Responsiva de ARES TRAINING CLUB.';

export const WAIVER_ACCEPT_BUTTON = 'Aceptar y continuar';

type WaiverGateProps = {
  studioId: string;
  studioSlug: string;
  children: ReactNode;
  style?: ViewStyle;
};

/**
 * WaiverGate enforces the waiver acceptance invariant before rendering children.
 *
 * A member can only be in one of these states:
 *   LOADING      — fetching current status + document (shows spinner)
 *   PASSED       — waiver not required or already accepted (renders children)
 *   WAIVER_REQUIRED — document available, user can read and accept (form enabled)
 *   SUBMITTING   — acceptance in flight (form disabled, spinner)
 *   RECOVERABLE_ERROR — load failed or invariant violation (retry available)
 *
 * The state "required=true, accepted=false, waiver=null" is NOT representable.
 * Any API response that would produce it is classified as RECOVERABLE_ERROR.
 */
export function WaiverGate({ studioId, studioSlug, children }: WaiverGateProps) {
  const C = getColors();
  const { primaryColor } = useBranding();
  const { logout } = useAuth();

  const [phase, setPhase] = useState<GatePhase>({ tag: 'LOADING' });
  const [checked, setChecked] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPhase({ tag: 'LOADING' });
    setChecked(false);
    setSubmitError(null);
    try {
      const [waiverStatus, publicWaiver] = await Promise.all([
        fetchMyWaiverStatus(studioId),
        fetchPublicWaiver(studioSlug),
      ]);

      const next = computeLoadedPhase(waiverStatus, publicWaiver);

      if (next.tag === 'RECOVERABLE_ERROR') {
        logWaiverInvariantViolation({
          studioId,
          studioSlug,
          waiverStatusRequired: waiverStatus.required,
          waiverStatusAccepted: waiverStatus.accepted,
          publicWaiverNull: publicWaiver === null,
        });
      }

      setPhase(next);
    } catch (e) {
      const isTimeout = e instanceof TimeoutError;
      logWaiverLoadFailed({
        studioId,
        studioSlug,
        errorName: e instanceof Error ? e.name : 'UnknownError',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      setPhase({
        tag: 'RECOVERABLE_ERROR',
        message: isTimeout
          ? 'La conexión tardó demasiado. Verifica tu red e inténtalo de nuevo.'
          : userFacingApiMessage(e, 'No pudimos cargar la Carta Responsiva.'),
      });
    }
  }, [studioId, studioSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAccept = useCallback(async () => {
    if (phase.tag !== 'WAIVER_REQUIRED' || !checked) return;
    const { waiver } = phase;
    setPhase({ tag: 'SUBMITTING', waiver });
    setSubmitError(null);
    try {
      await acceptWaiver(studioId, waiver.id);
      // Re-fetch authoritative server state after acceptance.
      await load();
    } catch (e) {
      setSubmitError(userFacingApiMessage(e, 'No pudimos registrar tu aceptación.'));
      setPhase({ tag: 'WAIVER_REQUIRED', waiver });
    }
  }, [phase, checked, studioId, load]);

  // ── LOADING ──────────────────────────────────────────────────────────────
  if (phase.tag === 'LOADING') {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <ScreenLoader />
      </SafeAreaView>
    );
  }

  // ── PASSED ───────────────────────────────────────────────────────────────
  if (phase.tag === 'PASSED') {
    return <>{children}</>;
  }

  // ── RECOVERABLE ERROR ────────────────────────────────────────────────────
  if (phase.tag === 'RECOVERABLE_ERROR') {
    return (
      <SafeAreaView
        style={{ flex: 1, backgroundColor: C.bg, paddingHorizontal: Space.screenH }}
        edges={['top', 'left', 'right', 'bottom']}
      >
        <View style={{ flex: 1, justifyContent: 'center', gap: 24 }}>
          <Text
            style={{
              fontSize: 20,
              fontWeight: '700',
              color: C.text,
              textAlign: 'center',
              lineHeight: 28,
            }}
          >
            No pudimos verificar tu carta responsiva
          </Text>
          <Text
            style={{
              fontSize: 15,
              color: C.textSub,
              textAlign: 'center',
              lineHeight: 22,
            }}
          >
            {phase.message}
          </Text>
          <BrandButton
            label="Reintentar"
            accentColor={primaryColor}
            onPress={() => void load()}
          />
          <Pressable
            accessibilityRole="button"
            onPress={() => void logout()}
            style={{ alignItems: 'center', paddingVertical: 12 }}
          >
            <Text style={{ fontSize: 15, color: C.textSub }}>Cerrar sesión</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  // ── WAIVER_REQUIRED or SUBMITTING ─────────────────────────────────────────
  const isSubmitting = phase.tag === 'SUBMITTING';
  const waiver = phase.waiver;

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: C.bg }}
      edges={['top', 'left', 'right', 'bottom']}
    >
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: Space.screenH,
          paddingTop: 24,
          paddingBottom: 40,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <Text
          style={{
            fontSize: 34,
            fontWeight: '800',
            letterSpacing: -1.1,
            color: C.text,
            marginBottom: 10,
          }}
        >
          Carta Responsiva
        </Text>
        <Text
          style={{
            fontSize: 15,
            color: C.textSub,
            lineHeight: 22,
            marginBottom: 24,
          }}
        >
          Para continuar, lee y acepta la carta responsiva de ARES Training Club.
        </Text>

        <View
          style={{
            backgroundColor: '#141416',
            borderRadius: 24,
            borderWidth: 1,
            borderColor: C.separator,
            padding: 20,
            maxHeight: 360,
            marginBottom: 20,
          }}
        >
          <ScrollView nestedScrollEnabled showsVerticalScrollIndicator>
            <Text
              style={{
                fontSize: 14,
                color: C.text,
                lineHeight: 22,
              }}
            >
              {waiver.bodyMarkdown}
            </Text>
          </ScrollView>
        </View>

        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked }}
          disabled={isSubmitting}
          onPress={() => setChecked((v) => !v)}
          style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 12,
            marginBottom: 20,
            opacity: isSubmitting ? 0.5 : 1,
          }}
        >
          <View
            style={{
              width: 24,
              height: 24,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: checked ? primaryColor : C.separator,
              backgroundColor: checked ? primaryColor : 'transparent',
              alignItems: 'center',
              justifyContent: 'center',
              marginTop: 2,
            }}
          >
            {checked ? <FontAwesome name="check" size={14} color="#FFFFFF" /> : null}
          </View>
          <Text style={{ flex: 1, fontSize: 14, color: C.text, lineHeight: 20 }}>
            {WAIVER_CHECKBOX_LABEL}
          </Text>
        </Pressable>

        {submitError ? (
          <Text
            style={{ fontSize: 14, color: C.negative, marginBottom: 16, lineHeight: 20 }}
          >
            {submitError}
          </Text>
        ) : null}

        <BrandButton
          label={isSubmitting ? 'Registrando…' : WAIVER_ACCEPT_BUTTON}
          accentColor={primaryColor}
          loading={isSubmitting}
          disabled={!checked || isSubmitting}
          onPress={() => void handleAccept()}
        />

        <Pressable
          accessibilityRole="button"
          onPress={() => void logout()}
          style={{ marginTop: 16, alignItems: 'center', paddingVertical: 12 }}
        >
          <Text style={{ fontSize: 15, color: C.textSub }}>Cerrar sesión</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── WaiverRegisterSection ──────────────────────────────────────────────────

type WaiverRegisterSectionProps = {
  waiver: PublicWaiverDto | null;
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
  loading?: boolean;
};

export function WaiverRegisterSection({
  waiver,
  checked,
  onCheckedChange,
  loading,
}: WaiverRegisterSectionProps) {
  const C = getColors();
  const { primaryColor } = useBranding();

  if (loading) {
    return (
      <View style={{ marginBottom: 20 }}>
        <Text style={{ fontSize: 13, color: C.textMute }}>Cargando Carta Responsiva…</Text>
      </View>
    );
  }

  if (!waiver) return null;

  return (
    <View style={{ marginBottom: 8 }}>
      <Text
        style={{
          fontSize: 11,
          fontWeight: '700',
          letterSpacing: 0.6,
          textTransform: 'uppercase',
          color: C.textMute,
          marginBottom: 10,
        }}
      >
        Carta Responsiva
      </Text>
      <View
        style={{
          backgroundColor: '#1A1A1C',
          borderRadius: 16,
          borderWidth: 1,
          borderColor: C.separator,
          padding: 16,
          maxHeight: 220,
          marginBottom: 14,
        }}
      >
        <ScrollView nestedScrollEnabled showsVerticalScrollIndicator>
          <Text style={{ fontSize: 13, color: C.textSub, lineHeight: 20 }}>
            {waiver.bodyMarkdown}
          </Text>
        </ScrollView>
      </View>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
        onPress={() => onCheckedChange(!checked)}
        style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}
      >
        <View
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            borderWidth: 1,
            borderColor: checked ? primaryColor : C.separator,
            backgroundColor: checked ? primaryColor : 'transparent',
            alignItems: 'center',
            justifyContent: 'center',
            marginTop: 2,
          }}
        >
          {checked ? <FontAwesome name="check" size={14} color="#FFFFFF" /> : null}
        </View>
        <Text style={{ flex: 1, fontSize: 13, color: C.text, lineHeight: 20 }}>
          {WAIVER_CHECKBOX_LABEL}
        </Text>
      </Pressable>
    </View>
  );
}

export function formatWaiverMethod(method: WaiverStatusDto['method']): string {
  if (method === 'STAFF_ATTESTED') return 'Firmada presencialmente';
  if (method === 'SELF') return 'Aceptada en la app';
  return '—';
}
