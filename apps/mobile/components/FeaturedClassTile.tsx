import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Pressable, Text, View } from 'react-native';
import Animated, {
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { ImageSlot } from '@/components/ImageSlot';
import { formatClassTime } from '@/lib/datetime';
import { resolveCoachDisplayName } from '@/lib/coachDisplay';
import { lowSpotsLabel, spotsAvailableLabel } from '@/lib/spotsRemaining';
import { LowSpotsBadge } from '@/components/LowSpotsBadge';
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
  /** Monochrome member schedule — no accent strip, RESERVAR overline, chevron. */
  variant?: 'default' | 'member';
};

export function FeaturedClassTile({
  item,
  timeZone,
  accentColor,
  onPress,
  height = 240,
  label,
  delay = 0,
  imageUri,
  variant = 'default',
}: Props) {
  const isMember = variant === 'member';
  const ins = item.instructor
    ? resolveCoachDisplayName(item.instructor.firstName, item.instructor.lastName)
    : null;
  const spotsWarning = lowSpotsLabel(item);
  const spotsLabel = isMember ? spotsAvailableLabel(item) : null;
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
        <ImageSlot
          uri={imageUri}
          vignette
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        />

        {/* Brand accent strip at top — hidden in member variant */}
        {!isMember ? (
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
        ) : null}

        {isMember ? (
          <View style={{ position: 'absolute', top: 16, right: 16 }}>
            <FontAwesome name="chevron-right" size={14} color="rgba(255,255,255,0.55)" />
          </View>
        ) : null}

        {/* Content pinned to bottom */}
        <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: 20 }}>
          {/* Editorial label */}
          {(label || isMember) ? (
            <Text
              style={{
                fontSize: 10,
                fontWeight: '700',
                letterSpacing: 1.4,
                textTransform: 'uppercase',
                color: 'rgba(255,255,255,0.58)',
                marginBottom: 8,
              }}
            >
              {isMember ? 'Reservar' : label}
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
          {spotsWarning ? (
            <View style={{ marginTop: 10 }}>
              <LowSpotsBadge label={spotsWarning} />
            </View>
          ) : null}
          {!spotsWarning && spotsLabel ? (
            <Text style={{ marginTop: 10, fontSize: 13, fontWeight: '600', color: 'rgba(255,255,255,0.72)' }}>
              {spotsLabel}
            </Text>
          ) : null}
        </View>
      </Pressable>
    </Animated.View>
  );
}
