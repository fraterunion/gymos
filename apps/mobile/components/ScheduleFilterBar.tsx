import { Pressable, ScrollView, Text, View } from 'react-native';

import { ARES_CLASS_FILTERS } from '@/lib/aresScheduleFilters';
import { getColors, Space } from '@/constants/Theme';

type Props = {
  selectedId: string;
  onSelect: (filterId: string) => void;
};

export function ScheduleFilterBar({ selectedId, onSelect }: Props) {
  const C = getColors();

  return (
    <View style={{ marginBottom: 8 }}>
      <Text
        style={{
          fontSize: 10,
          fontWeight: '700',
          letterSpacing: 1.2,
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
                paddingHorizontal: 16,
                paddingVertical: 10,
                minHeight: 44,
                justifyContent: 'center',
                backgroundColor: active ? '#FFFFFF' : C.surface1,
                borderWidth: 1,
                borderColor: active ? '#FFFFFF' : C.separator,
              }}
            >
              <Text
                style={{
                  fontSize: 13,
                  fontWeight: active ? '700' : '600',
                  color: active ? '#000000' : C.textSub,
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
