import { Image, Pressable, Text, View } from 'react-native';
import Animated, {
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { formatClassTime } from '@/lib/datetime';
import type { ScheduledClassDto } from '@/lib/types/studio';

type Props = {
  item: ScheduledClassDto;
  timeZone: string;
  accentColor: string;
  onPress: () => void;
  /** Card height. Defaults to 240. */
  height?: number;
  /** Optional editorial label rendered above the class name (e.g. "Today", "Book now"). */
  label?: string;
  /** Entrance animation delay in ms. */
  delay?: number;
  /** Remote image URI. Falls back to atmospheric placeholder when absent. */
  imageUri?: string;
};

export function FeaturedClassTile({
  item,
  timeZone,
  accentColor,
  onPress,
  height = 240,
  label,
  delay = 0,
}: Props) {
  const ins = item.instructor
    ? `${item.instructor.firstName} ${item.instructor.lastName}`.trim()
    : null;
  const time = formatClassTime(item.startsAt, timeZone);
  const duration = item.classTemplate.durationMinutes;

  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View
      entering={FadeInDown.delay(delay).duration(500)}
      style={[{ borderRadius: 20, overflow: 'hidden', height }, animStyle]}
    >
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        onPressIn={() => { scale.value = withSpring(0.980, { damping: 22, stiffness: 360 }); }}
        onPressOut={() => { scale.value = withSpring(1.0, { damping: 14, stiffness: 200 }); }}
        style={{ flex: 1 }}
      >
        {/* Diagnostic: red bg proves container dimensions; raw Image proves loading */}
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'red' }} />
        <Image
          source={{ uri: 'https://picsum.photos/800/600' }}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
          resizeMode="cover"
        />

        {/* Brand accent strip at top */}
        <View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 3,
            backgroundColor: accentColor,
          }}
        />

        {/* Content pinned to bottom */}
        <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: 20 }}>
          {/* Editorial label */}
          {label ? (
            <Text
              style={{
                fontSize: 10,
                fontWeight: '700',
                letterSpacing: 1.4,
                textTransform: 'uppercase',
                color: accentColor,
                marginBottom: 8,
              }}
            >
              {label}
            </Text>
          ) : null}

          {/* Class name — the cinematic headline */}
          <Text
            numberOfLines={2}
            style={{
              fontSize: 30,
              fontWeight: '800',
              letterSpacing: -0.8,
              color: '#FFFFFF',
              lineHeight: 34,
              marginBottom: 10,
            }}
          >
            {item.classTemplate.name}
          </Text>

          {/* Time · duration · instructor */}
          <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }}>
            <Text
              style={{ fontSize: 14, fontWeight: '500', color: 'rgba(255,255,255,0.72)', letterSpacing: -0.1 }}
            >
              {time}
            </Text>
            <Text style={{ fontSize: 12, color: 'rgba(255,255,255,0.30)', marginHorizontal: 6 }}>·</Text>
            <Text style={{ fontSize: 13, color: 'rgba(255,255,255,0.50)' }}>
              {duration} min
            </Text>
            {ins ? (
              <>
                <Text style={{ fontSize: 12, color: 'rgba(255,255,255,0.25)', marginHorizontal: 6 }}>·</Text>
                <Text
                  numberOfLines={1}
                  style={{ fontSize: 13, color: 'rgba(255,255,255,0.42)', flex: 1 }}
                >
                  {ins}
                </Text>
              </>
            ) : null}
          </View>
        </View>
      </Pressable>
    </Animated.View>
  );
}
