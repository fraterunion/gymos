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

export function WaiverGate({ studioId, studioSlug, children }: WaiverGateProps) {
  const C = getColors();
  const { primaryColor } = useBranding();
  const { logout } = useAuth();
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<WaiverStatusDto | null>(null);
  const [waiver, setWaiver] = useState<PublicWaiverDto | null>(null);
  const [checked, setChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [waiverStatus, publicWaiver] = await Promise.all([
        fetchMyWaiverStatus(studioId),
        fetchPublicWaiver(studioSlug),
      ]);
      setStatus(waiverStatus);
      setWaiver(publicWaiver);
    } catch (e) {
      setError(userFacingApiMessage(e, 'No pudimos cargar la Carta Responsiva.'));
    } finally {
      setLoading(false);
    }
  }, [studioId, studioSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAccept = async () => {
    if (!waiver || !checked) return;
    setSubmitting(true);
    setError(null);
    try {
      await acceptWaiver(studioId, waiver.id);
      await load();
    } catch (e) {
      setError(userFacingApiMessage(e, 'No pudimos registrar tu aceptación.'));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <ScreenLoader />
      </SafeAreaView>
    );
  }

  if (!status?.required || status.accepted) {
    return <>{children}</>;
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['top', 'left', 'right', 'bottom']}>
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
              {waiver?.bodyMarkdown ?? 'No hay una Carta Responsiva activa disponible.'}
            </Text>
          </ScrollView>
        </View>

        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked }}
          onPress={() => setChecked((v) => !v)}
          style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 12,
            marginBottom: 20,
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

        {error ? (
          <Text style={{ fontSize: 14, color: C.negative, marginBottom: 16, lineHeight: 20 }}>
            {error}
          </Text>
        ) : null}

        <BrandButton
          label={WAIVER_ACCEPT_BUTTON}
          accentColor={primaryColor}
          loading={submitting}
          disabled={!checked || !waiver}
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
