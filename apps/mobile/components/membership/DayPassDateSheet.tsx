import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BrandButton } from '@/components/BrandButton';
import { getColors } from '@/constants/Theme';
import type { DayPassPurchaseWindowDto } from '@/lib/api/dayPassesApi';
import {
  DAY_PASS_DATE_COPY,
  buildCalendarMonths,
  buildQuickDateOptions,
  evaluateSelection,
  formatDayKeyLong,
  formatDayPassPrice,
  ownedDateLine,
  relativeDayLabel,
  requestedDayUnavailableLine,
} from '@/lib/dayPassDates';

/**
 * Membresía → Comprar pase diario → [this sheet: choose a day → review] → Stripe PaymentSheet.
 *
 * Pure JS (no native date picker), so it ships over the air. Every day shown comes from the
 * server's purchase window (studio-local today, horizon, already-owned days); the device clock
 * is never consulted. Nothing is created on the server while this sheet is open: checkout only
 * starts when the member confirms the reviewed day with "Continuar al pago".
 */

type Step = 'choose' | 'review';

type Props = {
  visible: boolean;
  window: DayPassPurchaseWindowDto;
  priceCents: number;
  currency: string;
  /** Pre-selected day (e.g. arriving from a class on that day). Falls back to today. */
  initialDayKey?: string | null;
  primaryColor: string;
  confirmBusy: boolean;
  onConfirm: (dayKey: string) => void;
  onCancel: () => void;
};

const WEEKDAY_HEADERS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

export function DayPassDateSheet({
  visible,
  window,
  priceCents,
  currency,
  initialDayKey,
  primaryColor,
  confirmBusy,
  onConfirm,
  onCancel,
}: Props) {
  const C = getColors();
  const insets = useSafeAreaInsets();
  const requestedInWindow = !!initialDayKey && initialDayKey >= window.todayKey && initialDayKey <= window.maxDateKey;
  const requestedUnavailable = !!initialDayKey && !requestedInWindow;
  const startKey = requestedInWindow ? initialDayKey : window.todayKey;
  const [selectedDayKey, setSelectedDayKey] = useState(startKey);
  const [step, setStep] = useState<Step>('choose');

  // Re-arm when the sheet is (re)opened with a different window or pre-selection.
  useEffect(() => {
    if (visible) {
      setSelectedDayKey(startKey);
      setStep('choose');
    }
  }, [visible, startKey]);

  const quick = useMemo(() => buildQuickDateOptions(window), [window]);
  const months = useMemo(() => buildCalendarMonths(window), [window]);
  const selection = evaluateSelection(selectedDayKey, window);
  const selectedLabel = formatDayKeyLong(selectedDayKey, window.timezone);
  const priceStr = formatDayPassPrice(priceCents, currency);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel} statusBarTranslucent>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cerrar"
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
            paddingTop: 24,
            paddingBottom: 20 + insets.bottom,
            maxHeight: '88%',
          }}
        >
          {step === 'choose' ? (
            <>
              <Text style={{ fontSize: 24, fontWeight: '800', letterSpacing: -0.7, color: C.text, marginBottom: 8 }}>
                {DAY_PASS_DATE_COPY.pickerTitle}
              </Text>
              <Text style={{ fontSize: 14, color: C.textSub, lineHeight: 21, marginBottom: requestedUnavailable ? 8 : 18 }}>
                {DAY_PASS_DATE_COPY.pickerBody}
              </Text>
              {requestedUnavailable ? (
                <Text style={{ fontSize: 13, color: C.caution, lineHeight: 19, marginBottom: 14 }}>
                  {requestedDayUnavailableLine(window.maxDateKey, window.timezone)}
                </Text>
              ) : null}

              <ScrollView
                showsVerticalScrollIndicator={false}
                style={{ flexGrow: 0 }}
                contentContainerStyle={{ paddingBottom: 8 }}
              >
                {/* Quick picks: Hoy, Mañana, next days */}
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 4 }}>
                  {quick.map((opt) => {
                    const selected = opt.dayKey === selectedDayKey;
                    return (
                      <Pressable
                        key={opt.dayKey}
                        accessibilityRole="button"
                        accessibilityState={{ selected, disabled: opt.owned }}
                        accessibilityLabel={`${opt.label} ${opt.sublabel}${opt.owned ? ', ya tienes pase' : ''}`}
                        onPress={() => setSelectedDayKey(opt.dayKey)}
                        style={{
                          minWidth: 64,
                          paddingVertical: 10,
                          paddingHorizontal: 12,
                          borderRadius: 14,
                          alignItems: 'center',
                          backgroundColor: selected ? '#FFFFFF' : 'rgba(255,255,255,0.05)',
                          borderWidth: 1,
                          borderColor: selected ? '#FFFFFF' : C.separator,
                          opacity: opt.owned && !selected ? 0.55 : 1,
                        }}
                      >
                        <Text style={{ fontSize: 11, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: selected ? '#000' : C.textMute }}>
                          {opt.label}
                        </Text>
                        <Text style={{ fontSize: 18, fontWeight: '800', letterSpacing: -0.5, color: selected ? '#000' : C.text, marginTop: 2 }}>
                          {opt.sublabel}
                        </Text>
                        {opt.owned ? (
                          <View style={{ width: 5, height: 5, borderRadius: 2.5, backgroundColor: selected ? '#000' : C.positive, marginTop: 4 }} />
                        ) : (
                          <View style={{ height: 9 }} />
                        )}
                      </Pressable>
                    );
                  })}
                </ScrollView>

                {/* Calendar for the whole window */}
                {months.map((m) => (
                  <View key={m.monthLabel} style={{ marginTop: 18 }}>
                    <Text style={{ fontSize: 12, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', color: C.textMute, marginBottom: 10 }}>
                      {m.monthLabel}
                    </Text>
                    <View style={{ flexDirection: 'row', marginBottom: 4 }}>
                      {WEEKDAY_HEADERS.map((h, i) => (
                        <Text key={`${h}-${i}`} style={{ flex: 1, textAlign: 'center', fontSize: 10, fontWeight: '700', color: C.textMute }}>
                          {h}
                        </Text>
                      ))}
                    </View>
                    {m.weeks.map((week, wi) => (
                      <View key={wi} style={{ flexDirection: 'row' }}>
                        {week.map((cell, ci) => {
                          if (!cell) return <View key={`pad-${ci}`} style={{ flex: 1, height: 42 }} />;
                          const selected = cell.dayKey === selectedDayKey;
                          return (
                            <Pressable
                              key={cell.dayKey}
                              disabled={!cell.selectable}
                              accessibilityRole="button"
                              accessibilityState={{ selected, disabled: !cell.selectable }}
                              accessibilityLabel={`${formatDayKeyLong(cell.dayKey, window.timezone)}${cell.owned ? ', ya tienes pase' : ''}`}
                              onPress={() => setSelectedDayKey(cell.dayKey)}
                              style={{ flex: 1, height: 42, alignItems: 'center', justifyContent: 'center' }}
                            >
                              <View
                                style={{
                                  width: 36,
                                  height: 36,
                                  borderRadius: 18,
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  backgroundColor: selected ? '#FFFFFF' : 'transparent',
                                  borderWidth: !selected && cell.isToday ? 1.5 : 0,
                                  borderColor: 'rgba(255,255,255,0.45)',
                                }}
                              >
                                <Text
                                  style={{
                                    fontSize: 15,
                                    fontWeight: selected || cell.isToday ? '800' : '500',
                                    color: selected ? '#000' : cell.selectable ? C.text : C.textMute,
                                    opacity: cell.selectable ? 1 : 0.35,
                                  }}
                                >
                                  {cell.dayOfMonth}
                                </Text>
                                {cell.owned ? (
                                  <View style={{ position: 'absolute', bottom: 3, width: 4, height: 4, borderRadius: 2, backgroundColor: selected ? '#000' : C.positive }} />
                                ) : null}
                              </View>
                            </Pressable>
                          );
                        })}
                      </View>
                    ))}
                  </View>
                ))}
              </ScrollView>

              {/* Selection summary / owned notice */}
              <View style={{ marginTop: 14, borderRadius: 16, borderWidth: 1, borderColor: C.separator, backgroundColor: 'rgba(255,255,255,0.04)', paddingVertical: 12, paddingHorizontal: 16 }}>
                {selection.kind === 'owned' ? (
                  <>
                    <Text style={{ fontSize: 14, fontWeight: '700', color: C.positive }}>{DAY_PASS_DATE_COPY.ownedTitle}</Text>
                    <Text style={{ fontSize: 13, color: C.textSub, marginTop: 4, lineHeight: 19 }}>
                      {ownedDateLine(selectedDayKey, window.todayKey, window.timezone)}
                    </Text>
                  </>
                ) : (
                  <>
                    <Text style={{ fontSize: 11, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', color: C.textMute }}>
                      {relativeDayLabel(selectedDayKey, window.todayKey)}
                    </Text>
                    <Text style={{ fontSize: 16, fontWeight: '700', color: C.text, marginTop: 2 }}>{selectedLabel}</Text>
                  </>
                )}
              </View>

              <View style={{ marginTop: 16, gap: 10 }}>
                <BrandButton
                  label="Continuar"
                  accentColor={primaryColor}
                  onPress={() => setStep('review')}
                  disabled={selection.kind !== 'ok'}
                />
                <Pressable accessibilityRole="button" onPress={onCancel} hitSlop={8} style={{ alignItems: 'center', paddingVertical: 6 }}>
                  <Text style={{ fontSize: 15, fontWeight: '600', color: C.textSub }}>Cancelar</Text>
                </Pressable>
              </View>
            </>
          ) : (
            <>
              <Text style={{ fontSize: 24, fontWeight: '800', letterSpacing: -0.7, color: C.text, marginBottom: 8 }}>
                {DAY_PASS_DATE_COPY.reviewTitle}
              </Text>
              <Text style={{ fontSize: 14, color: C.textSub, lineHeight: 21 }}>{DAY_PASS_DATE_COPY.pickerBody}</Text>

              <View style={{ marginTop: 18, borderRadius: 16, borderWidth: 1, borderColor: C.separator, backgroundColor: 'rgba(255,255,255,0.04)', paddingVertical: 16, paddingHorizontal: 16, gap: 6 }}>
                <Text style={{ fontSize: 11, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', color: C.textMute }}>
                  {DAY_PASS_DATE_COPY.productName}
                </Text>
                <Text style={{ fontSize: 20, fontWeight: '800', letterSpacing: -0.5, color: C.text }}>{selectedLabel}</Text>
                <Text style={{ fontSize: 28, fontWeight: '800', letterSpacing: -1, color: C.text, marginTop: 6 }}>
                  {priceStr}
                </Text>
              </View>

              <View style={{ marginTop: 20, gap: 10 }}>
                <BrandButton
                  label={confirmBusy ? 'Abriendo…' : DAY_PASS_DATE_COPY.continueToPayment}
                  accentColor={primaryColor}
                  onPress={() => onConfirm(selectedDayKey)}
                  disabled={confirmBusy}
                />
                <Pressable accessibilityRole="button" onPress={() => setStep('choose')} hitSlop={8} disabled={confirmBusy} style={{ alignItems: 'center', paddingVertical: 6 }}>
                  <Text style={{ fontSize: 15, fontWeight: '600', color: C.textSub }}>{DAY_PASS_DATE_COPY.chooseAnotherDate}</Text>
                </Pressable>
              </View>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
