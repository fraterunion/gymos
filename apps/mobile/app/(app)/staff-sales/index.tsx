import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { ComponentProps } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Share,
  Text,
  TextInput,
  View,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BrandButton } from '@/components/BrandButton';
import { Field } from '@/components/Field';
import { ScreenLoader } from '@/components/StudioScreenChrome';
import { useAuth } from '@/contexts/AuthContext';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import {
  fetchMembers,
  memberDisplayName,
  type MemberListItem,
} from '@/lib/api/membersDirectoryApi';
import { fetchMemberProfile } from '@/lib/api/memberProfileApi';
import {
  fetchMembershipPlans,
  type BillingInterval,
  type MembershipPlanDto,
} from '@/lib/api/membershipApi';
import {
  createOfflineSubscription,
  createStaffCheckoutSession,
  createWalkInMember,
  fetchSalesSettings,
  type SalesSettings,
} from '@/lib/api/salesApi';
import {
  attestMemberWaiver,
  fetchMemberWaiverStatus,
  waiverStatusLabel,
  type MemberWaiverStatusDto,
} from '@/lib/api/waiverApi';
import { resolveAresPlanBenefits, resolveAresPricePerClassLabel } from '@/lib/aresMembershipPlans';
import { formatMoneyFromCents } from '@/lib/formatMoney';
import {
  canAccessSales,
  canCreateWalkInMember,
  canIssueStaffCheckout,
  canRecordCashSales,
} from '@/lib/salesPermissions';
import { copyTextToClipboard } from '@/lib/copyToClipboard';
import { memberProfileHref } from '@/lib/memberProfileRoutes';
import { canAttestMemberWaiver } from '@/lib/waiverPermissions';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';
import { getColors, Space, type ThemeColors } from '@/constants/Theme';

type Step = 1 | 2 | 3 | 4 | 5;
type MemberMode = 'search' | 'create';
type PaymentMethodChoice = 'stripe' | 'cash';
type PaymentOutcome = 'pending' | 'succeeded' | null;

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

function generateTempPassword(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 12; i += 1) {
    s += chars[Math.floor(Math.random() * chars.length)]!;
  }
  return s;
}

function billingIntervalLabel(interval: BillingInterval): string {
  switch (interval) {
    case 'MONTHLY':
      return 'mes';
    case 'YEARLY':
      return 'año';
    case 'WEEKLY':
      return 'semana';
  }
}

function defaultPeriodEnd(startIso: string, interval: BillingInterval): string {
  const start = new Date(startIso);
  const end = new Date(start);
  if (interval === 'MONTHLY') end.setMonth(end.getMonth() + 1);
  else if (interval === 'YEARLY') end.setFullYear(end.getFullYear() + 1);
  else end.setDate(end.getDate() + 7);
  return end.toISOString().slice(0, 10);
}

const STEP_LABELS = ['Cliente', 'Carta responsiva', 'Plan', 'Pago', 'Confirmación'] as const;

function StepIndicator({ step }: { step: Step }) {
  const C = getColors();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8, paddingVertical: 4 }}
      style={{ marginBottom: 24 }}
    >
      {STEP_LABELS.map((label, i) => {
        const n = (i + 1) as Step;
        const active = step === n;
        const done = step > n;
        return (
          <View
            key={label}
            style={{
              borderRadius: 999,
              paddingHorizontal: 14,
              paddingVertical: 8,
              backgroundColor: active ? C.text : done ? 'rgba(16,185,129,0.15)' : 'rgba(255,255,255,0.06)',
              borderWidth: 1,
              borderColor: active ? C.text : done ? 'rgba(16,185,129,0.35)' : C.separator,
            }}
          >
            <Text
              style={{
                fontSize: 12,
                fontWeight: '700',
                color: active ? '#0A0A0A' : done ? '#34D399' : C.textMute,
              }}
            >
              {n}. {label}
            </Text>
          </View>
        );
      })}
    </ScrollView>
  );
}

function SectionTitle({ children }: { children: string }) {
  const C = getColors();
  return (
    <Text
      style={{
        fontSize: 22,
        fontWeight: '800',
        letterSpacing: -0.5,
        color: C.text,
        marginBottom: 8,
      }}
    >
      {children}
    </Text>
  );
}

function ModeToggle({
  mode,
  onChange,
  canCreate,
}: {
  mode: MemberMode;
  onChange: (m: MemberMode) => void;
  canCreate: boolean;
}) {
  const C = getColors();
  return (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: 'rgba(255,255,255,0.05)',
        borderRadius: 16,
        padding: 4,
        marginBottom: 20,
      }}
    >
      {(
        [
          { id: 'search' as const, label: 'Buscar' },
          { id: 'create' as const, label: 'Nuevo', disabled: !canCreate },
        ] as const
      ).map((opt) => {
        const selected = mode === opt.id;
        const disabled = 'disabled' in opt && opt.disabled;
        return (
          <Pressable
            key={opt.id}
            accessibilityRole="button"
            disabled={disabled}
            onPress={() => onChange(opt.id)}
            style={{
              flex: 1,
              borderRadius: 12,
              paddingVertical: 12,
              alignItems: 'center',
              backgroundColor: selected ? C.text : 'transparent',
              opacity: disabled ? 0.4 : 1,
            }}
          >
            <Text
              style={{
                fontSize: 14,
                fontWeight: '700',
                color: selected ? '#0A0A0A' : C.textSub,
              }}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function MemberResultRow({
  member,
  onSelect,
  onViewProfile,
}: {
  member: MemberListItem;
  onSelect: () => void;
  onViewProfile: () => void;
}) {
  const C = getColors();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        borderBottomWidth: 1,
        borderBottomColor: C.separator,
      }}
    >
      <Pressable
        accessibilityRole="button"
        onPress={onSelect}
        style={{
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
          paddingVertical: 16,
          gap: 14,
        }}
      >
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: 'rgba(255,255,255,0.08)',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ fontSize: 16, fontWeight: '800', color: C.text }}>
            {member.user.firstName.charAt(0)}
            {member.user.lastName.charAt(0)}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: C.text, letterSpacing: -0.2 }}>
            {memberDisplayName(member)}
          </Text>
          <Text style={{ fontSize: 13, color: C.textMute, marginTop: 2 }}>{member.user.email}</Text>
          {member.user.phone ? (
            <Text style={{ fontSize: 13, color: C.textMute, marginTop: 2 }}>{member.user.phone}</Text>
          ) : null}
        </View>
        <FontAwesome name="chevron-right" size={14} color={C.textMute} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Ver perfil"
        onPress={onViewProfile}
        hitSlop={10}
        style={{
          paddingVertical: 16,
          paddingHorizontal: 12,
          marginRight: 4,
        }}
      >
        <FontAwesome name="user-circle-o" size={22} color={C.textSub} />
      </Pressable>
    </View>
  );
}

function SalesPlanCard({
  plan,
  selected,
  onSelect,
  index,
}: {
  plan: MembershipPlanDto;
  selected: boolean;
  onSelect: () => void;
  index: number;
}) {
  const C = getColors();
  const { primaryColor } = useBranding();
  const accent = primaryColor;
  const benefits = resolveAresPlanBenefits(plan.name);
  const perClass = resolveAresPricePerClassLabel(plan);
  const priceLabel = formatMoneyFromCents(plan.priceCents, plan.currency);

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onSelect}
      style={{
        marginBottom: 16,
        borderRadius: 28,
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? accent : C.separator,
        backgroundColor: CARD_BG,
        overflow: 'hidden',
      }}
    >
      <View style={{ padding: 24 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text
              style={{
                fontSize: 11,
                fontWeight: '700',
                letterSpacing: 1,
                textTransform: 'uppercase',
                color: accent,
                marginBottom: 8,
              }}
            >
              Plan {index + 1}
            </Text>
            <Text
              style={{
                fontSize: 24,
                fontWeight: '800',
                letterSpacing: -0.6,
                color: C.text,
                lineHeight: 28,
              }}
            >
              {plan.name}
            </Text>
          </View>
          <View
            style={{
              width: 28,
              height: 28,
              borderRadius: 14,
              borderWidth: 2,
              borderColor: selected ? accent : C.separator,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: selected ? accent : 'transparent',
            }}
          >
            {selected ? <FontAwesome name="check" size={14} color="#0A0A0A" /> : null}
          </View>
        </View>

        <View style={{ marginTop: 20, marginBottom: 16 }}>
          <Text style={{ fontSize: 36, fontWeight: '800', letterSpacing: -1.2, color: C.text }}>
            {priceLabel}
          </Text>
          <Text style={{ fontSize: 14, color: C.textMute, marginTop: 4 }}>
            por {billingIntervalLabel(plan.billingInterval)}
            {perClass ? ` · ${perClass}` : ''}
          </Text>
        </View>

        {plan.description ? (
          <Text style={{ fontSize: 14, lineHeight: 21, color: C.textSub, marginBottom: 16 }}>
            {plan.description}
          </Text>
        ) : null}

        {benefits.length > 0 ? (
          <View style={{ gap: 8 }}>
            {benefits.slice(0, 4).map((b) => (
              <View key={b} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
                <Text style={{ color: accent, fontSize: 13, marginTop: 2 }}>✓</Text>
                <Text style={{ flex: 1, fontSize: 14, lineHeight: 20, color: C.textSub }}>{b}</Text>
              </View>
            ))}
          </View>
        ) : null}

        <View
          style={{
            marginTop: 16,
            paddingTop: 16,
            borderTopWidth: 1,
            borderTopColor: C.separator,
          }}
        >
          <Text style={{ fontSize: 12, color: C.textMute, lineHeight: 18 }}>
            La inscripción y promociones activas se aplican al pagar con Stripe.
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

function PaymentMethodChip({
  label,
  selected,
  onPress,
  icon,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  icon: ComponentProps<typeof FontAwesome>['name'];
}) {
  const C = getColors();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={{
        flex: 1,
        borderRadius: 20,
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? C.text : C.separator,
        backgroundColor: selected ? 'rgba(255,255,255,0.08)' : CARD_BG,
        padding: 18,
        alignItems: 'center',
        gap: 10,
      }}
    >
      <FontAwesome name={icon} size={22} color={selected ? C.text : C.textMute} />
      <Text
        style={{
          fontSize: 13,
          fontWeight: '700',
          textAlign: 'center',
          color: selected ? C.text : C.textSub,
          lineHeight: 18,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export default function StaffSalesScreen() {
  const router = useRouter();
  const salesParams = useLocalSearchParams<{
    memberUserId?: string;
    initialStep?: string;
    from?: string;
  }>();
  const C = getColors();
  const { primaryColor } = useBranding();
  const { user } = useAuth();
  const { matched } = useMemberStudio();
  const studioId = matched?.studio.id ?? '';
  const role = matched?.role ?? null;
  const isOwner = role === 'OWNER';

  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [salesSettings, setSalesSettings] = useState<SalesSettings | null>(null);

  const [step, setStep] = useState<Step>(1);
  const [memberMode, setMemberMode] = useState<MemberMode>('search');

  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<MemberListItem[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  const [createForm, setCreateForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
  });
  const [createdTempPassword, setCreatedTempPassword] = useState<string | null>(null);
  const [showTempPasswordOnce, setShowTempPasswordOnce] = useState(false);
  const [tempPasswordCopied, setTempPasswordCopied] = useState(false);
  const [membershipCheckHint, setMembershipCheckHint] = useState<string | null>(null);

  const [selectedMember, setSelectedMember] = useState<MemberListItem | null>(null);
  const [waiverStatus, setWaiverStatus] = useState<MemberWaiverStatusDto | null>(null);
  const [waiverLoading, setWaiverLoading] = useState(false);
  const [attestNote, setAttestNote] = useState('');
  const [attesting, setAttesting] = useState(false);

  const [plans, setPlans] = useState<MembershipPlanDto[]>([]);
  const [plansLoading, setPlansLoading] = useState(false);
  const [selectedPlanId, setSelectedPlanId] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodChoice>('stripe');

  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [cashNotes, setCashNotes] = useState('');
  const [priceOverrideNote, setPriceOverrideNote] = useState('');
  const [periodStart] = useState(() => new Date().toISOString().slice(0, 10));
  const [periodEnd, setPeriodEnd] = useState('');
  const [activeUntil, setActiveUntil] = useState<string | null>(null);
  const [paymentOutcome, setPaymentOutcome] = useState<PaymentOutcome>(null);
  const [checkingPayment, setCheckingPayment] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deepLinkHandled, setDeepLinkHandled] = useState(false);

  const allowed = canAccessSales(role);
  const canCreate = canCreateWalkInMember(role, salesSettings);
  const canCheckout = canIssueStaffCheckout(role, salesSettings);
  const canCash = canRecordCashSales(role, salesSettings);
  const canAttestWaiver = canAttestMemberWaiver(role);

  const selectedPlan = useMemo(
    () => plans.find((p) => p.id === selectedPlanId) ?? null,
    [plans, selectedPlanId],
  );

  const waiverOk = !waiverStatus?.required || waiverStatus.accepted;
  const cashBlockedByWaiver = paymentMethod === 'cash' && !waiverOk;

  useEffect(() => {
    if (!studioId || !allowed) return;
    fetchSalesSettings(studioId)
      .then(setSalesSettings)
      .catch(() =>
        setSalesSettings({
          frontDeskCanCreateMember: true,
          frontDeskCanIssueCheckout: true,
          frontDeskCanRecordCash: false,
        }),
      )
      .finally(() => setSettingsLoaded(true));
  }, [studioId, allowed]);

  useEffect(() => {
    if (!studioId || !allowed) return;
    setPlansLoading(true);
    fetchMembershipPlans(studioId)
      .then((rows) => setPlans(rows.filter((p) => p.active)))
      .catch(() => setPlans([]))
      .finally(() => setPlansLoading(false));
  }, [studioId, allowed]);

  useEffect(() => {
    if (!canCreate && memberMode === 'create') {
      setMemberMode('search');
    }
  }, [canCreate, memberMode]);

  useEffect(() => {
    if (!canCheckout && paymentMethod === 'stripe' && canCash) {
      setPaymentMethod('cash');
    }
  }, [canCheckout, canCash, paymentMethod]);

  useEffect(() => {
    if (!selectedPlan) return;
    setPeriodEnd(defaultPeriodEnd(periodStart, selectedPlan.billingInterval));
  }, [selectedPlan, periodStart]);

  const loadWaiver = useCallback(async (userId: string) => {
    if (!studioId) return;
    setWaiverLoading(true);
    setError(null);
    try {
      const status = await fetchMemberWaiverStatus(studioId, userId);
      setWaiverStatus(status);
    } catch (e) {
      setError(userFacingApiMessage(e, 'No se pudo cargar la carta responsiva'));
    } finally {
      setWaiverLoading(false);
    }
  }, [studioId]);

  const runSearch = useCallback(async () => {
    if (!studioId || !search.trim()) return;
    setSearchLoading(true);
    setError(null);
    setHasSearched(true);
    try {
      const res = await fetchMembers(studioId, {
        role: 'MEMBER',
        search: search.trim(),
        limit: 20,
      });
      setSearchResults(res.data);
    } catch (e) {
      setError(userFacingApiMessage(e, 'Error al buscar clientes'));
    } finally {
      setSearchLoading(false);
    }
  }, [studioId, search]);

  const selectExistingMember = useCallback(
    (member: MemberListItem) => {
      setSelectedMember(member);
      setCreatedTempPassword(null);
      void loadWaiver(member.user.id);
      setStep(2);
    },
    [loadWaiver],
  );

  useEffect(() => {
    if (!studioId || !allowed || deepLinkHandled) return;
    const uid =
      typeof salesParams.memberUserId === 'string' ? salesParams.memberUserId.trim() : '';
    if (!uid) return;

    setDeepLinkHandled(true);
    fetchMemberProfile(studioId, uid)
      .then((p) => {
        const pseudo: MemberListItem = {
          membershipId: p.membership.id,
          role: 'MEMBER',
          joinedAt: p.membership.createdAt,
          user: p.user,
          totalBookings: p.bookingStats.totalBookings,
          noShowCount: p.bookingStats.noShowCount,
          lastAttendanceAt: null,
          subscription: p.activeSubscription
            ? {
                id: p.activeSubscription.id,
                status: p.activeSubscription.status,
                planName: p.activeSubscription.plan.name,
                planId: p.activeSubscription.plan.id,
                currentPeriodEnd: p.activeSubscription.currentPeriodEnd,
                cancelAtPeriodEnd: p.activeSubscription.cancelAtPeriodEnd,
              }
            : null,
        };
        setSelectedMember(pseudo);
        void loadWaiver(uid);
        const stepNum = salesParams.initialStep
          ? parseInt(String(salesParams.initialStep), 10)
          : 2;
        if (stepNum >= 1 && stepNum <= 5) setStep(stepNum as Step);
      })
      .catch((e) => setError(userFacingApiMessage(e, 'No se pudo cargar el cliente')));
  }, [
    allowed,
    deepLinkHandled,
    loadWaiver,
    salesParams.initialStep,
    salesParams.memberUserId,
    studioId,
  ]);

  async function handleCreateMember() {
    if (!studioId) return;
    const tempPassword = generateTempPassword();
    setBusy(true);
    setError(null);
    try {
      const created = await createWalkInMember(studioId, {
        email: createForm.email.trim(),
        firstName: createForm.firstName.trim(),
        lastName: createForm.lastName.trim(),
        phone: createForm.phone.trim() || undefined,
        temporaryPassword: tempPassword,
      });
      const asListItem: MemberListItem = {
        membershipId: created.membership.id,
        role: 'MEMBER',
        joinedAt: created.membership.createdAt,
        user: created.user,
        totalBookings: 0,
        noShowCount: 0,
        lastAttendanceAt: null,
        subscription: null,
      };
      setSelectedMember(asListItem);
      setCreatedTempPassword(tempPassword);
      setShowTempPasswordOnce(true);
      setTempPasswordCopied(false);
      await loadWaiver(created.user.id);
      setStep(2);
    } catch (e) {
      setError(userFacingApiMessage(e, 'No se pudo crear el cliente'));
    } finally {
      setBusy(false);
    }
  }

  async function handleAttest() {
    if (!studioId || !selectedMember || !waiverStatus?.activeWaiverDocumentId || !canAttestWaiver) return;
    setAttesting(true);
    setError(null);
    try {
      await attestMemberWaiver(studioId, selectedMember.user.id, {
        waiverDocumentId: waiverStatus.activeWaiverDocumentId,
        attestationNote: attestNote.trim() || undefined,
      });
      await loadWaiver(selectedMember.user.id);
      setAttestNote('');
    } catch (e) {
      setError(userFacingApiMessage(e, 'No se pudo registrar la firma'));
    } finally {
      setAttesting(false);
    }
  }

  function dismissTempPassword() {
    setShowTempPasswordOnce(false);
    setCreatedTempPassword(null);
  }

  async function copyTempPassword() {
    if (!createdTempPassword) return;
    const ok = await copyTextToClipboard(createdTempPassword);
    if (ok) setTempPasswordCopied(true);
  }

  function advanceFromWaiverStep() {
    dismissTempPassword();
    setStep(3);
  }

  async function handleGenerateCheckout() {
    if (!studioId || !selectedMember || !selectedPlanId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createStaffCheckoutSession(studioId, selectedMember.user.id, selectedPlanId);
      setCheckoutUrl(res.checkoutUrl);
      setPaymentOutcome('pending');
      setActiveUntil(null);
      setMembershipCheckHint(null);
      setStep(5);
    } catch (e) {
      setError(userFacingApiMessage(e, 'No se pudo generar el link de pago'));
    } finally {
      setBusy(false);
    }
  }

  async function handleRecordCash() {
    if (!studioId || !selectedMember || !selectedPlan) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createOfflineSubscription(studioId, selectedMember.user.id, {
        planId: selectedPlan.id,
        amountCents: selectedPlan.priceCents,
        periodStart: new Date(`${periodStart}T12:00:00`).toISOString(),
        periodEnd: new Date(`${periodEnd}T23:59:59`).toISOString(),
        paymentMethod: 'CASH',
        notes: cashNotes.trim() || undefined,
        priceOverrideNote: priceOverrideNote.trim() || undefined,
      });
      setCheckoutUrl(null);
      setActiveUntil(res.subscription.currentPeriodEnd);
      setPaymentOutcome('succeeded');
      setStep(5);
    } catch (e) {
      setError(userFacingApiMessage(e, 'No se pudo registrar el pago en efectivo'));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Best-effort membership lookup via member list — not a real-time Stripe poll.
   * Keeps pending unless an ACTIVE subscription for the selected plan is detected.
   */
  async function checkStripeMembershipStatus() {
    if (!studioId || !selectedMember) return;
    setCheckingPayment(true);
    setError(null);
    setMembershipCheckHint(null);
    try {
      const res = await fetchMembers(studioId, {
        role: 'MEMBER',
        search: selectedMember.user.email,
        limit: 5,
      });
      const match = res.data.find((m) => m.user.id === selectedMember.user.id);
      const sub = match?.subscription;
      if (sub?.status === 'ACTIVE' && sub.planId === selectedPlanId) {
        setPaymentOutcome('succeeded');
        setActiveUntil(sub.currentPeriodEnd);
        setMembershipCheckHint('Membresía activa detectada.');
      } else {
        setPaymentOutcome('pending');
        setMembershipCheckHint(
          'Aún no detectamos la membresía activa. El pago puede seguir procesándose en Stripe.',
        );
      }
    } catch (e) {
      setError(userFacingApiMessage(e, 'No se pudo consultar el estado de la membresía'));
    } finally {
      setCheckingPayment(false);
    }
  }

  function resetFlow() {
    setStep(1);
    setSelectedMember(null);
    setWaiverStatus(null);
    setSelectedPlanId('');
    setCheckoutUrl(null);
    setActiveUntil(null);
    setPaymentOutcome(null);
    setPaymentMethod('stripe');
    setCreatedTempPassword(null);
    setShowTempPasswordOnce(false);
    setTempPasswordCopied(false);
    setMembershipCheckHint(null);
    setSearch('');
    setSearchResults([]);
    setHasSearched(false);
    setCreateForm({ firstName: '', lastName: '', email: '', phone: '' });
    setError(null);
  }

  async function shareCheckoutUrl() {
    if (!checkoutUrl) return;
    await Share.share({
      message: checkoutUrl,
      url: checkoutUrl,
      title: 'Link de pago ARES',
    });
  }

  if (!allowed) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 32 }}>
          <Text style={{ textAlign: 'center', fontSize: 15, lineHeight: 22, color: C.textSub, marginBottom: 24 }}>
            No tienes permiso para acceder a ventas en recepción.
          </Text>
          <BrandButton label="Volver" accentColor={primaryColor} variant="ghost" onPress={() => router.back()} />
        </View>
      </SafeAreaView>
    );
  }

  if (!settingsLoaded) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <ScreenLoader />
      </SafeAreaView>
    );
  }

  const createValid =
    createForm.firstName.trim().length > 0 &&
    createForm.lastName.trim().length > 0 &&
    createForm.email.trim().includes('@');

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['left', 'right', 'bottom']}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: Space.screenH,
            paddingTop: 8,
            paddingBottom: 40,
          }}
          keyboardShouldPersistTaps="handled"
        >
          <StepIndicator step={step} />

          {error ? (
            <View
              style={{
                marginBottom: 20,
                borderRadius: 16,
                borderWidth: 1,
                borderColor: 'rgba(239,68,68,0.35)',
                backgroundColor: 'rgba(239,68,68,0.08)',
                padding: 16,
              }}
            >
              <Text style={{ fontSize: 14, lineHeight: 20, color: '#FCA5A5' }}>{error}</Text>
            </View>
          ) : null}

          {step === 1 ? (
            <Animated.View entering={FadeInDown.duration(350)}>
              <SectionTitle>Cliente</SectionTitle>
              <Text style={{ fontSize: 15, color: C.textSub, lineHeight: 22, marginBottom: 20 }}>
                Busca un miembro existente o registra un walk-in.
              </Text>

              <ModeToggle mode={memberMode} onChange={setMemberMode} canCreate={canCreate} />

              {memberMode === 'search' ? (
                <View style={cardStyle(C)}>
                  <Field
                    label="Buscar"
                    placeholder="Nombre o correo"
                    value={search}
                    onChangeText={setSearch}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="search"
                    onSubmitEditing={() => void runSearch()}
                  />
                  <BrandButton
                    label={searchLoading ? 'Buscando…' : 'Buscar cliente'}
                    accentColor={primaryColor}
                    onPress={() => void runSearch()}
                    disabled={searchLoading || !search.trim()}
                  />
                  {hasSearched && searchResults.length === 0 && !searchLoading ? (
                    <Text style={{ textAlign: 'center', color: C.textMute, fontSize: 14, marginTop: 8 }}>
                      No encontramos miembros con ese criterio.
                    </Text>
                  ) : null}
                  {searchResults.map((m) => (
                    <MemberResultRow
                      key={m.user.id}
                      member={m}
                      onSelect={() => selectExistingMember(m)}
                      onViewProfile={() =>
                        router.push(memberProfileHref(m.user.id, { from: 'sales' }))
                      }
                    />
                  ))}
                </View>
              ) : (
                <View style={cardStyle(C)}>
                  <Field
                    label="Nombre"
                    value={createForm.firstName}
                    onChangeText={(v) => setCreateForm((f) => ({ ...f, firstName: v }))}
                    autoCapitalize="words"
                  />
                  <Field
                    label="Apellido"
                    value={createForm.lastName}
                    onChangeText={(v) => setCreateForm((f) => ({ ...f, lastName: v }))}
                    autoCapitalize="words"
                  />
                  <Field
                    label="Correo"
                    value={createForm.email}
                    onChangeText={(v) => setCreateForm((f) => ({ ...f, email: v }))}
                    autoCapitalize="none"
                    keyboardType="email-address"
                  />
                  <Field
                    label="Teléfono"
                    value={createForm.phone}
                    onChangeText={(v) => setCreateForm((f) => ({ ...f, phone: v }))}
                    keyboardType="phone-pad"
                    helperText="Opcional"
                  />
                  <BrandButton
                    label={busy ? 'Creando…' : 'Crear cliente'}
                    accentColor={primaryColor}
                    onPress={() => void handleCreateMember()}
                    disabled={busy || !createValid}
                  />
                </View>
              )}
            </Animated.View>
          ) : null}

          {step === 2 && selectedMember ? (
            <Animated.View entering={FadeInDown.duration(350)}>
              <SectionTitle>Carta responsiva</SectionTitle>
              <View style={[cardStyle(C), { marginBottom: 16 }]}>
                <Text style={{ fontSize: 16, fontWeight: '700', color: C.text }}>
                  {memberDisplayName(selectedMember)}
                </Text>
                <Text style={{ fontSize: 14, color: C.textMute, marginTop: 4 }}>
                  {selectedMember.user.email}
                </Text>
                {showTempPasswordOnce && createdTempPassword ? (
                  <View
                    style={{
                      marginTop: 16,
                      padding: 14,
                      borderRadius: 14,
                      backgroundColor: 'rgba(245,158,11,0.08)',
                      borderWidth: 1,
                      borderColor: 'rgba(245,158,11,0.35)',
                    }}
                  >
                    <Text style={{ fontSize: 11, fontWeight: '700', color: '#FBBF24', marginBottom: 6 }}>
                      CONTRASEÑA TEMPORAL — SOLO SE MUESTRA UNA VEZ
                    </Text>
                    <Text selectable style={{ fontSize: 16, fontWeight: '700', color: C.text, letterSpacing: 1 }}>
                      {createdTempPassword}
                    </Text>
                    <Text style={{ fontSize: 12, color: C.textSub, marginTop: 10, lineHeight: 18 }}>
                      Compártelo solo con el cliente. Por seguridad, no lo guardes en notas ni chats.
                    </Text>
                    <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
                      <View style={{ flex: 1 }}>
                        <BrandButton
                          label={tempPasswordCopied ? 'Copiado' : 'Copiar contraseña'}
                          accentColor={primaryColor}
                          variant="ghost"
                          onPress={() => void copyTempPassword()}
                        />
                      </View>
                    </View>
                  </View>
                ) : null}
              </View>

              <View style={cardStyle(C)}>
                {waiverLoading ? (
                  <ActivityIndicator color={primaryColor} style={{ marginVertical: 20 }} />
                ) : waiverStatus ? (
                  <>
                    <View
                      style={{
                        alignSelf: 'flex-start',
                        borderRadius: 999,
                        paddingHorizontal: 14,
                        paddingVertical: 8,
                        backgroundColor: waiverOk ? 'rgba(16,185,129,0.15)' : 'rgba(245,158,11,0.15)',
                        marginBottom: 16,
                      }}
                    >
                      <Text
                        style={{
                          fontSize: 13,
                          fontWeight: '700',
                          color: waiverOk ? '#34D399' : '#FBBF24',
                        }}
                      >
                        {waiverStatusLabel(waiverStatus)}
                      </Text>
                    </View>

                    {!waiverOk && waiverStatus.activeWaiverDocumentId ? (
                      <View style={{ gap: 12 }}>
                        <Text style={{ fontSize: 14, lineHeight: 21, color: C.textSub }}>
                          Puedes continuar con link de pago Stripe. Para efectivo, registra la firma
                          presencial.
                        </Text>
                        {canAttestWaiver ? (
                          <>
                            <Field
                              label="Nota de attestation"
                              value={attestNote}
                              onChangeText={setAttestNote}
                              placeholder="Opcional"
                              multiline
                              style={{ minHeight: 72, textAlignVertical: 'top' }}
                            />
                            <BrandButton
                              label={attesting ? 'Registrando…' : 'Registrar firma presencial'}
                              accentColor={primaryColor}
                              variant="ghost"
                              onPress={() => void handleAttest()}
                              disabled={attesting}
                            />
                          </>
                        ) : (
                          <View
                            style={{
                              padding: 14,
                              borderRadius: 14,
                              backgroundColor: 'rgba(255,255,255,0.04)',
                              borderWidth: 1,
                              borderColor: C.separator,
                            }}
                          >
                            <Text style={{ fontSize: 14, lineHeight: 21, color: C.textSub }}>
                              Tu rol no puede registrar firma presencial. Pide apoyo a recepción o
                              administración, o continúa con pago Stripe.
                            </Text>
                          </View>
                        )}
                      </View>
                    ) : null}
                  </>
                ) : null}

                <View style={{ flexDirection: 'row', gap: 12, marginTop: 20 }}>
                  <View style={{ flex: 1 }}>
                    <BrandButton
                      label="Atrás"
                      accentColor={primaryColor}
                      variant="ghost"
                      onPress={() => {
                        dismissTempPassword();
                        setStep(1);
                      }}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <BrandButton label="Continuar" accentColor={primaryColor} onPress={advanceFromWaiverStep} />
                  </View>
                </View>
              </View>
            </Animated.View>
          ) : null}

          {step === 3 ? (
            <Animated.View entering={FadeInDown.duration(350)}>
              <SectionTitle>Seleccionar plan</SectionTitle>
              <Text style={{ fontSize: 15, color: C.textSub, lineHeight: 22, marginBottom: 20 }}>
                Elige la membresía para {selectedMember ? memberDisplayName(selectedMember) : 'el cliente'}.
              </Text>

              {plansLoading ? (
                <ActivityIndicator color={primaryColor} style={{ marginVertical: 32 }} />
              ) : plans.length === 0 ? (
                <View style={[cardStyle(C), { alignItems: 'center' }]}>
                  <Text style={{ fontSize: 15, color: C.textMute, textAlign: 'center' }}>
                    No hay planes activos disponibles.
                  </Text>
                </View>
              ) : (
                plans.map((plan, index) => (
                  <SalesPlanCard
                    key={plan.id}
                    plan={plan}
                    index={index}
                    selected={selectedPlanId === plan.id}
                    onSelect={() => setSelectedPlanId(plan.id)}
                  />
                ))
              )}

              <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
                <View style={{ flex: 1 }}>
                  <BrandButton
                    label="Atrás"
                    accentColor={primaryColor}
                    variant="ghost"
                    onPress={() => setStep(2)}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <BrandButton
                    label="Continuar"
                    accentColor={primaryColor}
                    onPress={() => setStep(4)}
                    disabled={!selectedPlanId}
                  />
                </View>
              </View>
            </Animated.View>
          ) : null}

          {step === 4 && selectedMember && selectedPlan ? (
            <Animated.View entering={FadeInDown.duration(350)}>
              <SectionTitle>Método de pago</SectionTitle>

              <View style={{ flexDirection: 'row', gap: 12, marginBottom: 24 }}>
                {canCheckout ? (
                  <PaymentMethodChip
                    label="Stripe QR / link"
                    icon="credit-card"
                    selected={paymentMethod === 'stripe'}
                    onPress={() => setPaymentMethod('stripe')}
                  />
                ) : null}
                {canCash ? (
                  <PaymentMethodChip
                    label="Efectivo"
                    icon="money"
                    selected={paymentMethod === 'cash'}
                    onPress={() => setPaymentMethod('cash')}
                  />
                ) : null}
              </View>

              {paymentMethod === 'stripe' ? (
                <View style={[cardStyle(C), { marginBottom: 20 }]}>
                  <Text style={{ fontSize: 15, lineHeight: 22, color: C.textSub }}>
                    Genera un link de pago. El cliente escanea el QR en su teléfono. La membresía se
                    activa automáticamente vía Stripe.
                  </Text>
                  <View style={{ marginTop: 16, paddingTop: 16, borderTopWidth: 1, borderTopColor: C.separator }}>
                    <Text style={{ fontSize: 13, color: C.textMute }}>
                      {selectedPlan.name} ·{' '}
                      {formatMoneyFromCents(selectedPlan.priceCents, selectedPlan.currency)} /{' '}
                      {billingIntervalLabel(selectedPlan.billingInterval)}
                    </Text>
                  </View>
                </View>
              ) : (
                <View style={[cardStyle(C), { marginBottom: 20, gap: 12 }]}>
                  <Text style={{ fontSize: 14, color: C.textMute }}>Monto</Text>
                  <Text style={{ fontSize: 28, fontWeight: '800', color: C.text }}>
                    {formatMoneyFromCents(selectedPlan.priceCents, selectedPlan.currency)}
                  </Text>
                  <Text style={{ fontSize: 13, color: C.textMute }}>
                    Periodo: {periodStart} → {periodEnd}
                  </Text>
                  {isOwner ? (
                    <Field
                      label="Nota override (OWNER)"
                      value={priceOverrideNote}
                      onChangeText={setPriceOverrideNote}
                    />
                  ) : null}
                  <Field
                    label="Notas"
                    value={cashNotes}
                    onChangeText={setCashNotes}
                    multiline
                    style={{ minHeight: 72, textAlignVertical: 'top' }}
                  />
                  {cashBlockedByWaiver ? (
                    <Text style={{ fontSize: 13, color: '#FBBF24', lineHeight: 18 }}>
                      Se requiere carta responsiva para registrar efectivo.
                    </Text>
                  ) : null}
                </View>
              )}

              <View style={{ flexDirection: 'row', gap: 12 }}>
                <View style={{ flex: 1 }}>
                  <BrandButton
                    label="Atrás"
                    accentColor={primaryColor}
                    variant="ghost"
                    onPress={() => setStep(3)}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <BrandButton
                    label={
                      busy
                        ? 'Procesando…'
                        : paymentMethod === 'stripe'
                          ? 'Generar pago'
                          : 'Registrar efectivo'
                    }
                    accentColor={primaryColor}
                    onPress={() =>
                      void (paymentMethod === 'stripe' ? handleGenerateCheckout() : handleRecordCash())
                    }
                    disabled={
                      busy ||
                      (paymentMethod === 'cash' && cashBlockedByWaiver) ||
                      (paymentMethod === 'stripe' && !canCheckout)
                    }
                  />
                </View>
              </View>
            </Animated.View>
          ) : null}

          {step === 5 && selectedMember && selectedPlan ? (
            <Animated.View entering={FadeInDown.duration(350)}>
              <SectionTitle>Confirmación</SectionTitle>

              <View style={[cardStyle(C), { marginBottom: 20, gap: 12 }]}>
                <Text style={{ fontSize: 11, fontWeight: '700', letterSpacing: 1, color: C.textMute }}>
                  RESUMEN
                </Text>
                <Text style={{ fontSize: 20, fontWeight: '800', color: C.text }}>
                  {memberDisplayName(selectedMember)}
                </Text>
                <Text style={{ fontSize: 15, color: C.textSub }}>{selectedPlan.name}</Text>
                <Text style={{ fontSize: 14, color: C.textMute }}>
                  {paymentMethod === 'stripe' ? 'Stripe · link / QR' : 'Efectivo registrado'}
                </Text>
                <View
                  style={{
                    alignSelf: 'flex-start',
                    borderRadius: 999,
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    backgroundColor:
                      paymentOutcome === 'succeeded'
                        ? 'rgba(16,185,129,0.15)'
                        : 'rgba(245,158,11,0.15)',
                  }}
                >
                  <Text
                    style={{
                      fontSize: 12,
                      fontWeight: '700',
                      color: paymentOutcome === 'succeeded' ? '#34D399' : '#FBBF24',
                    }}
                  >
                    {paymentOutcome === 'succeeded' ? 'Membresía activa' : 'Pago pendiente'}
                  </Text>
                </View>
                {paymentOutcome === 'pending' && checkoutUrl ? (
                  <Text style={{ fontSize: 14, lineHeight: 21, color: C.textSub }}>
                    Pago pendiente — la membresía se activará automáticamente cuando Stripe confirme el
                    pago.
                  </Text>
                ) : null}
                {membershipCheckHint ? (
                  <Text style={{ fontSize: 13, lineHeight: 19, color: C.textMute }}>{membershipCheckHint}</Text>
                ) : null}
                {activeUntil ? (
                  <Text style={{ fontSize: 14, color: C.textSub }}>
                    Activa hasta{' '}
                    {new Date(activeUntil).toLocaleDateString('es-MX', {
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric',
                    })}
                  </Text>
                ) : null}
              </View>

              {checkoutUrl ? (
                <View style={[cardStyle(C), { marginBottom: 20, alignItems: 'center' }]}>
                  <Text
                    style={{
                      fontSize: 11,
                      fontWeight: '700',
                      letterSpacing: 1,
                      color: C.textMute,
                      alignSelf: 'flex-start',
                      marginBottom: 16,
                    }}
                  >
                    QR DE PAGO
                  </Text>
                  <View
                    style={{
                      padding: 16,
                      borderRadius: 20,
                      backgroundColor: '#FFFFFF',
                      marginBottom: 20,
                    }}
                  >
                    <QRCode value={checkoutUrl} size={220} color="#0a0a0a" backgroundColor="#ffffff" />
                  </View>
                  <TextInput
                    value={checkoutUrl}
                    editable={false}
                    selectTextOnFocus
                    multiline
                    style={{
                      width: '100%',
                      borderRadius: 14,
                      borderWidth: 1,
                      borderColor: C.separator,
                      backgroundColor: '#1A1A1C',
                      padding: 14,
                      fontSize: 12,
                      color: C.textMute,
                      marginBottom: 12,
                    }}
                  />
                  <View style={{ flexDirection: 'row', gap: 12, width: '100%' }}>
                    <View style={{ flex: 1 }}>
                      <BrandButton
                        label="Compartir link"
                        accentColor={primaryColor}
                        variant="ghost"
                        onPress={() => void shareCheckoutUrl()}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <BrandButton
                        label={checkingPayment ? 'Consultando…' : 'Consultar membresía'}
                        accentColor={primaryColor}
                        variant="ghost"
                        onPress={() => void checkStripeMembershipStatus()}
                        disabled={checkingPayment}
                      />
                    </View>
                  </View>
                  <Text style={{ fontSize: 12, color: C.textMute, marginTop: 14, lineHeight: 18, textAlign: 'center' }}>
                    La consulta no garantiza confirmación en tiempo real. Stripe activará la membresía
                    automáticamente al completarse el pago.
                  </Text>
                </View>
              ) : null}

              <View style={{ gap: 12 }}>
                <BrandButton
                  label="Ver perfil del miembro"
                  accentColor={primaryColor}
                  variant="ghost"
                  onPress={() =>
                    router.push(memberProfileHref(selectedMember.user.id, { from: 'sales' }))
                  }
                />
                <BrandButton label="Nueva venta" accentColor={primaryColor} onPress={resetFlow} />
                <BrandButton
                  label="Listo"
                  accentColor={primaryColor}
                  variant="ghost"
                  onPress={() => router.back()}
                />
              </View>

              {user?.email ? (
                <Text style={{ fontSize: 11, color: C.textMute, marginTop: 24, textAlign: 'center' }}>
                  Operador: {user.email}
                </Text>
              ) : null}
            </Animated.View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
