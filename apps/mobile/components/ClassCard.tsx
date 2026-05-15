import { Pressable, Text, View, useColorScheme } from 'react-native';
import Animated, {
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { getColors, Space } from '@/constants/Theme';
import { formatClassTime } from '@/lib/datetime';
import type { ScheduledClassDto } from '@/lib/types/studio';

type Props = {
  item: ScheduledClassDto;
  timeZone: string;
  accentColor: string;
  onPress: () => void;
  index?: number;
};

export function ClassCard({ item, timeZone, accentColor, onPress, index = 0 }: Props) {
  const scheme = useColorScheme();
  const C = getColors(scheme);

  const ins = item.instructor
    ? `${item.instructor.firstName} ${item.instructor.lastName}`.trim()
    : null;
  const duration = item.classTemplate.durationMinutes;
  const time = formatClassTime(item.startsAt, timeZone);

  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const delay = Math.min(index * 55, 280);

  return (
    <Animated.View
      entering={FadeInDown.delay(delay).duration(420)}
      style={[{ marginBottom: Space.cardGap }, animStyle]}
    >
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        onPressIn={() => { scale.value = withSpring(0.972, { damping: 22, stiffness: 380 }); }}
        onPressOut={() => { scale.value = withSpring(1.0, { damping: 14, stiffness: 200 }); }}
        style={{ flexDirection: 'row', backgroundColor: C.surface2, borderRadius: 16, overflow: 'hidden' }}
      >
        {/* Accent strip — the only use of color on this card */}
        <View style={{ width: 3, backgroundColor: accentColor, opacity: 0.9 }} />

        <View style={{ flex: 1, paddingHorizontal: Space.cardH, paddingVertical: Space.cardV }}>
          {/* Time + duration */}
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
            <Text style={{ fontSize: 12, fontWeight: '500', color: C.textSub, letterSpacing: 0.1 }}>
              {time}
            </Text>
            <View style={{ flex: 1 }} />
            <Text style={{ fontSize: 11, color: C.textMute, letterSpacing: 0.3 }}>
              {duration} min
            </Text>
          </View>

          {/* Class name — the headline */}
          <Text
            numberOfLines={1}
            style={{ fontSize: 18, fontWeight: '600', letterSpacing: -0.3, color: C.text }}
          >
            {item.classTemplate.name}
          </Text>

          {/* Instructor — whispered below */}
          {ins ? (
            <Text
              numberOfLines={1}
              style={{ marginTop: 4, fontSize: 13, color: C.textMute }}
            >
              {ins}
            </Text>
          ) : null}
        </View>
      </Pressable>
    </Animated.View>
  );
}
