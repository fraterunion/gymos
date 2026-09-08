import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useRouter } from 'expo-router';
import { Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { BrandButton } from '@/components/BrandButton';
import { useBranding } from '@/contexts/BrandingContext';
import type { MemberPaymentDto, MemberProfileDto, MemberSubscriptionDto } from '@/lib/api/memberProfileApi';
import type { SalesSettings } from '@/lib/api/salesApi';
import { formatMoneyFromCents } from '@/lib/formatMoney';
import {
  billingIntervalLabel,
  canGenerateCheckoutLink,
  canPerformBillingActions,
  canRecordCashPayment,
  deriveRenewalLabel,
  findActiveSubscriptionWithSource,
  findLastPayment,
  formatLastPaymentSummary,
  isPastDue,
  membershipStatusPill,
  paymentMethodLabel,
  paymentStatusColors,
  paymentStatusLabel,
} from '@/lib/memberBillingHelpers';
import { formatProfileDate, subscriptionSourceLabel } from '@/lib/memberProfileHelpers';
import {
  membershipCreditsDisplay,
  membershipPriceLine,
  membershipStatusDisplay,
  paymentSourceLine,
} from '@/lib/membershipDisplay';
import { staffSalesHref } from '@/lib/memberProfileRoutes';
import { getColors, type ThemeColors } from '@/constants/Theme';

const CARD_BG = '#141416';

function cardStyle(C: ThemeColors) {
  return {
    backgroundColor: CARD_BG,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: C.separator,
    padding: 24,
  } as const;
}

function StatusPill({ label, bg, textColor }: { label: string; bg: string; textColor: string }) {
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        borderRadius: 999,
        paddingHorizontal: 14,
        paddingVertical: 8,
        backgroundColor: bg,
      }}
    >
      <Text style={{ fontSize: 13, fontWeight: '700', color: textColor }}>{label}</Text>
    </View>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
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
      <Text style={{ fontSize: 16, fontWeight: '600', color: C.text, lineHeight: 22 }}>{value}</Text>
    </View>
  );
}

function PaymentHistoryRow({ payment, index }: { payment: MemberPaymentDto; index: number }) {
  const C = getColors();
  const colors = paymentStatusColors(payment.status);
  const amount = formatMoneyFromCents(payment.amountCents, payment.currency);
  const method = paymentMethodLabel(payment.paymentMethod);

  return (
    <Animated.View
      entering={FadeInDown.delay(index * 35).duration(320)}
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 14,
        paddingVertical: 16,
        borderBottomWidth: 1,
        borderBottomColor: C.separator,
      }}
    >
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: 12,
          backgroundColor: 'rgba(255,255,255,0.06)',
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 2,
        }}
      >
        <FontAwesome
          name={payment.paymentMethod === 'CASH' ? 'money' : 'credit-card'}
          size={16}
          color={C.textSub}
        />
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: C.text, letterSpacing: -0.2 }}>{amount}</Text>
          <View
            style={{
              borderRadius: 999,
              paddingHorizontal: 10,
              paddingVertical: 5,
              backgroundColor: colors.bg,
            }}
          >
            <Text style={{ fontSize: 11, fontWeight: '700', color: colors.text }}>
              {paymentStatusLabel(payment.status)}
            </Text>
          </View>
        </View>
        {method ? (
          <Text style={{ fontSize: 13, color: C.textMute, marginTop: 4 }}>{method}</Text>
        ) : null}
        <Text style={{ fontSize: 12, color: C.textMute, marginTop: 6 }}>
          {formatProfileDate(payment.paidAt ?? payment.createdAt)}
        </Text>
      </View>
    </Animated.View>
  );
}

type Props = {
  userId: string;
  role: string | null;
  profile: MemberProfileDto;
  subscriptions: MemberSubscriptionDto[] | null;
  payments: MemberPaymentDto[] | null;
  paymentsError: boolean;
  salesSettings: SalesSettings | null;
  animationDelay?: number;
};

export function MemberBillingCenter({
  userId,
  role,
  profile,
  subscriptions,
  payments,
  paymentsError,
  salesSettings,
  animationDelay = 60,
}: Props) {
  const router = useRouter();
  const C = getColors();
  const { primaryColor } = useBranding();

  const sub = profile.activeSubscription;
  const subWithSource = findActiveSubscriptionWithSource(subscriptions, profile);
  const statusPill = membershipStatusPill(sub);
  const renewalLabel = deriveRenewalLabel(sub);
  const lastPayment = findLastPayment(payments);
  const lastPaymentSummary = formatLastPaymentSummary(lastPayment);
  const pastDue = isPastDue(sub);
  // MM-5: one billing block per current membership — never just the primary.
  const currentMemberships = (profile.memberships ?? []).filter((m) => m.status !== 'SCHEDULED');
  const scheduledSuccessors = (profile.memberships ?? []).filter((m) => m.status === 'SCHEDULED');
  const pastDueMemberships = currentMemberships.filter((m) => m.status === 'PAST_DUE');
  void statusPill;
  void renewalLabel;
  void pastDue;

  const showActions = canPerformBillingActions(role);
  const showCheckout = canGenerateCheckoutLink(role, salesSettings);
  const showCash = canRecordCashPayment(role, salesSettings);

  const planPrice =
    sub?.plan != null
      ? `${formatMoneyFromCents(sub.plan.priceCents, sub.plan.currency)} / ${billingIntervalLabel(sub.plan.billingInterval)}`
      : null;

  const sourceLabel = subWithSource?.source
    ? subscriptionSourceLabel(subWithSource.source) ?? subWithSource.source
    : null;

  return (
    <>
      <Text
        style={{
          fontSize: 11,
          fontWeight: '700',
          letterSpacing: 1.2,
          textTransform: 'uppercase',
          color: C.textMute,
          marginBottom: 14,
          marginTop: 28,
        }}
      >
        Facturación
      </Text>

      <Animated.View entering={FadeInDown.delay(animationDelay).duration(380)} style={cardStyle(C)}>
        {currentMemberships.length > 0 ? (
          <>
            {pastDueMemberships.length > 0 ? (
              <View
                style={{
                  borderRadius: 16,
                  borderWidth: 1,
                  borderColor: 'rgba(251,191,36,0.35)',
                  backgroundColor: 'rgba(251,191,36,0.08)',
                  padding: 14,
                  marginBottom: 18,
                }}
              >
                <Text style={{ fontSize: 14, fontWeight: '700', color: C.caution }}>
                  {pastDueMemberships.map((m) => m.plan.name).join(' · ')} · Pago pendiente
                </Text>
                <Text style={{ fontSize: 13, lineHeight: 19, color: C.textSub, marginTop: 4 }}>
                  Genera un link de pago o registra el cobro en ventas.
                </Text>
              </View>
            ) : null}

            <Text
              style={{
                fontSize: 11,
                fontWeight: '700',
                letterSpacing: 1,
                textTransform: 'uppercase',
                color: C.textMute,
                marginBottom: 10,
              }}
            >
              {currentMemberships.length > 1 ? 'Membresías' : 'Membresía actual'}
            </Text>
            {currentMemberships.map((m, idx) => {
              const display = membershipStatusDisplay(m);
              const credits = membershipCreditsDisplay(m.plan.classCredits, m.creditsUsed, m.creditsRemaining);
              const successor = scheduledSuccessors.find(
                (sched) => m.supersededBySubscriptionId === sched.subscriptionId,
              );
              const toneColors =
                display.tone === 'positive'
                  ? { bg: 'rgba(52,211,153,0.12)', text: C.positive }
                  : display.tone === 'caution'
                    ? { bg: 'rgba(251,191,36,0.12)', text: C.caution }
                    : display.tone === 'negative'
                      ? { bg: 'rgba(248,113,113,0.12)', text: C.negative }
                      : { bg: 'rgba(255,255,255,0.08)', text: C.textMute };
              return (
                <View
                  key={m.subscriptionId}
                  style={
                    idx < currentMemberships.length - 1
                      ? { marginBottom: 20, paddingBottom: 20, borderBottomWidth: 1, borderBottomColor: C.separator }
                      : undefined
                  }
                >
                  <Text
                    style={{
                      fontSize: 24,
                      fontWeight: '800',
                      letterSpacing: -0.6,
                      color: C.text,
                      marginBottom: 6,
                    }}
                    numberOfLines={2}
                  >
                    {m.plan.name}
                  </Text>
                  <Text style={{ fontSize: 15, color: C.textSub, marginBottom: 14 }}>
                    {membershipPriceLine(m.plan)}
                  </Text>
                  <StatusPill label={display.label} bg={toneColors.bg} textColor={toneColors.text} />

                  <View style={{ marginTop: 18 }}>
                    <InfoRow label="Origen de pago" value={paymentSourceLine(m.source) || m.source} />
                    {m.effectiveEnd ? (
                      <InfoRow label="Vigencia" value={formatProfileDate(m.effectiveEnd)} />
                    ) : null}
                    <InfoRow
                      label="Renovación"
                      value={m.cancelAtPeriodEnd || m.status === 'CANCELED' ? 'No renovará' : 'Automática'}
                    />
                    {m.plan.classCredits != null ? (
                      <InfoRow label="Créditos" value={credits.primary} />
                    ) : null}
                    {successor ? (
                      <InfoRow
                        label="Programada"
                        value={`Sucesora inicia ${formatProfileDate(successor.currentPeriodStart)}`}
                      />
                    ) : null}
                  </View>
                </View>
              );
            })}
            {lastPaymentSummary ? (
              <View style={{ marginTop: 8 }}>
                <InfoRow label="Último pago" value={lastPaymentSummary} />
              </View>
            ) : null}
          </>
        ) : (
          <>
            <Text style={{ fontSize: 18, fontWeight: '700', color: C.text, marginBottom: 8 }}>
              Sin membresía activa
            </Text>
            <Text style={{ fontSize: 14, lineHeight: 21, color: C.textSub, marginBottom: 8 }}>
              Este miembro no tiene una suscripción activa.
            </Text>
            {lastPaymentSummary ? (
              <InfoRow label="Último pago registrado" value={lastPaymentSummary} />
            ) : null}
          </>
        )}

        {showActions ? (
          <View style={{ marginTop: 24, gap: 10 }}>
            {showCheckout ? (
              <BrandButton
                label="Generar link de pago"
                accentColor={primaryColor}
                onPress={() =>
                  router.push(
                    staffSalesHref({ memberUserId: userId, initialStep: 3, from: 'profile' }),
                  )
                }
              />
            ) : null}
            <BrandButton
              label={currentMemberships.length > 0 ? 'Renovar, cambiar o agregar plan' : 'Iniciar venta'}
              accentColor={primaryColor}
              variant={showCheckout ? 'ghost' : undefined}
              onPress={() =>
                router.push(staffSalesHref({ memberUserId: userId, initialStep: 2, from: 'profile' }))
              }
            />
            {showCash ? (
              <BrandButton
                label="Registrar pago en efectivo"
                accentColor={primaryColor}
                variant="ghost"
                onPress={() =>
                  router.push(staffSalesHref({ memberUserId: userId, initialStep: 4, from: 'profile' }))
                }
              />
            ) : null}
          </View>
        ) : (
          <Text style={{ fontSize: 13, color: C.textMute, marginTop: 20, lineHeight: 19 }}>
            Resumen de facturación — solo lectura.
          </Text>
        )}
      </Animated.View>

      <Text
        style={{
          fontSize: 11,
          fontWeight: '700',
          letterSpacing: 1.2,
          textTransform: 'uppercase',
          color: C.textMute,
          marginBottom: 14,
          marginTop: 28,
        }}
      >
        Historial de pagos
      </Text>

      <Animated.View entering={FadeInDown.delay(animationDelay + 40).duration(380)} style={cardStyle(C)}>
        {payments?.length ? (
          payments.map((p, i) => <PaymentHistoryRow key={p.id} payment={p} index={i} />)
        ) : paymentsError ? (
          <Text style={{ fontSize: 14, color: C.textMute, lineHeight: 20 }}>
            Historial de pagos no disponible.
          </Text>
        ) : (
          <Text style={{ fontSize: 14, color: C.textMute, lineHeight: 20 }}>
            Sin pagos registrados.
          </Text>
        )}
      </Animated.View>
    </>
  );
}
