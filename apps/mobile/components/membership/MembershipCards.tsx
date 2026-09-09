import React from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import type { MembershipSummaryDto } from '@/lib/api/membershipApi';
import {
  attachScheduledSuccessors,
  membershipCreditsDisplay,
  membershipPriceLine,
  membershipStatusDisplay,
  paymentSourceLine,
  scheduledSuccessorLine,
  type MembershipTone,
} from '@/lib/membershipDisplay';
import { getColors, type ThemeColors } from '@/constants/Theme';

/**
 * MM-5 — MIS MEMBRESÍAS. Presentation only: every fact on a card comes from the API's
 * memberships[] entry; nothing is derived client-side beyond formatting (membershipDisplay).
 * One membership renders exactly like today's hero card; 2–4 stack vertically.
 */

const CARD_BG = '#141416';

function cardStyle(C: ThemeColors) {
  return {
    backgroundColor: CARD_BG,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: C.separator,
  } as const;
}

function toneColors(tone: MembershipTone, C: ThemeColors): { dot: string; bg: string; text: string } {
  switch (tone) {
    case 'positive':
      return { dot: C.positive, bg: 'rgba(52,211,153,0.12)', text: C.positive };
    case 'caution':
      return { dot: C.caution, bg: 'rgba(251,191,36,0.12)', text: C.caution };
    case 'negative':
      return { dot: C.negative, bg: 'rgba(248,113,113,0.12)', text: C.negative };
    default:
      return { dot: C.textMute, bg: 'rgba(255,255,255,0.08)', text: C.textMute };
  }
}

export function MembershipStatusBadge({
  label,
  tone,
}: {
  label: string;
  tone: MembershipTone;
}) {
  const C = getColors();
  const colors = toneColors(tone, C);
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.bg,
        borderRadius: 100,
        paddingVertical: 5,
        paddingHorizontal: 10,
      }}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.dot, marginRight: 6 }} />
      <Text
        style={{
          fontSize: 11,
          fontWeight: '700',
          letterSpacing: 0.6,
          textTransform: 'uppercase',
          color: colors.text,
        }}
      >
        {label}
      </Text>
    </View>
  );
}

function ScheduledSuccessorRow({
  successor,
  timeZone,
}: {
  successor: MembershipSummaryDto;
  timeZone?: string;
}) {
  const C = getColors();
  return (
    <View
      style={{
        marginTop: 14,
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: C.separator,
        backgroundColor: 'rgba(255,255,255,0.03)',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <Text style={{ fontSize: 13, color: C.textSub, flex: 1, letterSpacing: -0.1 }}>
        {scheduledSuccessorLine(successor, { timeZone })}
      </Text>
    </View>
  );
}

export function MembershipCard({
  membership,
  successor,
  primaryColor,
  timeZone,
  onManage,
  portalBusy,
}: {
  membership: MembershipSummaryDto;
  successor: MembershipSummaryDto | null;
  primaryColor: string;
  timeZone?: string;
  /** Present only for Stripe-paid memberships (customer-level billing portal). */
  onManage?: () => void;
  portalBusy?: boolean;
}) {
  const C = getColors();
  const status = membershipStatusDisplay(membership, { timeZone });
  const accentBarColor = status.tone === 'positive' ? primaryColor : C.surface3;
  const credits = membershipCreditsDisplay(
    membership.plan.classCredits,
    membership.creditsUsed,
    membership.creditsRemaining,
  );
  const showCreditProgress =
    membership.plan.classCredits !== null &&
    typeof membership.creditsUsed === 'number' &&
    membership.plan.classCredits > 0;
  const creditProgress = showCreditProgress
    ? Math.min((membership.creditsUsed ?? 0) / (membership.plan.classCredits ?? 1), 1)
    : 0;
  const accessibility = [
    membership.plan.name,
    status.label,
    credits.primary,
    status.dateLine ?? '',
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <Animated.View entering={FadeInDown.duration(450)}>
      <View
        accessible
        accessibilityLabel={accessibility}
        style={{ ...cardStyle(C), overflow: 'hidden', marginBottom: 12 }}
      >
        <View style={{ height: 3, backgroundColor: accentBarColor }} />

        <View style={{ padding: 28 }}>
          <View style={{ marginBottom: 20 }}>
            <MembershipStatusBadge label={status.label} tone={status.tone} />
          </View>

          <Text
            style={{
              fontSize: 30,
              fontWeight: '800',
              letterSpacing: -0.9,
              color: C.text,
              lineHeight: 35,
              marginBottom: 8,
            }}
            numberOfLines={2}
          >
            {membership.plan.name}
          </Text>

          <Text style={{ fontSize: 14, color: C.textSub, letterSpacing: -0.1 }}>
            {membershipPriceLine(membership.plan)}
            {' · '}
            {paymentSourceLine(membership.source)}
          </Text>

          {status.dateLine ? (
            <Text style={{ fontSize: 14, color: C.textMute, lineHeight: 20, marginTop: 8 }}>
              {status.dateLine}
            </Text>
          ) : null}

          {membership.pendingPlan ? (
            <Text style={{ fontSize: 13, color: C.caution, marginTop: 8 }}>
              Cambia a {membership.pendingPlan.name} en tu próxima renovación
            </Text>
          ) : null}

          {/* Credits — always scoped to THIS membership, never aggregated. */}
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
            <Text style={{ fontSize: 15, fontWeight: '600', color: C.text, letterSpacing: -0.2 }}>
              {credits.primary}
            </Text>
            {credits.secondary ? (
              <Text style={{ fontSize: 13, color: C.textSub, marginTop: 4, letterSpacing: -0.05 }}>
                {credits.secondary}
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

          {successor ? <ScheduledSuccessorRow successor={successor} timeZone={timeZone} /> : null}

          {membership.source === 'STRIPE' && onManage ? (
            <>
              <View style={{ height: 1, backgroundColor: C.separator, marginVertical: 22 }} />
              <Pressable accessibilityRole="button" onPress={onManage} disabled={portalBusy} hitSlop={8}>
                <Text
                  style={{
                    fontSize: 15,
                    fontWeight: '600',
                    color: portalBusy ? C.textMute : C.text,
                    letterSpacing: -0.2,
                  }}
                >
                  {portalBusy ? 'Abriendo…' : 'Gestionar pago →'}
                </Text>
              </Pressable>
            </>
          ) : null}
        </View>
      </View>
    </Animated.View>
  );
}

export function MembershipList({
  memberships,
  primaryColor,
  timeZone,
  onManage,
  portalBusy,
}: {
  memberships: MembershipSummaryDto[];
  primaryColor: string;
  timeZone?: string;
  onManage?: () => void;
  portalBusy?: boolean;
}) {
  const C = getColors();
  const { memberships: entries, orphanSuccessors } = attachScheduledSuccessors(memberships);
  const stripeCount = memberships.filter(
    (m) => m.source === 'STRIPE' && m.status !== 'SCHEDULED',
  ).length;

  return (
    <View>
      {entries.map(({ membership, successor }) => (
        <MembershipCard
          key={membership.subscriptionId}
          membership={membership}
          successor={successor}
          primaryColor={primaryColor}
          timeZone={timeZone}
          onManage={onManage}
          portalBusy={portalBusy}
        />
      ))}
      {orphanSuccessors.map((successor) => (
        <MembershipCard
          key={successor.subscriptionId}
          membership={successor}
          successor={null}
          primaryColor={primaryColor}
          timeZone={timeZone}
        />
      ))}
      {stripeCount > 1 ? (
        <Text style={{ fontSize: 12, color: C.textMute, lineHeight: 18, marginTop: 2, marginBottom: 6 }}>
          Verás todas tus suscripciones en el portal; administra cada una por separado.
        </Text>
      ) : null}
    </View>
  );
}
