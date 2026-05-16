import { Pressable, Text, View } from 'react-native';
import Animated, {
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { Space } from '@/constants/Theme';
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
        style={{ flexDirection: 'row', backgroundColor: '#1C1C1C', borderRadius: 16, overflow: 'hidden' }}
      >
        {/* Accent strip */}
        <View style={{ width: 4, backgroundColor: accentColor }} />

        <View style={{ flex: 1, paddingHorizontal: 20, paddingVertical: 22 }}>
          {/* Class name — the editorial headline */}
          <Text
            numberOfLines={1}
            style={{
              fontSize: 26,
              fontWeight: '800',
              letterSpacing: -0.7,
              color: '#FFFFFF',
              lineHeight: 30,
              marginBottom: 10,
            }}
          >
            {item.classTemplate.name}
          </Text>

          {/* Time + duration — practical info below the name */}
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={{ fontSize: 14, fontWeight: '500', color: 'rgba(255,255,255,0.55)', letterSpacing: -0.1 }}>
              {time}
            </Text>
            <Text style={{ fontSize: 12, color: 'rgba(255,255,255,0.28)', marginHorizontal: 6 }}>·</Text>
            <Text style={{ fontSize: 13, color: 'rgba(255,255,255,0.32)' }}>
              {duration} min
            </Text>
          </View>

          {/* Instructor */}
          {ins ? (
            <Text
              numberOfLines={1}
              style={{ marginTop: 6, fontSize: 13, color: 'rgba(255,255,255,0.38)' }}
            >
              {ins}
            </Text>
          ) : null}
        </View>
      </Pressable>
    </Animated.View>
  );
}
