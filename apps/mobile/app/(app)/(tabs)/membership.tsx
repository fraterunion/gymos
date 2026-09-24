import { initStripe, useStripe } from '@/lib/stripe';
import { createURL } from 'expo-linking';
import { useFocusEffect, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  Linking,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { AuthRequiredModal } from '@/components/AuthRequiredModal';
import { BrandButton } from '@/components/BrandButton';
import { ImageSlot } from '@/components/ImageSlot';
import { LoadRetryPanel, ScreenLoader, Skeleton } from '@/components/StudioScreenChrome';
import { useAuth } from '@/contexts/AuthContext';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { usePublicStudio } from '@/contexts/PublicStudioContext';
import { useStudioActivity } from '@/contexts/StudioActivityContext';
import {
  fetchPublicMembershipPlans,
  type PublicMembershipPlanDto,
} from '@/lib/api/publicDiscoveryApi';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';
import {
  createBillingPortalSession,
  createMembershipCheckoutSession,
  type MembershipPurchaseResponse,
  fetchCheckoutPreview,
  fetchMembershipPlans,
  fetchMyMemberProfile,
  fetchPurchaseOptions,
  type BillingInterval,
  type CheckoutPreviewDto,
  type MembershipPlanDto,
  type MyMemberProfileDto,
  type PurchaseOptionDto,
} from '@/lib/api/membershipApi';
import { MembershipList } from '@/components/membership/MembershipCards';
import {
  addConfirmationCopy,
  blockedReasonCopy,
  changeConfirmationCopy,
  isPurchaseActionDisabled,
  purchaseCtaLabel,
  type PurchaseActionLike,
} from '@/lib/membershipDisplay';
import {
  createDayPassPaymentSheet,
  fetchDayPassCatalog,
  fetchDayPassPurchaseWindow,
  fetchMyDayPasses,
  fetchPublicDayPassCatalog,
  syncDayPass,
  type DayPassCatalogDto,
  type DayPassDto,
  type DayPassPurchaseWindowDto,
  type DayPassStatus,
} from '@/lib/api/dayPassesApi';
import { DayPassDateSheet } from '@/components/membership/DayPassDateSheet';
import {
  DAY_PASS_DATE_COPY,
  activatedCopy,
  confirmingCopy,
  fallbackPurchaseWindow,
  formatPassHeading,
  groupMyDayPasses,
  ownedDateLine,
  relativeDayLabel,
  relativeLabelForPass,
} from '@/lib/dayPassDates';
import { ApiError } from '@/lib/api/errors';
import { todayKeyInZone } from '@/lib/datetime';
import {
  DAY_PASS_COPY,
  canStartDayPassPurchase,
  describePostPaymentStatus,
  isAlreadyOwnedConflict,
  resolvePaymentSheetOutcome,
} from '@/lib/dayPassPurchase';
import { formatMoneyFromCents } from '@/lib/formatMoney';
import { resolveAresPlanBenefits, resolveAresPricePerClassLabel } from '@/lib/aresMembershipPlans';
import { FitnessImages } from '@/lib/imagery';
import { statusConfig } from '@/lib/membershipStatus';
import { getStudioSlug } from '@/lib/env';
import { TAB_BAR_CLEARANCE } from '@/components/FloatingTabBar';
import { getColors, Space, type ThemeColors } from '@/constants/Theme';

type AuthModalKind = 'membership' | 'day-pass';

const CARD_BG = '#141416';

function premiumCardStyle(C: ThemeColors) {
  return {
    backgroundColor: CARD_BG,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: C.separator,
  } as const;
}

function SectionLabel({ children }: { children: string }) {
  const C = getColors();
  return (
    <Text
      style={{
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 1.2,
        textTransform: 'uppercase',
        color: C.textMute,
        marginBottom: 16,
      }}
    >
      {children}
    </Text>
  );
}

function InlineAuthLink({
  prompt,
  action,
  onPress,
}: {
  prompt: string;
  action: string;
  onPress: () => void;
}) {
  const C = getColors();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      hitSlop={8}
      style={{ marginTop: 16, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6 }}
    >
      <Text style={{ fontSize: 14, color: C.textMute }}>{prompt}</Text>
      <Text style={{ fontSize: 14, fontWeight: '600', color: C.text }}>{action}</Text>
    </Pressable>
  );
}

const MEMBERSHIP_RETURN_TO = '/(app)/(tabs)/membership' as const;

const AUTH_MODAL_COPY: Record<AuthModalKind, { title: string; description: string }> = {
  membership: {
    title: 'Únete para elegir tu plan',
    description: 'Únete para elegir tu plan y reservar clases.',
  },
  'day-pass': {
    title: 'Regístrate y compra tu pase diario',
    description: 'Compra un pase diario para reservar clases el día que elijas.',
  },
};

function toMembershipPlanDto(plan: PublicMembershipPlanDto): MembershipPlanDto {
  return { ...plan, studioId: '' };
}

function billingIntervalLabel(interval: BillingInterval): string {
  switch (interval) {
    case 'MONTHLY': return '/mes';
    case 'YEARLY':  return '/año';
    case 'WEEKLY':  return '/sem';
    default:        return '';
  }
}

function creditsLabel(credits: number | null): string | null {
  if (credits === null) return 'Visitas ilimitadas a clases';
  if (credits <= 0) return null;
  return `${credits} visitas al mes`;
}

function membershipCreditDisplay(
  classCredits: number | null,
  creditsUsed: number | null,
  creditsRemaining: number | null,
): { primary: string; secondary?: string } {
  if (classCredits === null) {
    return { primary: 'Clases ilimitadas' };
  }
  if (typeof creditsUsed === 'number' && typeof creditsRemaining === 'number') {
    return {
      primary: `${creditsUsed} / ${classCredits} clases usadas`,
      secondary: `${creditsRemaining} restantes en este periodo`,
    };
  }
  return { primary: `${classCredits} clases por periodo` };
}

// ---------------------------------------------------------------------------
// Active membership — physical luxury card
// ---------------------------------------------------------------------------

function MembershipCard({
  planName,
  status,
  cancelAtPeriodEnd,
  renewsAt,
  currentPeriodEnd,
  classCredits,
  creditsUsed,
  creditsRemaining,
  primaryColor,
  onManage,
  portalBusy,
}: {
  planName: string;
  status: string;
  cancelAtPeriodEnd: boolean;
  renewsAt: string;
  currentPeriodEnd: string | null;
  classCredits: number | null;
  creditsUsed: number | null;
  creditsRemaining: number | null;
  primaryColor: string;
  onManage: () => void;
  portalBusy: boolean;
}) {
  const C = getColors();
  const cfg = statusConfig(status, cancelAtPeriodEnd, currentPeriodEnd);
  const accentBarColor = (status === 'ACTIVE' || status === 'TRIALING') ? primaryColor : C.surface3;
  const creditDisplay = membershipCreditDisplay(classCredits, creditsUsed, creditsRemaining);

  const showCreditProgress =
    classCredits !== null &&
    typeof creditsUsed === 'number' &&
    classCredits > 0;
  const creditProgress = showCreditProgress
    ? Math.min(creditsUsed! / classCredits!, 1)
    : 0;

  return (
    <Animated.View entering={FadeInDown.duration(450)}>
      <View
        style={{
          ...premiumCardStyle(C),
          overflow: 'hidden',
          marginBottom: 8,
        }}
      >
        <View style={{ height: 3, backgroundColor: accentBarColor }} />

        <View style={{ padding: 28 }}>
          {/* Status pill */}
          <View
            style={{
              alignSelf: 'flex-start',
              flexDirection: 'row',
              alignItems: 'center',
              backgroundColor: cfg.bg,
              borderRadius: 100,
              paddingVertical: 5,
              paddingHorizontal: 10,
              marginBottom: 24,
            }}
          >
            <View
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: cfg.dotColor,
                marginRight: 6,
              }}
            />
            <Text
              style={{
                fontSize: 11,
                fontWeight: '700',
                letterSpacing: 0.6,
                textTransform: 'uppercase',
                color: cfg.textColor,
              }}
            >
              {cfg.label}
            </Text>
          </View>

          {/* Plan name — the hero */}
          <Text
            style={{
              fontSize: 34,
              fontWeight: '800',
              letterSpacing: -1.0,
              color: C.text,
              lineHeight: 38,
              marginBottom: 12,
            }}
          >
            {planName}
          </Text>

          {/* Renewal info */}
          <Text style={{ fontSize: 14, color: C.textMute, lineHeight: 20 }}>
            {renewsAt}
          </Text>

          <View
            style={{
              marginTop: 18,
              paddingVertical: 14,
              paddingHorizontal: 16,
              backgroundColor: 'rgba(255,255,255,0.04)',
              borderRadius: 14,
              borderWidth: 1,
              borderColor: C.separator,
            }}
          >
            <Text
              style={{
                fontSize: 11,
                fontWeight: '700',
                letterSpacing: 0.8,
                textTransform: 'uppercase',
                color: C.textMute,
                marginBottom: 8,
              }}
            >
              Créditos de clases
            </Text>
            <Text
              style={{
                fontSize: 15,
                fontWeight: '600',
                color: C.text,
                letterSpacing: -0.2,
              }}
            >
              {creditDisplay.primary}
            </Text>
            {creditDisplay.secondary ? (
              <Text
                style={{
                  fontSize: 13,
                  color: C.textSub,
                  marginTop: 4,
                  letterSpacing: -0.05,
                }}
              >
                {creditDisplay.secondary}
              </Text>
            ) : null}
            {showCreditProgress ? (
              <View
                style={{
                  marginTop: 12,
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: 'rgba(255,255,255,0.08)',
                  overflow: 'hidden',
                }}
              >
                <View
                  style={{
                    height: '100%',
                    width: `${creditProgress * 100}%`,
                    backgroundColor: primaryColor,
                    borderRadius: 2,
                  }}
                />
              </View>
            ) : null}
          </View>

          {/* Divider */}
          <View style={{ height: 1, backgroundColor: C.separator, marginVertical: 24 }} />

          {/* Manage billing */}
          <Pressable
            accessibilityRole="button"
            onPress={onManage}
            disabled={portalBusy}
            hitSlop={8}
          >
            <Text
              style={{
                fontSize: 15,
                fontWeight: '600',
                color: portalBusy ? C.textMute : C.text,
                letterSpacing: -0.2,
              }}
            >
              {portalBusy ? 'Abriendo…' : 'Gestionar membresía →'}
            </Text>
          </Pressable>
        </View>
      </View>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Plan card — cinematic hero with per-plan theme
// ---------------------------------------------------------------------------

const PLAN_HERO_HEIGHT = 188;

type PlanHeroTheme = {
  accentColor: string;
  borderColor: string;
  badge: string | null;
  imageUri: string;
  tagline: string;
};

const PLAN_THEME_DEFAULTS: PlanHeroTheme[] = [
  {
    accentColor: '#F59E0B',
    borderColor: 'rgba(245,158,11,0.35)',
    badge: 'MÁS POPULAR',
    imageUri: FitnessImages.strength,
    tagline: 'Entrena sin límites.',
  },
  {
    accentColor: '#14B8A6',
    borderColor: 'rgba(20,184,166,0.35)',
    badge: 'PARA EMPEZAR',
    imageUri: FitnessImages.hiit,
    tagline: 'Construye tu base.',
  },
  {
    accentColor: '#8B5CF6',
    borderColor: 'rgba(139,92,246,0.35)',
    badge: 'PARA COMPETIDORES',
    imageUri: FitnessImages.running,
    tagline: 'Hecho para competir.',
  },
];

function resolvePlanTheme(planName: string, index: number): PlanHeroTheme {
  const lower = planName.toLowerCase();
  if (lower.includes('hyrox')) {
    return PLAN_THEME_DEFAULTS[2]!;
  }
  if (lower.includes('full') || lower.includes('unlimited') || lower.includes('all access')) {
    return PLAN_THEME_DEFAULTS[0]!;
  }
  if (lower.includes('basic') || lower.includes('starter') || lower.includes('intro') || lower.includes('essential')) {
    return PLAN_THEME_DEFAULTS[1]!;
  }
  return PLAN_THEME_DEFAULTS[index % PLAN_THEME_DEFAULTS.length]!;
}

function PlanBenefitRow({ text }: { text: string }) {
  const C = getColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
      <View
        style={{
          width: 20,
          height: 20,
          borderRadius: 10,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'rgba(255,255,255,0.08)',
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.12)',
          marginTop: 1,
        }}
      >
        <Text style={{ fontSize: 11, fontWeight: '700', color: C.text }}>✓</Text>
      </View>
      <Text
        style={{
          flex: 1,
          fontSize: 14,
          lineHeight: 21,
          color: C.textSub,
          letterSpacing: -0.1,
        }}
      >
        {text}
      </Text>
    </View>
  );
}

function PlanCard({
  plan,
  onSubscribe,
  isLoading,
  isDisabled,
  primaryColor,
  index,
  subscribeLabel = 'Suscribirme',
}: {
  plan: MembershipPlanDto;
  onSubscribe: () => void;
  isLoading: boolean;
  isDisabled: boolean;
  primaryColor: string;
  index: number;
  subscribeLabel?: string;
}) {
  const C = getColors();
  const theme = resolvePlanTheme(plan.name, index);
  const priceStr = formatMoneyFromCents(plan.priceCents, plan.currency);
  const intervalStr = billingIntervalLabel(plan.billingInterval);
  const credits = creditsLabel(plan.classCredits);
  const benefits = resolveAresPlanBenefits(plan.name);
  const pricePerClass = resolveAresPricePerClassLabel(plan);

  return (
    <Animated.View
      entering={FadeInDown.delay(index * 80).duration(420)}
      style={{ marginBottom: Space.cardGap }}
    >
      <View
        style={{
          backgroundColor: CARD_BG,
          borderRadius: 28,
          borderWidth: 1,
          borderColor: theme.borderColor,
          overflow: 'hidden',
        }}
      >
        {/* ── Hero image ── */}
        <View style={{ height: PLAN_HERO_HEIGHT }}>
          <ImageSlot
            uri={theme.imageUri}
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
          />
          {/* Layered gradient simulation — no expo-linear-gradient required */}
          <View
            pointerEvents="none"
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.20)' }}
          />
          <View
            pointerEvents="none"
            style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '60%', backgroundColor: 'rgba(0,0,0,0.52)' }}
          />
          <View
            pointerEvents="none"
            style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '30%', backgroundColor: 'rgba(0,0,0,0.36)' }}
          />

          {/* Badge */}
          {theme.badge ? (
            <View
              style={{
                position: 'absolute',
                top: 16,
                right: 16,
                backgroundColor: theme.accentColor,
                borderRadius: 100,
                paddingVertical: 5,
                paddingHorizontal: 11,
              }}
            >
              <Text
                style={{
                  fontSize: 9,
                  fontWeight: '800',
                  letterSpacing: 1.0,
                  textTransform: 'uppercase',
                  color: '#0A0A0A',
                }}
              >
                {theme.badge}
              </Text>
            </View>
          ) : null}
        </View>

        {/* Accent bar */}
        <View style={{ height: 2, backgroundColor: theme.accentColor }} />

        {/* ── Content ── */}
        <View style={{ padding: 24 }}>
          {/* Plan name + tagline */}
          <Text
            style={{
              fontSize: 26,
              fontWeight: '800',
              letterSpacing: -0.8,
              color: C.text,
              textTransform: 'uppercase',
              lineHeight: 30,
              marginBottom: 6,
            }}
          >
            {plan.name}
          </Text>
          <Text
            style={{
              fontSize: 14,
              color: C.textSub,
              letterSpacing: -0.1,
              marginBottom: 20,
            }}
          >
            {theme.tagline}
          </Text>

          {/* Price */}
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', marginBottom: 16 }}>
            <Text
              style={{
                fontSize: 48,
                fontWeight: '800',
                letterSpacing: -2,
                color: C.text,
                lineHeight: 52,
              }}
            >
              {priceStr}
            </Text>
            <Text
              style={{
                fontSize: 16,
                color: C.textMute,
                marginBottom: 8,
                marginLeft: 5,
                letterSpacing: -0.2,
              }}
            >
              {intervalStr}
            </Text>
          </View>

          {pricePerClass ? (
            <Text
              style={{
                fontSize: 17,
                fontWeight: '700',
                color: theme.accentColor,
                letterSpacing: -0.3,
                marginBottom: 18,
              }}
            >
              {pricePerClass}
            </Text>
          ) : null}

          {benefits.length > 0 ? (
            <View style={{ marginBottom: credits ? 14 : 22 }}>
              {benefits.map((benefit) => (
                <PlanBenefitRow key={benefit} text={benefit} />
              ))}
            </View>
          ) : plan.description ? (
            <Text
              style={{
                fontSize: 14,
                lineHeight: 22,
                color: C.textSub,
                marginBottom: 14,
                letterSpacing: -0.1,
              }}
            >
              {plan.description}
            </Text>
          ) : null}

          {credits ? (
            <View
              style={{
                alignSelf: 'flex-start',
                backgroundColor: 'rgba(255,255,255,0.05)',
                borderRadius: 8,
                paddingVertical: 6,
                paddingHorizontal: 10,
                marginBottom: 22,
                borderWidth: 1,
                borderColor: C.separator,
              }}
            >
              <Text style={{ fontSize: 12, color: C.textSub, letterSpacing: -0.05 }}>{credits}</Text>
            </View>
          ) : (
            <View style={{ marginBottom: 22 }} />
          )}

          <BrandButton
            label={subscribeLabel}
            variant="white"
            accentColor={primaryColor}
            loading={isLoading}
            disabled={isDisabled}
            onPress={onSubscribe}
          />
        </View>
      </View>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Guest value proposition
// ---------------------------------------------------------------------------

function GuestMembershipPrompt({
  studioName,
  primaryColor,
  onRegister,
  onLogin,
}: {
  studioName: string;
  primaryColor: string;
  onRegister: () => void;
  onLogin: () => void;
}) {
  const C = getColors();
  return (
    <Animated.View entering={FadeInDown.duration(400)}>
      <View style={{ ...premiumCardStyle(C), padding: 28, marginBottom: 8 }}>
        <Text
          style={{
            fontSize: 26,
            fontWeight: '800',
            letterSpacing: -0.6,
            color: C.text,
            marginBottom: 10,
            lineHeight: 32,
          }}
        >
          Entrena con nosotros.
        </Text>
        <Text
          style={{
            fontSize: 15,
            color: C.textSub,
            lineHeight: 22,
            marginBottom: 20,
          }}
        >
          {studioName
            ? `Explora los planes en ${studioName}, compra un pase diario o únete con una membresía.`
            : 'Explora los planes, compra un pase diario o únete con una membresía.'}
        </Text>
        <Text
          style={{
            fontSize: 14,
            color: C.textMute,
            lineHeight: 21,
            marginBottom: 24,
          }}
        >
          Crea una cuenta para suscribirte, comprar un pase diario y reservar clases.
        </Text>
        <BrandButton label="Únete ahora" variant="white" accentColor={primaryColor} onPress={onRegister} />
        <InlineAuthLink
          prompt="¿Ya tienes cuenta?"
          action="Iniciar sesión"
          onPress={onLogin}
        />
      </View>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// No-membership prompt
// ---------------------------------------------------------------------------

function NoMembershipPrompt({
  onManage,
  portalBusy,
}: {
  primaryColor: string;
  onManage: () => void;
  portalBusy: boolean;
}) {
  const C = getColors();
  return (
    <Animated.View entering={FadeInDown.duration(400)}>
      <View
        style={{
          ...premiumCardStyle(C),
          padding: 32,
          marginBottom: 8,
          alignItems: 'center',
        }}
      >
        <View
          style={{
            width: 48,
            height: 48,
            borderRadius: 24,
            backgroundColor: 'rgba(255,255,255,0.06)',
            borderWidth: 1,
            borderColor: C.separator,
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 18,
          }}
        >
          <Text style={{ fontSize: 20, color: C.textMute }}>◇</Text>
        </View>
        <Text
          style={{
            fontSize: 24,
            fontWeight: '800',
            letterSpacing: -0.5,
            color: C.text,
            textAlign: 'center',
            marginBottom: 10,
          }}
        >
          Comienza tu camino de entrenamiento.
        </Text>
        <Text
          style={{
            fontSize: 15,
            color: C.textSub,
            lineHeight: 22,
            textAlign: 'center',
            maxWidth: 240,
            marginBottom: 24,
          }}
        >
          Elige un plan de membresía para reservar clases y hacer check-in en el gimnasio.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={onManage}
          disabled={portalBusy}
          hitSlop={8}
        >
          <Text style={{ fontSize: 15, fontWeight: '600', color: portalBusy ? C.textMute : C.text }}>
            {portalBusy ? 'Abriendo…' : 'Gestionar membresía →'}
          </Text>
        </Pressable>
      </View>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Day Pass row — one purchased day. The pass's day comes from the server key; the pill says
// whether that day is today, scheduled ahead, or already used.
// ---------------------------------------------------------------------------

function dayPassRowConfig(relative: ReturnType<typeof relativeDayLabel>): {
  label: string;
  eyebrow: string;
  dotColor: string;
  bg: string;
  textColor: string;
} {
  const C = getColors();
  switch (relative) {
    case 'Hoy':
      return { label: 'Activo hoy', eyebrow: 'Hoy', dotColor: C.positive, bg: 'rgba(52,211,153,0.12)', textColor: C.positive };
    case 'Mañana':
    case 'Próximo':
      return { label: 'Programado', eyebrow: 'Próximo', dotColor: '#FFFFFF', bg: 'rgba(255,255,255,0.08)', textColor: C.text };
    case 'Anterior':
      return { label: 'Usado', eyebrow: 'Anterior', dotColor: C.textMute, bg: 'rgba(255,255,255,0.06)', textColor: C.textMute };
  }
}

function DayPassRow({
  dayPass,
  todayKey,
  timeZone,
  isLast = false,
}: {
  dayPass: DayPassDto;
  todayKey: string;
  timeZone: string;
  isLast?: boolean;
}) {
  const C = getColors();
  const relative = relativeLabelForPass(dayPass, todayKey, timeZone);
  const cfg = dayPassRowConfig(relative);
  const heading = formatPassHeading(dayPass, todayKey, timeZone);

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 14,
        paddingHorizontal: 4,
        borderBottomWidth: isLast ? 0 : 1,
        borderBottomColor: C.separator,
      }}
    >
      <View style={{ flex: 1, paddingRight: 12 }}>
        <Text style={{ fontSize: 10, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', color: C.textMute }}>
          {cfg.eyebrow}
        </Text>
        <Text style={{ fontSize: 15, color: C.text, fontWeight: '600', letterSpacing: -0.2, marginTop: 2 }} numberOfLines={1}>
          {heading}
        </Text>
        <Text style={{ fontSize: 13, color: C.textSub, marginTop: 2 }}>Pase diario</Text>
      </View>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: cfg.bg,
          borderRadius: 100,
          paddingVertical: 4,
          paddingHorizontal: 10,
        }}
      >
        <View
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: cfg.dotColor,
            marginRight: 6,
          }}
        />
        <Text
          style={{
            fontSize: 10,
            fontWeight: '700',
            letterSpacing: 0.6,
            textTransform: 'uppercase',
            color: cfg.textColor,
          }}
        >
          {cfg.label}
        </Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Checkout breakdown — receipt-style row
// ---------------------------------------------------------------------------

function BreakdownRow({
  label,
  value,
  bold = false,
  dimValue = false,
  valueColor,
}: {
  label: string;
  value: string;
  bold?: boolean;
  dimValue?: boolean;
  valueColor?: string;
}) {
  const C = getColors();
  const color = valueColor ?? (dimValue ? C.textMute : C.text);
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 13,
      }}
    >
      <Text
        style={{
          flex: 1,
          fontSize: bold ? 16 : 15,
          fontWeight: bold ? '700' : '400',
          letterSpacing: -0.2,
          color: bold ? C.text : C.textSub,
          marginRight: 12,
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          fontSize: bold ? 16 : 15,
          fontWeight: bold ? '700' : '500',
          letterSpacing: -0.3,
          color,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Checkout breakdown modal — slides up before opening Stripe
// ---------------------------------------------------------------------------

/**
 * MM-5 — pre-checkout confirmation for ADD (a membership is being added, nothing is
 * replaced) and CHANGE (both plans named explicitly). Copy comes from membershipDisplay;
 * timing for CHANGE is decided by the API at execution, so no dates are computed here.
 */
function PurchaseConfirmSheet({
  visible,
  plan,
  action,
  relatedPlanName,
  keptPlanNames,
  primaryColor,
  confirmBusy,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  plan: MembershipPlanDto;
  action: 'ADD' | 'CHANGE';
  relatedPlanName: string | null;
  keptPlanNames: string[];
  primaryColor: string;
  confirmBusy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const C = getColors();
  const insets = useSafeAreaInsets();
  const copy =
    action === 'ADD'
      ? addConfirmationCopy({ planName: plan.name, keptPlanNames })
      : { ...changeConfirmationCopy({ currentPlanName: relatedPlanName ?? 'tu plan actual', targetPlanName: plan.name }), keptLine: null };
  const priceStr = formatMoneyFromCents(plan.priceCents, plan.currency);
  const planDetail = plan.classCredits === null
    ? `${priceStr}${billingIntervalLabel(plan.billingInterval)} · Clases ilimitadas`
    : `${priceStr}${billingIntervalLabel(plan.billingInterval)} · ${plan.classCredits} créditos`;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel} statusBarTranslucent>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cerrar confirmación"
        onPress={onCancel}
        style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.72)' }}
      >
        <Pressable
          onPress={() => {}}
          style={{
            backgroundColor: '#141416',
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            borderWidth: 1,
            borderColor: C.separator,
            paddingHorizontal: 24,
            paddingTop: 28,
            paddingBottom: 24 + insets.bottom,
          }}
        >
          <Text style={{ fontSize: 24, fontWeight: '800', letterSpacing: -0.7, color: C.text, marginBottom: 10 }}>
            {copy.title}
          </Text>
          <Text style={{ fontSize: 15, color: C.textSub, lineHeight: 22 }}>{copy.body}</Text>

          <View
            style={{
              marginTop: 18,
              borderRadius: 16,
              borderWidth: 1,
              borderColor: C.separator,
              backgroundColor: 'rgba(255,255,255,0.04)',
              paddingVertical: 14,
              paddingHorizontal: 16,
              gap: 10,
            }}
          >
            <View>
              <Text style={{ fontSize: 15, fontWeight: '700', color: C.text }}>{plan.name}</Text>
              <Text style={{ fontSize: 13, color: C.textSub, marginTop: 2 }}>{planDetail}</Text>
            </View>
            {action === 'ADD' && copy.keptLine ? (
              <View style={{ borderTopWidth: 1, borderTopColor: C.separator, paddingTop: 10 }}>
                <Text style={{ fontSize: 13, color: C.textMute, lineHeight: 19 }}>{copy.keptLine}</Text>
              </View>
            ) : null}
          </View>

          <View style={{ marginTop: 22, gap: 12 }}>
            <BrandButton
              label={confirmBusy ? 'Abriendo…' : 'Continuar al pago'}
              accentColor={primaryColor}
              onPress={onConfirm}
              disabled={confirmBusy}
            />
            <Pressable accessibilityRole="button" onPress={onCancel} hitSlop={8} style={{ alignItems: 'center', paddingVertical: 6 }}>
              <Text style={{ fontSize: 15, fontWeight: '600', color: C.textSub }}>Cancelar</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function CheckoutBreakdownModal({
  visible,
  plan,
  preview,
  primaryColor,
  confirmBusy,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  plan: MembershipPlanDto;
  preview: CheckoutPreviewDto;
  primaryColor: string;
  confirmBusy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const C = getColors();
  const insets = useSafeAreaInsets();

  const isPromo = preview.promoLikelySlotsAvailable;
  const intervalLabel = billingIntervalLabel(plan.billingInterval);
  const planPriceStr = formatMoneyFromCents(plan.priceCents, plan.currency);
  const feeStr = formatMoneyFromCents(preview.enrollmentFeeCents, preview.currency);
  const totalCents = isPromo
    ? plan.priceCents
    : plan.priceCents + preview.enrollmentFeeCents;
  const totalStr = formatMoneyFromCents(totalCents, plan.currency);
  const campaignLabel = preview.campaignName ?? 'Fundadores';

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onCancel}
      statusBarTranslucent
    >
      {/* Backdrop — tap to dismiss */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cerrar resumen"
        onPress={onCancel}
        style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.72)' }}
      >
        {/* Card — absorbs inner taps so backdrop dismiss doesn't fire */}
        <Pressable
          onPress={() => {}}
          style={{
            backgroundColor: '#141416',
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            borderWidth: 1,
            borderBottomWidth: 0,
            borderColor: 'rgba(255,255,255,0.10)',
            paddingHorizontal: 24,
            paddingTop: 12,
            paddingBottom: Math.max(insets.bottom + 8, 28),
          }}
        >
          {/* Drag handle */}
          <View style={{ alignItems: 'center', marginBottom: 24 }}>
            <View
              style={{
                width: 36,
                height: 4,
                borderRadius: 2,
                backgroundColor: 'rgba(255,255,255,0.15)',
              }}
            />
          </View>

          {/* Title */}
          <Text
            style={{
              fontSize: 22,
              fontWeight: '800',
              letterSpacing: -0.6,
              color: C.text,
              marginBottom: 24,
            }}
          >
            Resumen de membresía
          </Text>

          {/* ── Line items ── */}
          <BreakdownRow
            label={`Membresía ${plan.name}`}
            value={`${planPriceStr}${intervalLabel}`}
          />
          <BreakdownRow
            label="Inscripción"
            value={feeStr}
            dimValue={isPromo}
          />
          {isPromo ? (
            <BreakdownRow
              label={`Promoción ${campaignLabel}`}
              value={`-${feeStr}`}
              valueColor="#FCD34D"
            />
          ) : null}

          {/* Divider */}
          <View
            style={{
              height: 1,
              backgroundColor: 'rgba(255,255,255,0.09)',
              marginTop: 4,
              marginBottom: 16,
            }}
          />

          {/* Totals */}
          <BreakdownRow label="Total hoy" value={totalStr} bold />
          <BreakdownRow
            label="Después"
            value={`${planPriceStr}${intervalLabel}`}
            dimValue
          />

          {/* ── Message block ── */}
          <View
            style={{
              marginTop: 8,
              marginBottom: 4,
              borderRadius: 14,
              borderWidth: 1,
              backgroundColor: isPromo ? 'rgba(251,191,36,0.05)' : 'rgba(255,255,255,0.03)',
              borderColor: isPromo ? 'rgba(251,191,36,0.22)' : 'rgba(255,255,255,0.08)',
              paddingVertical: 14,
              paddingHorizontal: 16,
            }}
          >
            <Text
              style={{
                fontSize: 14,
                fontWeight: '700',
                letterSpacing: -0.2,
                color: isPromo ? '#FCD34D' : C.textSub,
                marginBottom: 4,
              }}
            >
              {isPromo ? '🎉 ¡Felicidades!' : 'Inscripción única'}
            </Text>
            <Text
              style={{
                fontSize: 13,
                lineHeight: 19,
                letterSpacing: -0.1,
                color: C.textSub,
              }}
            >
              {isPromo
                ? `Tu inscripción de ${feeStr} va por cuenta de ARES si completas tu pago ahora.`
                : 'Se paga únicamente al comenzar tu membresía.'}
            </Text>
          </View>

          {/* ── CTAs ── */}
          <View style={{ marginTop: 20 }}>
            <BrandButton
              label="Continuar al pago"
              variant="white"
              accentColor={primaryColor}
              loading={confirmBusy}
              disabled={confirmBusy}
              onPress={onConfirm}
            />
            <Pressable
              accessibilityRole="button"
              onPress={onCancel}
              disabled={confirmBusy}
              hitSlop={8}
              style={{ alignItems: 'center', paddingVertical: 18 }}
            >
              <Text
                style={{
                  fontSize: 15,
                  fontWeight: '500',
                  letterSpacing: -0.1,
                  color: confirmBusy ? C.textMute : C.textSub,
                }}
              >
                Cancelar
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function MembershipScreen() {
  const router = useRouter();
  const C = getColors();
  const { primaryColor, appDisplayName } = useBranding();
  const { user } = useAuth();
  const isGuest = user === null;
  const { matched } = useMemberStudio();
  const { studio: publicStudio, timezone: publicTimezone } = usePublicStudio();
  const { refresh: refreshStudioActivity } = useStudioActivity();
  const { initPaymentSheet, presentPaymentSheet } = useStripe();

  const studioId = matched?.studio.id;
  const timeZone = isGuest ? publicTimezone : (matched?.studio.timezone ?? 'UTC');
  const goToAuthLogin = (intent: AuthModalKind) =>
    router.push({
      pathname: '/(auth)/login',
      params: {
        returnTo: MEMBERSHIP_RETURN_TO,
        intent,
      },
    });
  const goToAuthRegister = (intent: AuthModalKind) =>
    router.push({
      pathname: '/(auth)/register',
      params: {
        returnTo: MEMBERSHIP_RETURN_TO,
        intent,
      },
    });
  const openAuthModal = (kind: AuthModalKind) => {
    setAuthModalKind(kind);
    setAuthModalVisible(true);
  };

  const [plans, setPlans] = useState<MembershipPlanDto[]>([]);
  const [profile, setProfile] = useState<MyMemberProfileDto | null>(null);
  const [dayPasses, setDayPasses] = useState<DayPassDto[]>([]);
  const [dayPassCatalog, setDayPassCatalog] = useState<DayPassCatalogDto | null>(null);
  const [dayPassCatalogError, setDayPassCatalogError] = useState<string | null>(null);
  const [checkoutPreview, setCheckoutPreview] = useState<CheckoutPreviewDto | null>(null);
  const [breakdownPlan, setBreakdownPlan] = useState<MembershipPlanDto | null>(null);
  // MM-5: server-computed catalog CTAs + add/change pre-checkout confirmation.
  const [purchaseOptions, setPurchaseOptions] = useState<PurchaseOptionDto[]>([]);
  const [confirmPurchase, setConfirmPurchase] = useState<{
    plan: MembershipPlanDto;
    option: PurchaseOptionDto;
  } | null>(null);
  const [confirmingCheckout, setConfirmingCheckout] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkoutPlanId, setCheckoutPlanId] = useState<string | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);
  const [portalError, setPortalError] = useState<string | null>(null);
  const [dayPassBusy, setDayPassBusy] = useState(false);
  const [dayPassError, setDayPassError] = useState<string | null>(null);
  const [dayPassLoadError, setDayPassLoadError] = useState<string | null>(null);
  const [dayPassSuccess, setDayPassSuccess] = useState(false);
  const [dayPassNotice, setDayPassNotice] = useState<string | null>(null);
  const [dayPassSuccessCopy, setDayPassSuccessCopy] = useState<{ title: string; body: string } | null>(null);
  // Date step: the server's purchase window (studio-local today, horizon, owned days) and the
  // open sheet. Nothing is created on the server until the member confirms a reviewed day.
  const [dayPassWindow, setDayPassWindow] = useState<DayPassPurchaseWindowDto | null>(null);
  const [dayPassSheet, setDayPassSheet] = useState<{ initialDayKey: string | null } | null>(null);
  const [dayPassHistory, setDayPassHistory] = useState<DayPassDto[] | null>(null);
  const [dayPassHistoryBusy, setDayPassHistoryBusy] = useState(false);
  // Flips synchronously at the start of a purchase so a second tap in the same frame is ignored.
  const dayPassInFlight = useRef(false);
  const consumedDayPassParam = useRef<string | null>(null);
  const routeParams = useLocalSearchParams<{ dayPassDate?: string }>();
  const [authModalVisible, setAuthModalVisible] = useState(false);
  const [authModalKind, setAuthModalKind] = useState<AuthModalKind>('membership');
  const expectReturnFromBrowser = useRef(false);
  const hasLoadedOnce = useRef(false);
  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dayPassNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { hasLoadedOnce.current = false; }, [studioId, isGuest]);

  // Clear the success timer on unmount to avoid setState on an unmounted component.
  useEffect(() => {
    return () => {
      if (successTimer.current) clearTimeout(successTimer.current);
      if (dayPassNoticeTimer.current) clearTimeout(dayPassNoticeTimer.current);
    };
  }, []);

  const loadDayPassCatalog = useCallback(async () => {
    const slug = getStudioSlug();
    try {
      const catalog = studioId
        ? await fetchDayPassCatalog(studioId)
        : slug
          ? await fetchPublicDayPassCatalog(slug)
          : null;
      if (!catalog) {
        setDayPassCatalog(null);
        setDayPassCatalogError('El precio del pase diario no está disponible por el momento.');
        return;
      }
      setDayPassCatalog(catalog);
      setDayPassCatalogError(null);
    } catch {
      setDayPassCatalog(null);
      setDayPassCatalogError('El precio del pase diario no está disponible por el momento.');
    }
  }, [studioId]);

  const loadDayPasses = useCallback(async () => {
    if (!studioId) return;
    try {
      // Today + future passes, soonest first. An older API build ignores the scope and returns
      // every pass; groupMyDayPasses sorts either shape identically.
      const dp = await fetchMyDayPasses(studioId, 'upcoming');
      setDayPasses(dp);
      setDayPassLoadError(null);
    } catch (e) {
      setDayPasses([]);
      setDayPassLoadError('Los pases diarios no están disponibles por el momento.');
      if (__DEV__) {
        console.warn('[Membership] fetchMyDayPasses failed:', e);
      }
    }
  }, [studioId]);

  const loadGuest = useCallback(async (mode: 'initial' | 'refresh') => {
    const slug = getStudioSlug();
    if (!slug) {
      setError('Falta la configuración del estudio en la app.');
      setLoading(false);
      return;
    }
    setError(null);
    if (mode === 'initial') setLoading(true);
    else setRefreshing(true);
    try {
      const p = await fetchPublicMembershipPlans(slug);
      setPlans(p.map(toMembershipPlanDto));
      setProfile(null);
      setDayPasses([]);
      setDayPassLoadError(null);
      await loadDayPassCatalog();
    } catch (e) {
      setError(userFacingApiMessage(e, 'No se pudieron cargar los planes de membresía. Desliza para actualizar.'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [loadDayPassCatalog]);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (!studioId) return;
      setError(null);
      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);

      void loadDayPasses();
      void loadDayPassCatalog();

      try {
        const [p, prof, opts] = await Promise.all([
          fetchMembershipPlans(studioId),
          fetchMyMemberProfile(studioId),
          // CTA semantics are server-decided; a transient failure falls back to
          // conservative labels rather than blocking the screen.
          fetchPurchaseOptions(studioId).catch(() => [] as PurchaseOptionDto[]),
        ]);
        setPlans(p);
        setProfile(prof);
        setPurchaseOptions(opts);

        // Fetch enrollment preview for the first available plan (fee info is studio-wide)
        if (p.length > 0 && !prof.activeSubscription) {
          try {
            const preview = await fetchCheckoutPreview(studioId, p[0]!.id);
            setCheckoutPreview(preview);
          } catch {
            setCheckoutPreview(null);
          }
        } else {
          setCheckoutPreview(null);
        }
      } catch (e) {
        setError(userFacingApiMessage(e, 'No se pudo cargar la información de membresía. Desliza para actualizar.'));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [studioId, loadDayPasses, loadDayPassCatalog],
  );

  useFocusEffect(
    useCallback(() => {
      const mode = hasLoadedOnce.current ? 'refresh' : 'initial';
      hasLoadedOnce.current = true;
      if (isGuest) {
        void loadGuest(mode);
        return;
      }
      if (!studioId) { setLoading(false); return; }
      void load(mode);
      void refreshStudioActivity();
    }, [isGuest, studioId, loadGuest, load, refreshStudioActivity]),
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || isGuest || !studioId) return;
      if (!expectReturnFromBrowser.current) return;
      expectReturnFromBrowser.current = false;
      void load('refresh');
      void refreshStudioActivity();
    });
    return () => sub.remove();
  }, [isGuest, studioId, load, refreshStudioActivity]);

  async function handlePurchaseResult(result: MembershipPurchaseResponse) {
    if (result.action === 'plan_changed') {
      if (result.requiresPayment && result.paymentUrl) {
        expectReturnFromBrowser.current = true;
        await Linking.openURL(result.paymentUrl);
        return;
      }
      Alert.alert('Membresía actualizada', result.message);
      void load('refresh');
      void refreshStudioActivity();
      return;
    }
    expectReturnFromBrowser.current = true;
    await Linking.openURL(result.url);
  }

  async function openCheckout(planId: string) {
    if (isGuest) { openAuthModal('membership'); return; }
    if (!studioId) return;

    // If enrollment fee applies, show the breakdown modal first.
    if (checkoutPreview?.enrollmentFeeApplies) {
      const plan = plans.find((p) => p.id === planId);
      if (plan) { setBreakdownPlan(plan); return; }
    }

    setCheckoutPlanId(planId);
    try {
      const result = await createMembershipCheckoutSession(studioId, planId);
      await handlePurchaseResult(result);
    } catch (e) {
      expectReturnFromBrowser.current = false;
      setError(userFacingApiMessage(e, 'No se pudo iniciar el pago. Inténtalo de nuevo.'));
    } finally {
      setCheckoutPlanId(null);
    }
  }

  async function confirmCheckout() {
    if (!studioId || !breakdownPlan) return;
    setConfirmingCheckout(true);
    try {
      const result = await createMembershipCheckoutSession(studioId, breakdownPlan.id);
      setBreakdownPlan(null);
      await handlePurchaseResult(result);
    } catch (e) {
      expectReturnFromBrowser.current = false;
      setBreakdownPlan(null);
      setError(userFacingApiMessage(e, 'No se pudo iniciar el pago. Inténtalo de nuevo.'));
    } finally {
      setConfirmingCheckout(false);
    }
  }

  async function openPortal() {
    if (!studioId) return;
    setPortalError(null);
    setPortalBusy(true);
    try {
      const { url } = await createBillingPortalSession(studioId);
      expectReturnFromBrowser.current = true;
      await Linking.openURL(url);
    } catch (e) {
      expectReturnFromBrowser.current = false;
      setPortalError(userFacingApiMessage(e, 'No se pudo abrir la gestión de membresía. Inténtalo de nuevo.'));
    } finally {
      setPortalBusy(false);
    }
  }

  /** Studio-local today for grouping and copy: the server's word when we have it, else the STUDIO timezone. */
  const dayPassTodayKey = dayPassWindow?.todayKey ?? todayKeyInZone(timeZone);

  /**
   * Step 1: open the date step. Fetches the server's purchase window (studio-local today,
   * horizon, already-owned days) so the picker never depends on the device clock; falls back to
   * the studio timezone if the window call fails. Creates nothing on the server.
   */
  async function openDayPassPicker(initialDayKey: string | null = null) {
    if (isGuest) { openAuthModal('day-pass'); return; }
    if (!studioId) return;
    if (!dayPassCatalog?.active || dayPassCatalogError) return; // same gate as the button
    if (!canStartDayPassPurchase(dayPassBusy, dayPassInFlight.current)) return;
    setDayPassError(null);
    setDayPassNotice(null);
    setDayPassBusy(true);
    try {
      let window: DayPassPurchaseWindowDto;
      try {
        window = await fetchDayPassPurchaseWindow(studioId);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          // Older API build without the window route: derive it from the STUDIO timezone.
          window = fallbackPurchaseWindow(timeZone, dayPasses);
        } else {
          // Anything else is transient: never open a picker built from the device clock.
          if (__DEV__) console.warn('[DayPass] purchase-window failed:', e);
          setDayPassError(DAY_PASS_DATE_COPY.windowUnavailable);
          return;
        }
      }
      setDayPassWindow(window);
      setDayPassSheet({ initialDayKey });
    } finally {
      setDayPassBusy(false);
    }
  }

  /** Step 2: the member confirmed a reviewed day → checkout for exactly that day. */
  async function startDayPassCheckout(dayKey: string, todayKeyAtConfirm: string) {
    if (isGuest || !studioId) return;
    if (!canStartDayPassPurchase(dayPassBusy, dayPassInFlight.current)) return;
    dayPassInFlight.current = true;
    setDayPassBusy(true);
    setDayPassError(null);
    setDayPassNotice(null);
    setDayPassSuccess(false);
    setDayPassSuccessCopy(null);
    if (dayPassNoticeTimer.current) clearTimeout(dayPassNoticeTimer.current);
    try {
      // The chosen day is a request; the server canonicalises it on the studio clock. A retry
      // after an abandoned or declined sheet for the SAME day resumes the same attempt; another
      // day is its own attempt. It is never a second purchase.
      const data = await createDayPassPaymentSheet(studioId, dayKey);
      const purchasedKey = data.validForDate ?? dayKey;

      // Set the Stripe key returned from the server before initializing the sheet.
      await initStripe({ publishableKey: data.publishableKey });

      const { error: initError } = await initPaymentSheet({
        merchantDisplayName: appDisplayName,
        paymentIntentClientSecret: data.paymentIntentClientSecret,
        customerId: data.customerId,
        customerEphemeralKeySecret: data.ephemeralKeySecret,
        allowsDelayedPaymentMethods: false,
        returnURL: createURL('billing/return'),
      });
      if (initError) {
        if (__DEV__) console.warn('[DayPass] initPaymentSheet failed:', initError.code, initError.message);
        setDayPassError(DAY_PASS_COPY.sheetInitFailed);
        return;
      }

      const { error: presentError } = await presentPaymentSheet();
      const outcome = resolvePaymentSheetOutcome(presentError);
      if (outcome.kind === 'canceled') return; // deliberate dismissal: silent, attempt stays reusable
      if (outcome.kind === 'failed') {
        if (__DEV__) console.warn('[DayPass] presentPaymentSheet failed:', presentError?.code, presentError?.message);
        setDayPassError(outcome.message);
        return;
      }

      // Card step finished. Only the server, after asking Stripe, can say the pass is ours.
      let status: DayPassStatus | null = null;
      try {
        const synced = await syncDayPass(studioId, data.dayPassId);
        status = synced.status;
      } catch (e) {
        if (__DEV__) console.warn('[DayPass] sync failed; webhook will activate:', e);
      }
      const next = describePostPaymentStatus(status);
      if (next.kind === 'activated') {
        setDayPassSuccessCopy(activatedCopy(purchasedKey, todayKeyAtConfirm, timeZone));
        setDayPassSuccess(true);
        if (successTimer.current) clearTimeout(successTimer.current);
        successTimer.current = setTimeout(() => setDayPassSuccess(false), 6000);
      } else {
        // Webhook or a later sync will land; never tell the member it failed.
        setDayPassNotice(confirmingCopy(purchasedKey, timeZone));
        dayPassNoticeTimer.current = setTimeout(() => {
          void loadDayPasses();
          setDayPassNotice(null);
        }, 4000);
      }
      void load('refresh');
    } catch (e) {
      if (isAlreadyOwnedConflict(e)) {
        // Good news, not an error (e.g. the server just confirmed a late payment): show it
        // neutrally with the day, and reload so the pass appears in the list.
        setDayPassNotice(`${DAY_PASS_DATE_COPY.ownedTitle} ${ownedDateLine(dayKey, todayKeyAtConfirm, timeZone)}`);
        void loadDayPasses();
        dayPassNoticeTimer.current = setTimeout(() => setDayPassNotice(null), 6000);
      } else {
        setDayPassError(userFacingApiMessage(e, DAY_PASS_COPY.startFailed));
      }
    } finally {
      dayPassInFlight.current = false;
      setDayPassBusy(false);
    }
  }

  async function toggleDayPassHistory() {
    if (!studioId) return;
    if (dayPassHistory !== null) { setDayPassHistory(null); return; }
    setDayPassHistoryBusy(true);
    try {
      const history = await fetchMyDayPasses(studioId, 'history');
      // An older API build ignores the scope; whatever comes back is grouped again on display.
      setDayPassHistory(history);
    } catch {
      setDayPassHistory([]);
    } finally {
      setDayPassHistoryBusy(false);
    }
  }

  // Arriving from a class ("buy a pass for this day"): open the picker pre-selected once.
  useEffect(() => {
    const wanted = routeParams.dayPassDate;
    if (!wanted || isGuest || !studioId || loading) return;
    if (!dayPassCatalog?.active || dayPassCatalogError) return; // wait for / respect the catalog gate
    if (consumedDayPassParam.current === wanted) return;
    consumedDayPassParam.current = wanted;
    void openDayPassPicker(wanted);
  }, [routeParams.dayPassDate, isGuest, studioId, loading, dayPassCatalog, dayPassCatalogError]);

  const refresh = isGuest ? () => loadGuest('refresh') : () => { void load('refresh'); void refreshStudioActivity(); };

  if (!isGuest && (!studioId || !matched)) return <ScreenLoader />;
  if (error && !plans.length && !loading && (isGuest || !profile)) {
    return (
      <LoadRetryPanel
        message={error}
        onRetry={() => void (isGuest ? loadGuest('initial') : load('initial'))}
      />
    );
  }
  if (loading && !plans.length && (isGuest || !profile)) return <ScreenLoader />;

  const sub = profile?.activeSubscription;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['bottom', 'left', 'right']}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: Space.screenH, paddingBottom: TAB_BAR_CLEARANCE }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            tintColor={primaryColor}
          />
        }
      >
        {/* ── Page header ── */}
        <Animated.View entering={FadeInDown.duration(400)} style={{ paddingTop: 28, marginBottom: 32 }}>
          <Text
            style={{
              fontSize: 38,
              fontWeight: '800',
              letterSpacing: -1.3,
              color: C.text,
              lineHeight: 44,
            }}
          >
            Membresía
          </Text>
          <Text
            style={{
              fontSize: 15,
              color: C.textSub,
              marginTop: 8,
              letterSpacing: -0.1,
              lineHeight: 22,
            }}
          >
            {appDisplayName}
          </Text>
        </Animated.View>

        {/* Mi Pase — permanent member identity, independent of subscription state (a member
            with no active plan history still has an identity worth showing/adding to Wallet). */}
        {!isGuest ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Ver mi pase de miembro"
            onPress={() => router.push('/(app)/mi-pase' as Href)}
            hitSlop={8}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              backgroundColor: C.surface1,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: C.separator,
              paddingVertical: 16,
              paddingHorizontal: 18,
              marginBottom: 24,
            }}
          >
            <Text style={{ fontSize: 15, fontWeight: '600', color: C.text, letterSpacing: -0.2 }}>
              Mi Pase
            </Text>
            <Text style={{ fontSize: 15, color: C.textMute }}>→</Text>
          </Pressable>
        ) : null}

        {error ? (
          <Text style={{ fontSize: 13, color: C.negative, marginBottom: 16 }}>{error}</Text>
        ) : null}

        {/* ── Active card, member prompt, or guest value prop ── */}
        {isGuest ? (
          <GuestMembershipPrompt
            studioName={publicStudio?.name ?? ''}
            primaryColor={primaryColor}
            onRegister={() => openAuthModal('membership')}
            onLogin={() => goToAuthLogin('membership')}
          />
        ) : (profile?.memberships.length ?? 0) > 0 ? (
          <View>
            <SectionLabel>
              {profile!.memberships.filter((m) => m.status !== 'SCHEDULED').length > 1
                ? 'Mis membresías'
                : 'Mi membresía'}
            </SectionLabel>
            <MembershipList
              memberships={profile!.memberships}
              primaryColor={primaryColor}
              timeZone={timeZone}
              onManage={() => void openPortal()}
              portalBusy={portalBusy}
            />
          </View>
        ) : (
          <NoMembershipPrompt
            primaryColor={primaryColor}
            onManage={() => void openPortal()}
            portalBusy={portalBusy}
          />
        )}

        {!isGuest && portalError ? (
          <Text style={{ fontSize: 13, color: C.negative, marginBottom: 16, textAlign: 'center', marginTop: 8 }}>
            {portalError}
          </Text>
        ) : null}

        {/* ── Available plans ── */}
        {plans.length > 0 ? (
          <View style={{ marginTop: Space.sectionGap }}>
            <SectionLabel>Planes disponibles</SectionLabel>

            {/* Enrollment fee / founders promo disclosure */}
            {!isGuest && checkoutPreview?.enrollmentFeeApplies ? (
              <View
                style={{
                  marginBottom: 20,
                  borderRadius: 16,
                  borderWidth: 1,
                  borderColor: checkoutPreview.promoLikelySlotsAvailable
                    ? 'rgba(251,191,36,0.35)'
                    : 'rgba(255,255,255,0.10)',
                  backgroundColor: checkoutPreview.promoLikelySlotsAvailable
                    ? 'rgba(251,191,36,0.06)'
                    : 'rgba(255,255,255,0.03)',
                  paddingVertical: 14,
                  paddingHorizontal: 16,
                }}
              >
                <Text
                  style={{
                    fontSize: 13,
                    lineHeight: 19,
                    color: checkoutPreview.promoLikelySlotsAvailable ? '#FCD34D' : C.textSub,
                    letterSpacing: -0.1,
                  }}
                >
                  {checkoutPreview.promoLikelySlotsAvailable
                    ? `¡Aún hay lugares de ${checkoutPreview.campaignName ?? 'Fundadores'}! Si completas tu pago ahora, tu inscripción de ${formatMoneyFromCents(checkoutPreview.enrollmentFeeCents, 'mxn')} podría ir por cuenta de ARES.`
                    : `Inscripción única de ${formatMoneyFromCents(checkoutPreview.enrollmentFeeCents, 'mxn')}. Se paga únicamente al comenzar tu membresía.`}
                </Text>
              </View>
            ) : null}

            {plans.map((plan, i) => {
              // MM-5: CTAs are the server's purchaseAction, rendered verbatim — the client
              // never derives compatibility. Fallback (options unavailable): conservative
              // legacy labels.
              const option = purchaseOptions.find((o) => o.planId === plan.id) ?? null;
              const action: PurchaseActionLike = isGuest
                ? 'SUBSCRIBE'
                : option?.purchaseAction ?? (sub ? 'CHANGE' : 'SUBSCRIBE');
              const subscribeLabel = isGuest ? 'Únete ahora' : purchaseCtaLabel(action);
              const disabled = !isGuest && isPurchaseActionDisabled(action);
              const blockedNote =
                !isGuest && action === 'BLOCKED' ? blockedReasonCopy(option?.reasonCode ?? null) : null;
              const onSubscribe = () => {
                if (isGuest) {
                  openAuthModal('membership');
                  return;
                }
                if ((action === 'ADD' || action === 'CHANGE') && option) {
                  setConfirmPurchase({ plan, option });
                  return;
                }
                void openCheckout(plan.id);
              };
              return (
              <View key={plan.id}>
                <PlanCard
                  plan={plan}
                  primaryColor={primaryColor}
                  index={i}
                  isLoading={!isGuest && checkoutPlanId === plan.id}
                  isDisabled={
                    disabled ||
                    (!isGuest && checkoutPlanId !== null && checkoutPlanId !== plan.id)
                  }
                  subscribeLabel={subscribeLabel}
                  onSubscribe={onSubscribe}
                />
                {blockedNote ? (
                  <Text style={{ fontSize: 12, color: C.textMute, marginTop: -12, marginBottom: 16, lineHeight: 18 }}>
                    {blockedNote}
                  </Text>
                ) : null}
              </View>
            );})}
          </View>
        ) : loading ? (
          <View style={{ gap: 10, marginTop: Space.sectionGap }}>
            <Skeleton height={200} radius={20} />
            <Skeleton height={200} radius={20} />
          </View>
        ) : (
          <Text style={{ fontSize: 14, color: C.textMute, lineHeight: 22, marginTop: Space.sectionGap }}>
            Aún no hay planes publicados. Vuelve más tarde o contacta al estudio.
          </Text>
        )}

        {/* ── Day Pass ── */}
        <View style={{ marginTop: Space.sectionGap }}>
          <SectionLabel>Pase diario</SectionLabel>

          <Animated.View entering={FadeInDown.duration(420)}>
            <View
              style={{
                ...premiumCardStyle(C),
                overflow: 'hidden',
                marginBottom: Space.cardGap,
              }}
            >
              {/* ── Hero image ── */}
              <View style={{ height: 150 }}>
                <ImageSlot
                  uri={FitnessImages.performance}
                  style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
                />
                <View
                  pointerEvents="none"
                  style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.20)' }}
                />
                <View
                  pointerEvents="none"
                  style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '60%', backgroundColor: 'rgba(0,0,0,0.52)' }}
                />
                <View
                  pointerEvents="none"
                  style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '30%', backgroundColor: 'rgba(0,0,0,0.36)' }}
                />
              </View>

              {/* Accent bar */}
              <View style={{ height: 2, backgroundColor: primaryColor }} />

              {/* ── Content ── */}
              <View style={{ padding: 24 }}>
                <Text
                  style={{
                    fontSize: 26,
                    fontWeight: '800',
                    letterSpacing: -0.8,
                    color: C.text,
                    textTransform: 'uppercase',
                    lineHeight: 30,
                    marginBottom: 6,
                  }}
                >
                  Pase diario
                </Text>
                <Text
                  style={{
                    fontSize: 14,
                    color: C.textSub,
                    letterSpacing: -0.1,
                    marginBottom: 20,
                  }}
                >
                  Entrena el día que elijas. Sin membresía.
                </Text>

                {/* Price hero */}
                <View style={{ flexDirection: 'row', alignItems: 'flex-end', marginBottom: 18 }}>
                  {dayPassCatalog ? (
                    <>
                      <Text
                        style={{
                          fontSize: 48,
                          fontWeight: '800',
                          letterSpacing: -2,
                          color: C.text,
                          lineHeight: 52,
                        }}
                      >
                        {formatMoneyFromCents(dayPassCatalog.priceCents, dayPassCatalog.currency)}
                      </Text>
                      <Text
                        style={{
                          fontSize: 16,
                          color: C.textMute,
                          marginBottom: 8,
                          marginLeft: 5,
                          letterSpacing: -0.2,
                        }}
                      >
                        / día
                      </Text>
                    </>
                  ) : (
                    <Text
                      style={{
                        fontSize: 16,
                        color: C.textMute,
                        lineHeight: 22,
                      }}
                    >
                      {dayPassCatalogError ?? 'Precio no disponible'}
                    </Text>
                  )}
                </View>

                {/* Benefits */}
                <View style={{ gap: 10, marginBottom: 24 }}>
                  {['Válido el día que elijas', 'Reserva clases elegibles', 'Ideal para tu primera visita'].map(
                    (benefit) => (
                      <View key={benefit} style={{ flexDirection: 'row', alignItems: 'center' }}>
                        <View
                          style={{
                            width: 5,
                            height: 5,
                            borderRadius: 2.5,
                            backgroundColor: 'rgba(255,255,255,0.55)',
                            marginRight: 10,
                          }}
                        />
                        <Text
                          style={{
                            fontSize: 14,
                            color: C.textSub,
                            letterSpacing: -0.1,
                          }}
                        >
                          {benefit}
                        </Text>
                      </View>
                    ),
                  )}
                </View>

                {!isGuest && dayPassSuccess && dayPassSuccessCopy ? (
                  <View style={{ marginBottom: 12 }}>
                    <Text style={{ fontSize: 14, color: C.positive, fontWeight: '700', letterSpacing: -0.1 }}>
                      {dayPassSuccessCopy.title}
                    </Text>
                    <Text style={{ fontSize: 13, color: C.textSub, marginTop: 2, lineHeight: 19 }}>
                      {dayPassSuccessCopy.body}
                    </Text>
                  </View>
                ) : null}

                {!isGuest && dayPassNotice ? (
                  <Text style={{ fontSize: 13, color: C.textSub, marginBottom: 12, lineHeight: 19 }}>
                    {dayPassNotice}
                  </Text>
                ) : null}

                {!isGuest && dayPassError ? (
                  <Text style={{ fontSize: 13, color: C.negative, marginBottom: 12, lineHeight: 19 }}>
                    {dayPassError}
                  </Text>
                ) : null}

                <BrandButton
                  label="Comprar pase diario"
                  variant="white"
                  accentColor={primaryColor}
                  loading={!isGuest && dayPassBusy}
                  disabled={
                    dayPassBusy ||
                    !!dayPassCatalogError ||
                    (!isGuest && !dayPassCatalog?.active) ||
                    (isGuest && (!dayPassCatalog || !dayPassCatalog.active))
                  }
                  onPress={() => void (isGuest ? openAuthModal('day-pass') : openDayPassPicker())}
                />
                {isGuest ? (
                  <InlineAuthLink
                    prompt="¿Ya tienes cuenta?"
                    action="Iniciar sesión"
                    onPress={() => goToAuthLogin('day-pass')}
                  />
                ) : null}
              </View>
            </View>
          </Animated.View>

          {!isGuest && dayPassLoadError ? (
            <Text style={{ fontSize: 12, color: C.textMute, lineHeight: 18, marginBottom: 12 }}>
              {dayPassLoadError}
            </Text>
          ) : null}

          {/* Mis pases diarios — today first, then upcoming; history on demand */}
          {!isGuest && (() => {
            const grouped = groupMyDayPasses(dayPasses, dayPassTodayKey, timeZone);
            const current = [...grouped.today, ...grouped.upcoming];
            // Older API builds return every pass in the main list; their past rows are history.
            const historyRows = dayPassHistory
              ? groupMyDayPasses(dayPassHistory, dayPassTodayKey, timeZone).past
              : grouped.past;
            const historyAvailable = dayPassHistory !== null || grouped.past.length > 0 || current.length > 0;
            if (current.length === 0 && !historyAvailable) return null;
            return (
              <Animated.View entering={FadeInDown.duration(380)}>
                <SectionLabel>{DAY_PASS_DATE_COPY.sectionTitle}</SectionLabel>
                <View
                  style={{
                    ...premiumCardStyle(C),
                    paddingHorizontal: 20,
                    overflow: 'hidden',
                  }}
                >
                  {current.length === 0 ? (
                    <Text style={{ fontSize: 13, color: C.textMute, lineHeight: 19, paddingVertical: 14 }}>
                      {DAY_PASS_DATE_COPY.noPasses}
                    </Text>
                  ) : (
                    current.map((dp, i) => (
                      <DayPassRow
                        key={dp.id}
                        dayPass={dp}
                        todayKey={dayPassTodayKey}
                        timeZone={timeZone}
                        isLast={i === current.length - 1 && dayPassHistory === null}
                      />
                    ))
                  )}
                  {dayPassHistory !== null
                    ? historyRows.map((dp, i) => (
                        <DayPassRow
                          key={dp.id}
                          dayPass={dp}
                          todayKey={dayPassTodayKey}
                          timeZone={timeZone}
                          isLast={i === historyRows.length - 1}
                        />
                      ))
                    : null}
                  {dayPassHistory !== null && historyRows.length === 0 ? (
                    <Text style={{ fontSize: 13, color: C.textMute, lineHeight: 19, paddingVertical: 12 }}>
                      Sin pases anteriores.
                    </Text>
                  ) : null}
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => void toggleDayPassHistory()}
                    disabled={dayPassHistoryBusy}
                    hitSlop={8}
                    style={{ paddingVertical: 12, alignItems: 'center' }}
                  >
                    <Text style={{ fontSize: 13, fontWeight: '600', color: C.textSub }}>
                      {dayPassHistoryBusy ? 'Cargando…' : dayPassHistory !== null ? DAY_PASS_DATE_COPY.hideHistory : DAY_PASS_DATE_COPY.viewHistory}
                    </Text>
                  </Pressable>
                </View>
              </Animated.View>
            );
          })()}
        </View>
      </ScrollView>

      {dayPassSheet && dayPassWindow && dayPassCatalog?.active ? (
        <DayPassDateSheet
          visible
          window={dayPassWindow}
          priceCents={dayPassCatalog.priceCents}
          currency={dayPassCatalog.currency}
          initialDayKey={dayPassSheet.initialDayKey}
          primaryColor={primaryColor}
          confirmBusy={dayPassBusy}
          onConfirm={(dayKey) => {
            const todayKeyAtConfirm = dayPassWindow.todayKey;
            setDayPassSheet(null);
            setDayPassWindow(null); // never let a stale "today" outlive the sheet
            void startDayPassCheckout(dayKey, todayKeyAtConfirm);
          }}
          onCancel={() => {
            setDayPassSheet(null);
            setDayPassWindow(null);
          }}
        />
      ) : null}

      {confirmPurchase ? (
        <PurchaseConfirmSheet
          visible
          plan={confirmPurchase.plan}
          action={confirmPurchase.option.purchaseAction === 'ADD' ? 'ADD' : 'CHANGE'}
          relatedPlanName={confirmPurchase.option.relatedPlanName}
          keptPlanNames={(profile?.memberships ?? [])
            .filter((m) => m.status !== 'SCHEDULED' && m.membershipPlanId !== confirmPurchase.plan.id)
            .map((m) => m.plan.name)}
          primaryColor={primaryColor}
          confirmBusy={checkoutPlanId === confirmPurchase.plan.id}
          onConfirm={() => {
            const planId = confirmPurchase.plan.id;
            setConfirmPurchase(null);
            void openCheckout(planId);
          }}
          onCancel={() => setConfirmPurchase(null)}
        />
      ) : null}

      {breakdownPlan && checkoutPreview ? (
        <CheckoutBreakdownModal
          visible
          plan={breakdownPlan}
          preview={checkoutPreview}
          primaryColor={primaryColor}
          confirmBusy={confirmingCheckout}
          onConfirm={() => void confirmCheckout()}
          onCancel={() => { if (!confirmingCheckout) setBreakdownPlan(null); }}
        />
      ) : null}

      <AuthRequiredModal
        visible={authModalVisible}
        title={AUTH_MODAL_COPY[authModalKind].title}
        description={AUTH_MODAL_COPY[authModalKind].description}
        onPrimary={() => {
          setAuthModalVisible(false);
          goToAuthRegister(authModalKind);
        }}
        onSecondary={() => {
          setAuthModalVisible(false);
          goToAuthLogin(authModalKind);
        }}
        onClose={() => setAuthModalVisible(false)}
      />
    </SafeAreaView>
  );
}
