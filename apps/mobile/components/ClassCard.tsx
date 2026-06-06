import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, {
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { ImageSlot } from '@/components/ImageSlot';
import { Space } from '@/constants/Theme';
import { bookingStatusColors, type BookingStatusPillConfig } from '@/lib/bookingStatus';
import { formatClassTime } from '@/lib/datetime';
import type { ScheduledClassDto } from '@/lib/types/studio';

type Props = {
  item: ScheduledClassDto;
  timeZone: string;
  accentColor: string;
  onPress: () => void;
  index?: number;
  /** Remote image URI — renders as right-side thumbnail when provided. */
  imageUri?: string;
  /** Optional reservation status pill (e.g. My Bookings). */
  statusPill?: BookingStatusPillConfig;
  /** Optional footer rendered below the card (e.g. check-in CTA). */
  footer?: ReactNode;
};

const THUMB_W = 84;

export function ClassCard({
  item,
  timeZone,
  accentColor,
  onPress,
  index = 0,
  imageUri,
  statusPill,
  footer,
}: Props) {
  const ins = item.instructor
    ? `${item.instructor.firstName} ${item.instructor.lastName}`.trim()
    : null;
  const duration = item.classTemplate.durationMinutes;
  const time = formatClassTime(item.startsAt, timeZone);

  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const delay = Math.min(index * 55, 280);

  const pillColors = statusPill ? bookingStatusColors(statusPill.variant) : null;

  return (
    <Animated.View
      entering={FadeInDown.delay(delay).duration(420)}
      style={[{ marginBottom: Space.cardGap }, animStyle]}
    >
      <View
        style={{
          backgroundColor: '#1A1A1C',
          borderRadius: 16,
          overflow: 'hidden',
        }}
      >
        <Pressable
          accessibilityRole="button"
          onPress={onPress}
          onPressIn={() => { scale.value = withSpring(0.972, { damping: 22, stiffness: 380 }); }}
          onPressOut={() => { scale.value = withSpring(1.0, { damping: 14, stiffness: 200 }); }}
          style={{
            flexDirection: 'row',
            minHeight: 92,
          }}
        >
          {/* Left accent strip */}
          <View style={{ width: 3, backgroundColor: accentColor }} />

          {/* Text content */}
          <View style={{ flex: 1, paddingLeft: 18, paddingRight: 14, paddingVertical: 20 }}>
            {statusPill && pillColors ? (
              <View
                style={{
                  alignSelf: 'flex-start',
                  backgroundColor: pillColors.bg,
                  borderRadius: 6,
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                  marginBottom: 8,
                }}
              >
                <Text
                  style={{
                    fontSize: 10,
                    fontWeight: '700',
                    letterSpacing: 0.4,
                    color: pillColors.text,
                  }}
                >
                  {statusPill.label}
                </Text>
              </View>
            ) : null}

            <Text
              numberOfLines={1}
              style={{
                fontSize: 22,
                fontWeight: '800',
                letterSpacing: -0.6,
                color: '#FFFFFF',
                lineHeight: 26,
                marginBottom: 9,
              }}
            >
              {item.classTemplate.name}
            </Text>

          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text
              style={{
                fontSize: 13,
                fontWeight: '500',
                color: 'rgba(255,255,255,0.50)',
                letterSpacing: -0.1,
              }}
            >
              {time}
            </Text>
            <Text style={{ fontSize: 11, color: 'rgba(255,255,255,0.24)', marginHorizontal: 6 }}>
              ·
            </Text>
            <Text style={{ fontSize: 13, color: 'rgba(255,255,255,0.30)' }}>
              {duration} min
            </Text>
          </View>

          {ins ? (
            <Text
              numberOfLines={1}
              style={{ marginTop: 5, fontSize: 12, color: 'rgba(255,255,255,0.32)' }}
            >
              {ins}
            </Text>
          ) : null}
        </View>

        {/* Right image thumbnail */}
        <View style={{ width: THUMB_W, overflow: 'hidden', position: 'relative' }}>
          <ImageSlot
            uri={imageUri}
            vignette={false}
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
          />
          {/* Left-edge fade — blends thumbnail into card background */}
          <View
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              bottom: 0,
              width: 28,
              backgroundColor: 'rgba(26,26,28,0.92)',
            }}
          />
          <View
            style={{
              position: 'absolute',
              top: 0,
              left: 18,
              bottom: 0,
              width: 16,
              backgroundColor: 'rgba(26,26,28,0.55)',
            }}
          />
        </View>
        </Pressable>

        {footer ? (
          <View
            style={{
              borderTopWidth: 1,
              borderTopColor: 'rgba(255,255,255,0.08)',
              paddingHorizontal: 18,
              paddingVertical: 12,
            }}
          >
            {footer}
          </View>
        ) : null}
      </View>
    </Animated.View>
  );
}
