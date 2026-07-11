import { Pressable, Text, View } from 'react-native';

import {
  formatMemberDayAccessibilityLabel,
  formatMemberWeekdayAbbrev,
  memberClassVolumeDots,
} from '@/lib/memberSchedule';
import { dayOfMonthLabel } from '@/lib/datetime';
import { getColors, Radius } from '@/constants/Theme';

type Props = {
  weekDayKeys: string[];
  selectedDayKey: string;
  todayKey: string;
  timeZone: string;
  classCountByDay: ReadonlyMap<string, number>;
  onSelectDay: (dayKey: string) => void;
};

function VolumeIndicator({ dots }: { dots: 0 | 1 | 2 | 3 }) {
  const C = getColors();

  if (dots === 0) {
    return (
      <View
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          borderWidth: 1,
          borderColor: C.textMute,
          marginTop: 6,
        }}
      />
    );
  }

  return (
    <View style={{ flexDirection: 'row', gap: 3, marginTop: 6, height: 6, alignItems: 'center' }}>
      {Array.from({ length: dots }).map((_, i) => (
        <View
          key={i}
          style={{
            width: 4,
            height: 4,
            borderRadius: 2,
            backgroundColor: C.textSub,
          }}
        />
      ))}
    </View>
  );
}

function MemberDayCell({
  dayKey,
  timeZone,
  selected,
  isToday,
  classCount,
  onPress,
  todayKey,
}: {
  dayKey: string;
  timeZone: string;
  selected: boolean;
  isToday: boolean;
  classCount: number;
  onPress: () => void;
  todayKey: string;
}) {
  const C = getColors();
  const dots = memberClassVolumeDots(classCount);
  const hasClasses = classCount > 0;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={formatMemberDayAccessibilityLabel(dayKey, todayKey, timeZone, classCount)}
      onPress={onPress}
      style={{ flex: 1, minWidth: 0, maxWidth: 52 }}
    >
      <View
        style={{
          alignItems: 'center',
          paddingVertical: 10,
          paddingHorizontal: 4,
          borderRadius: Radius.inner + 4,
          backgroundColor: selected ? '#FFFFFF' : 'transparent',
          borderWidth: !selected && isToday ? 1.5 : 0,
          borderColor: !selected && isToday ? 'rgba(255,255,255,0.45)' : 'transparent',
          opacity: !selected && !hasClasses ? 0.55 : 1,
        }}
      >
        <Text
          style={{
            fontSize: 10,
            fontWeight: '700',
            letterSpacing: 0.5,
            color: selected ? '#000000' : C.textMute,
          }}
          numberOfLines={1}
        >
          {formatMemberWeekdayAbbrev(dayKey, timeZone)}
        </Text>
        <Text
          style={{
            fontSize: 17,
            fontWeight: '800',
            letterSpacing: -0.5,
            color: selected ? '#000000' : C.text,
            marginTop: 4,
          }}
          numberOfLines={1}
        >
          {dayOfMonthLabel(dayKey, timeZone)}
        </Text>
        <VolumeIndicator dots={dots} />
      </View>
    </Pressable>
  );
}

export function MemberDaySelector({
  weekDayKeys,
  selectedDayKey,
  todayKey,
  timeZone,
  classCountByDay,
  onSelectDay,
}: Props) {
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginBottom: 24,
        gap: 2,
      }}
    >
      {weekDayKeys.map((dayKey) => (
        <MemberDayCell
          key={dayKey}
          dayKey={dayKey}
          timeZone={timeZone}
          selected={selectedDayKey === dayKey}
          isToday={dayKey === todayKey}
          classCount={classCountByDay.get(dayKey) ?? 0}
          onPress={() => onSelectDay(dayKey)}
          todayKey={todayKey}
        />
      ))}
    </View>
  );
}
