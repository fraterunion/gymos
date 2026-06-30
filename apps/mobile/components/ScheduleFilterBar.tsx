import { Pressable, ScrollView, Text, View } from 'react-native';

import { ARES_CLASS_FILTERS } from '@/lib/aresScheduleFilters';
import { getColors, Space } from '@/constants/Theme';

type Props = {
  selectedId: string;
  onSelect: (filterId: string) => void;
  accentColor: string;
};

export function ScheduleFilterBar({ selectedId, onSelect, accentColor }: Props) {
  const C = getColors();

  return (
    <View style={{ marginTop: 4, marginBottom: 4 }}>
      <Text
        style={{
          fontSize: 11,
          fontWeight: '700',
          letterSpacing: 1.0,
          textTransform: 'uppercase',
          color: C.textMute,
          marginBottom: 12,
        }}
      >
        Filtrar por clase
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ marginHorizontal: -Space.screenH }}
        contentContainerStyle={{ paddingHorizontal: Space.screenH, gap: 8 }}
      >
        {ARES_CLASS_FILTERS.map((filter) => {
          const active = selectedId === filter.id;
          return (
            <Pressable
              key={filter.id}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => onSelect(filter.id)}
              style={{
                borderRadius: 100,
                paddingHorizontal: 14,
                paddingVertical: 8,
                backgroundColor: active ? accentColor : C.surface2,
                borderWidth: 1,
                borderColor: active ? accentColor : C.separator,
              }}
            >
              <Text
                style={{
                  fontSize: 13,
                  fontWeight: active ? '700' : '600',
                  color: active ? '#FFFFFF' : C.textSub,
                  letterSpacing: -0.2,
                }}
              >
                {filter.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}
