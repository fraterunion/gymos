import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { getColors } from '@/constants/Theme';

/** Local calendar date, independent of the phone's timezone. */
export function studioTodayKey(timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const part = (kind: string) => parts.find((p) => p.type === kind)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function shiftMonth(key: string, delta: number) {
  const [year, month] = key.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1 + delta, 1)).toISOString().slice(0, 7);
}

export function PaymentDatePicker({
  dateKey,
  maxDateKey,
  onChange,
}: {
  dateKey: string;
  maxDateKey: string;
  onChange: (date: string) => void;
}) {
  const C = getColors();
  const [open, setOpen] = useState(false);
  const [monthKey, setMonthKey] = useState(dateKey.slice(0, 7));
  const [year, month] = monthKey.split('-').map(Number);
  const firstDow = new Date(Date.UTC(year!, month! - 1, 1)).getUTCDay();
  const emptySlots = (firstDow + 6) % 7;
  const days = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  const cells: Array<number | null> = [
    ...Array.from({ length: emptySlots }, () => null),
    ...Array.from({ length: days }, (_, i) => i + 1),
  ];
  const label = new Date(`${dateKey}T12:00:00Z`).toLocaleDateString('es-MX', {
    timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric',
  });
  const monthLabel = new Date(Date.UTC(year!, month! - 1, 15)).toLocaleDateString('es-MX', {
    timeZone: 'UTC', month: 'long', year: 'numeric',
  });
  return (
    <>
      <Text style={{ fontSize: 14, color: C.textSub, fontWeight: '600' }}>Fecha del pago</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Elegir fecha del pago: ${label}`}
        onPress={() => { setMonthKey(dateKey.slice(0, 7)); setOpen(true); }}
        style={{
          padding: 14, borderRadius: 12, borderWidth: 1,
          borderColor: C.separator, flexDirection: 'row',
          alignItems: 'center', justifyContent: 'space-between',
        }}
      >
        <Text style={{ color: C.text, fontSize: 15, textTransform: 'capitalize' }}>{label}</Text>
        <FontAwesome name="calendar" color={C.textSub} size={18} />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={{
          flex: 1, justifyContent: 'center', padding: 20,
          backgroundColor: 'rgba(0,0,0,0.82)',
        }}>
          <View style={{
            backgroundColor: '#171717', borderRadius: 20, padding: 20,
            borderWidth: 1, borderColor: C.separator,
          }}>
            <Text style={{ color: C.text, fontSize: 18, fontWeight: '700', marginBottom: 18 }}>
              Fecha en que recibiste el pago
            </Text>
            <View style={{
              flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
              marginBottom: 20,
            }}>
              <Pressable accessibilityRole="button" accessibilityLabel="Mes anterior"
                onPress={() => setMonthKey(shiftMonth(monthKey, -1))} style={{ padding: 10 }}>
                <FontAwesome name="chevron-left" color={C.text} size={16} />
              </Pressable>
              <Text style={{
                color: C.text, fontSize: 16, fontWeight: '700', textTransform: 'capitalize',
              }}>{monthLabel}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Mes siguiente"
                disabled={monthKey >= maxDateKey.slice(0, 7)}
                onPress={() => setMonthKey(shiftMonth(monthKey, 1))}
                style={{ padding: 10, opacity: monthKey >= maxDateKey.slice(0, 7) ? 0.25 : 1 }}>
                <FontAwesome name="chevron-right" color={C.text} size={16} />
              </Pressable>
            </View>
            <View style={{ flexDirection: 'row' }}>
              {['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((day, i) => (
                <Text key={i} style={{
                  width: '14.2857%', textAlign: 'center', color: C.textMute,
                  fontSize: 12, marginBottom: 10,
                }}>{day}</Text>
              ))}
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
              {cells.map((day, index) => {
                const key = day == null ? '' : `${monthKey}-${String(day).padStart(2, '0')}`;
                const disabled = key > maxDateKey;
                const selected = key === dateKey;
                return (
                  <View key={index} style={{ width: '14.2857%', padding: 2 }}>
                    {day == null ? null : (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Elegir ${key}`}
                        disabled={disabled}
                        onPress={() => { onChange(key); setOpen(false); }}
                        style={{
                          minHeight: 38, borderRadius: 10, alignItems: 'center',
                          justifyContent: 'center', backgroundColor: selected ? C.text : 'transparent',
                          opacity: disabled ? 0.25 : 1,
                        }}
                      >
                        <Text style={{ fontSize: 14, color: selected ? C.bg : C.text }}>{day}</Text>
                      </Pressable>
                    )}
                  </View>
                );
              })}
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={() => { onChange(maxDateKey); setOpen(false); }}
              style={{ padding: 13, alignItems: 'center' }}
            >
              <Text style={{ fontWeight: '700', color: C.text }}>Hoy</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button" onPress={() => setOpen(false)}
              style={{ padding: 12, alignItems: 'center' }}
            >
              <Text style={{ color: C.textMute }}>Cerrar</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}
