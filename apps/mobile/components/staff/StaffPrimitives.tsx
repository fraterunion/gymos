import FontAwesome from '@expo/vector-icons/FontAwesome';
import type { ComponentProps, ReactNode } from 'react';
import { Pressable, Text, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  FadeIn,
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { Accent, Radius, Space, getColors, type ThemeColors } from '@/constants/Theme';

type IconName = ComponentProps<typeof FontAwesome>['name'];

export function staffCardStyle(C: ThemeColors, pressed = false): ViewStyle {
  return {
    backgroundColor: C.surface1,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: C.separator,
    padding: Space.cardV,
    opacity: pressed ? 0.94 : 1,
    transform: [{ scale: pressed ? 0.985 : 1 }],
  };
}

export function StaffScreenHeader({
  title,
  subtitle,
  meta,
}: {
  title: string;
  subtitle?: string;
  meta?: string;
}) {
  const C = getColors();
  return (
    <Animated.View entering={FadeInDown.duration(300)} style={{ paddingTop: 32, paddingBottom: Space.sp5 }}>
      <Text
        style={{
          fontSize: 40,
          fontWeight: '800',
          letterSpacing: -1.6,
          color: C.text,
          lineHeight: 44,
        }}
      >
        {title}
      </Text>
      {subtitle ? (
        <Text style={{ fontSize: 16, color: C.textSub, lineHeight: 24, marginTop: 10, letterSpacing: -0.2 }}>
          {subtitle}
        </Text>
      ) : null}
      {meta ? (
        <Text style={{ fontSize: 12, color: C.textMute, marginTop: 8, letterSpacing: 0.2 }}>{meta}</Text>
      ) : null}
    </Animated.View>
  );
}

export function SectionOverline({ children }: { children: string }) {
  const C = getColors();
  return (
    <Text
      style={{
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 1.4,
        textTransform: 'uppercase',
        color: C.textMute,
        marginBottom: Space.sp2,
        marginTop: Space.sp4,
      }}
    >
      {children}
    </Text>
  );
}

export function StaffCard({
  children,
  onPress,
  style,
  index = 0,
}: {
  children: ReactNode;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  index?: number;
}) {
  const C = getColors();
  const inner = (
    <Animated.View
      entering={FadeInDown.delay(index * 40).duration(300)}
      style={[staffCardStyle(C), style]}
    >
      {children}
    </Animated.View>
  );
  if (!onPress) return inner;
  return (
    <Pressable accessibilityRole="button" onPress={onPress}>
      {({ pressed }) => (
        <Animated.View
          entering={FadeInDown.delay(index * 40).duration(300)}
          style={[staffCardStyle(C, pressed), style]}
        >
          {children}
        </Animated.View>
      )}
    </Pressable>
  );
}

/**
 * Open metric display — number leads, label follows.
 * GymOS instrument readout convention: you read the value, then learn what it measures.
 * No bordered container — typography and spacing carry the weight.
 */
export function KpiTile({
  value,
  label,
  index = 0,
  highlight,
}: {
  value: string;
  label: string;
  index?: number;
  highlight?: boolean;
}) {
  const C = getColors();
  return (
    <Animated.View
      entering={FadeInDown.delay(index * 32).duration(280)}
      style={{
        width: '48%',
        paddingVertical: Space.sp2,
        marginBottom: Space.cardGap,
      }}
    >
      <Text
        style={{
          fontSize: 34,
          fontWeight: '800',
          letterSpacing: -1.4,
          color: highlight ? Accent : C.text,
          lineHeight: 38,
          fontVariant: ['tabular-nums'],
        }}
      >
        {value}
      </Text>
      <Text
        style={{
          fontSize: 11,
          fontWeight: '600',
          letterSpacing: 0.8,
          textTransform: 'uppercase',
          color: C.textMute,
          marginTop: 6,
        }}
      >
        {label}
      </Text>
    </Animated.View>
  );
}

export function OccupancyBar({
  booked,
  capacity,
}: {
  booked: number;
  capacity: number;
  animate?: boolean;
}) {
  const pct = capacity > 0 ? Math.min(100, Math.round((booked / capacity) * 100)) : 0;

  return (
    <View
      style={{
        height: 2,
        borderRadius: 1,
        backgroundColor: 'rgba(255,255,255,0.07)',
        overflow: 'hidden',
      }}
    >
      <Animated.View
        entering={FadeIn.duration(300)}
        style={{
          width: `${pct}%`,
          height: '100%',
          borderRadius: 1,
          backgroundColor: Accent,
        }}
      />
    </View>
  );
}

export function ClassMonogram({ name, size = 48 }: { name: string; size?: number }) {
  const letter = name.trim()[0]?.toUpperCase() ?? 'C';
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: Radius.inner,
        backgroundColor: 'rgba(91,92,235,0.10)',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ fontSize: size * 0.38, fontWeight: '800', color: Accent }}>{letter}</Text>
    </View>
  );
}

/**
 * Schedule class card — used on the Horario screen.
 * Class name is the primary identifier. No monogram badge.
 * Card is kept because a scheduled class is a real object.
 */
export function ScheduleClassCard({
  className,
  timeLabel,
  coachLabel,
  booked,
  capacity,
  onPress,
  index = 0,
  cancelled = false,
}: {
  className: string;
  timeLabel: string;
  coachLabel: string;
  booked: number;
  capacity: number;
  onPress: () => void;
  index?: number;
  cancelled?: boolean;
}) {
  const C = getColors();

  return (
    <Pressable accessibilityRole="button" onPress={onPress} disabled={cancelled}>
      {({ pressed }) => (
        <Animated.View
          entering={FadeInDown.delay(index * 48).duration(300)}
          style={[
            staffCardStyle(C, pressed),
            {
              marginBottom: Space.cardGap,
              opacity: cancelled ? 0.45 : 1,
              minHeight: 72,
            },
          ]}
        >
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <View style={{ flex: 1, paddingRight: Space.sp2 }}>
                <Text
                  style={{
                    fontSize: 20,
                    fontWeight: '700',
                    letterSpacing: -0.5,
                    color: C.text,
                    marginBottom: 5,
                    lineHeight: 24,
                  }}
                  numberOfLines={2}
                >
                  {className}
                </Text>
                <Text style={{ fontSize: 14, color: C.textSub, marginBottom: 3 }}>{timeLabel}</Text>
                <Text style={{ fontSize: 13, color: C.textMute, marginBottom: Space.sp2 }} numberOfLines={1}>
                  {coachLabel}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end', paddingTop: 2 }}>
                <Text style={{ fontSize: 22, fontWeight: '800', letterSpacing: -1, color: C.text, lineHeight: 24, fontVariant: ['tabular-nums'] }}>
                  {booked}
                </Text>
                <Text style={{ fontSize: 10, fontWeight: '600', letterSpacing: 0.6, textTransform: 'uppercase', color: C.textMute, marginTop: 2 }}>
                  {'/ '}{capacity}
                </Text>
              </View>
            </View>
            <OccupancyBar booked={booked} capacity={capacity} />
          </View>
        </Animated.View>
      )}
    </Pressable>
  );
}

/**
 * Day tab for the Horario week strip.
 * Less pill, more precision: flat rectangle with accent fill for selected.
 */
export function DayCapsule({
  label,
  dayNum,
  selected,
  isToday,
  onPress,
}: {
  label: string;
  dayNum: string;
  selected: boolean;
  isToday: boolean;
  onPress: () => void;
}) {
  const C = getColors();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={{ marginRight: 6 }}>
      <View
        style={{
          minWidth: 48,
          paddingVertical: 10,
          paddingHorizontal: 12,
          borderRadius: Radius.inner,
          alignItems: 'center',
          backgroundColor: selected ? Accent : 'transparent',
          borderWidth: selected ? 0 : isToday ? 1 : 0,
          borderColor: isToday && !selected ? 'rgba(91,92,235,0.35)' : 'transparent',
        }}
      >
        <Text
          style={{
            fontSize: 10,
            fontWeight: '700',
            letterSpacing: 0.6,
            textTransform: 'uppercase',
            color: selected ? '#FFFFFF' : C.textMute,
            marginBottom: 4,
          }}
        >
          {label}
        </Text>
        <Text
          style={{
            fontSize: 18,
            fontWeight: '800',
            color: selected ? '#FFFFFF' : isToday ? Accent : C.text,
            letterSpacing: -0.5,
          }}
        >
          {dayNum}
        </Text>
      </View>
    </Pressable>
  );
}

export function WeekNavigatorBar({
  label,
  canGoPrev,
  onPrev,
  onNext,
}: {
  label: string;
  canGoPrev: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  const C = getColors();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: Space.sp2,
      }}
    >
      <Pressable onPress={onPrev} disabled={!canGoPrev} hitSlop={12} style={{ opacity: canGoPrev ? 1 : 0.3 }}>
        <FontAwesome name="chevron-left" size={16} color={C.textSub} />
      </Pressable>
      <Text style={{ fontSize: 13, fontWeight: '600', color: C.textSub, letterSpacing: 0.2 }}>{label}</Text>
      <Pressable onPress={onNext} hitSlop={12}>
        <FontAwesome name="chevron-right" size={16} color={C.textSub} />
      </Pressable>
    </View>
  );
}

/**
 * Text tab strip — GymOS signature.
 * Selected state = 2px accent underline only. No fill. No rounded chip.
 * Replaces SegmentedControl and FilterChip wherever filters / segments appear.
 */
export function TabStrip<T extends string>({
  options,
  value,
  onChange,
  style,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const C = getColors();
  return (
    <View style={[{ flexDirection: 'row', marginBottom: Space.sp3 }, style]}>
      {options.map((opt) => {
        const selected = value === opt.id;
        return (
          <Pressable
            key={opt.id}
            accessibilityRole="button"
            onPress={() => onChange(opt.id)}
            style={{ marginRight: Space.sp3, paddingBottom: 10 }}
          >
            <Text
              style={{
                fontSize: 15,
                fontWeight: selected ? '700' : '500',
                color: selected ? C.text : C.textMute,
                letterSpacing: -0.2,
              }}
            >
              {opt.label}
            </Text>
            {selected ? (
              <View
                style={{
                  position: 'absolute',
                  bottom: 0,
                  left: 0,
                  right: 0,
                  height: 2,
                  backgroundColor: Accent,
                  borderRadius: 1,
                }}
              />
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** @deprecated Use TabStrip instead. Kept for backward compatibility. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return <TabStrip options={options} value={value} onChange={onChange} />;
}

/** @deprecated Use TabStrip instead. Kept for backward compatibility. */
export function FilterChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const C = getColors();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={{ marginRight: Space.sp3, paddingBottom: 10 }}>
      <Text
        style={{
          fontSize: 15,
          fontWeight: selected ? '700' : '500',
          color: selected ? C.text : C.textMute,
          letterSpacing: -0.2,
        }}
      >
        {label}
      </Text>
      {selected ? (
        <View
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: 2,
            backgroundColor: Accent,
            borderRadius: 1,
          }}
        />
      ) : null}
    </Pressable>
  );
}

/**
 * Open stat — number leads, label follows. No bordered container.
 * Used in class roster stats bar.
 */
export function StatCard({
  value,
  label,
}: {
  value: string;
  label: string;
}) {
  const C = getColors();
  return (
    <View
      style={{
        flex: 1,
        paddingVertical: Space.sp2,
        alignItems: 'center',
      }}
    >
      <Text
        style={{
          fontSize: 32,
          fontWeight: '800',
          letterSpacing: -1.2,
          color: C.text,
          lineHeight: 36,
          fontVariant: ['tabular-nums'],
        }}
      >
        {value}
      </Text>
      <Text
        style={{
          fontSize: 10,
          fontWeight: '600',
          letterSpacing: 0.8,
          textTransform: 'uppercase',
          color: C.textMute,
          marginTop: 6,
          textAlign: 'center',
        }}
      >
        {label}
      </Text>
    </View>
  );
}

/**
 * Member / contact row — iOS Contacts quality.
 * Avatar: neutral circle, no border. Context expressed via ring or trailing element.
 */
export function MemberRow({
  initials,
  name,
  subtitle,
  badge,
  trailing,
  onPress,
  index = 0,
  height = 72,
}: {
  initials: string;
  name: string;
  subtitle?: string;
  badge?: ReactNode;
  trailing?: ReactNode;
  onPress?: () => void;
  index?: number;
  height?: number;
}) {
  const C = getColors();
  const content = (
    <Animated.View
      entering={FadeInDown.delay(Math.min(index * 32, 160)).duration(300)}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: height,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: C.separator,
      }}
    >
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: 22,
          backgroundColor: C.surface2,
          alignItems: 'center',
          justifyContent: 'center',
          marginRight: Space.sp2,
        }}
      >
        <Text style={{ fontSize: 15, fontWeight: '800', color: C.text }}>{initials}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          style={{ fontSize: 16, fontWeight: '600', color: C.text, letterSpacing: -0.3 }}
          numberOfLines={1}
        >
          {name}
        </Text>
        {subtitle ? (
          <Text style={{ fontSize: 13, color: C.textMute, marginTop: 3 }} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
        {badge ? <View style={{ marginTop: 6 }}>{badge}</View> : null}
      </View>
      {trailing ?? <FontAwesome name="chevron-right" size={12} color={C.textMute} />}
    </Animated.View>
  );

  if (!onPress) return content;
  return (
    <Pressable accessibilityRole="button" onPress={onPress}>
      {({ pressed }) => (
        <View style={{ opacity: pressed ? 0.88 : 1 }}>{content}</View>
      )}
    </Pressable>
  );
}

export function QuickActionTile({
  label,
  icon,
  onPress,
  index = 0,
}: {
  label: string;
  icon: IconName;
  onPress: () => void;
  index?: number;
}) {
  const C = getColors();
  const scale = useSharedValue(1);
  const anim = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View entering={FadeInDown.delay(index * 40).duration(300)} style={{ width: '48%', marginBottom: 12 }}>
      <Animated.View style={anim}>
        <Pressable
          accessibilityRole="button"
          onPress={onPress}
          onPressIn={() => { scale.value = withTiming(0.96, { duration: 80 }); }}
          onPressOut={() => { scale.value = withTiming(1, { duration: 140 }); }}
          style={{
            minHeight: 88,
            borderRadius: Radius.card,
            borderWidth: 1,
            borderColor: C.separator,
            backgroundColor: C.surface1,
            padding: Space.cardV,
            justifyContent: 'space-between',
          }}
        >
          <FontAwesome name={icon} size={18} color={Accent} />
          <Text style={{ fontSize: 15, fontWeight: '700', color: C.text, letterSpacing: -0.3, marginTop: Space.sp2 }}>
            {label}
          </Text>
        </Pressable>
      </Animated.View>
    </Animated.View>
  );
}

/**
 * Search input — no border, background-only container.
 * Border removed per the GymOS "remove unnecessary chrome" directive.
 */
export function SpotlightSearch({
  value,
  onChangeText,
  placeholder,
}: {
  value: string;
  onChangeText: (t: string) => void;
  placeholder: string;
}) {
  const C = getColors();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: C.surface1,
        borderRadius: Radius.button,
        paddingHorizontal: Space.sp2,
        minHeight: 48,
        marginBottom: Space.sp2,
        gap: Space.sp1,
      }}
    >
      <FontAwesome name="search" size={15} color={C.textMute} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={C.textMute}
        autoCapitalize="none"
        autoCorrect={false}
        style={{ flex: 1, fontSize: 16, color: C.text, paddingVertical: 12 }}
      />
    </View>
  );
}

/**
 * Summary strip — open metric row, no bordered container.
 * Numbers lead; labels follow. Used on the Today screen.
 */
export function SummaryStrip({
  items,
}: {
  items: { value: string; label: string }[];
}) {
  const C = getColors();
  return (
    <Animated.View entering={FadeIn.duration(300)}>
      <View
        style={{
          flexDirection: 'row',
          paddingVertical: Space.sp2,
          marginBottom: Space.sp3,
        }}
      >
        {items.map((item, i) => (
          <View key={item.label} style={{ flex: 1, alignItems: 'center', position: 'relative' }}>
            <Text
              style={{
                fontSize: 32,
                fontWeight: '800',
                letterSpacing: -1.2,
                color: C.text,
                fontVariant: ['tabular-nums'],
              }}
            >
              {item.value}
            </Text>
            <Text
              style={{
                fontSize: 10,
                fontWeight: '600',
                letterSpacing: 0.7,
                textTransform: 'uppercase',
                color: C.textMute,
                marginTop: 5,
                textAlign: 'center',
              }}
            >
              {item.label}
            </Text>
            {i < items.length - 1 ? (
              <View
                style={{
                  position: 'absolute',
                  right: 0,
                  top: '20%',
                  height: '60%',
                  width: 1,
                  backgroundColor: C.separator,
                }}
              />
            ) : null}
          </View>
        ))}
      </View>
    </Animated.View>
  );
}

/**
 * Timeline class row — used on the Today screen.
 * Open layout: no bordered card. Typography-dominant.
 * Time anchor on the left; class name leads; count trails.
 */
export function TimelineClassRow({
  time,
  className,
  coach,
  booked,
  capacity,
  status,
  isNow,
  onPress,
  index = 0,
  isLast = false,
}: {
  time: string;
  className: string;
  coach: string;
  booked: number;
  capacity: number;
  status?: string;
  isNow?: boolean;
  onPress: () => void;
  index?: number;
  isLast?: boolean;
}) {
  const C = getColors();
  const isCancelled = status === 'CANCELLED';

  return (
    <Pressable accessibilityRole="button" onPress={onPress}>
      {({ pressed }) => (
        <Animated.View
          entering={FadeInDown.delay(index * 40).duration(300)}
          style={{
            flexDirection: 'row',
            opacity: pressed ? 0.88 : isCancelled ? 0.45 : 1,
            paddingVertical: 12,
            borderBottomWidth: isLast ? 0 : 1,
            borderBottomColor: C.separator,
          }}
        >
          {/* Time column — Accent when live */}
          <View style={{ width: 52, justifyContent: 'flex-start', paddingTop: 2 }}>
            <Text style={{ fontSize: 13, fontWeight: '600', color: isNow ? Accent : C.textMute, letterSpacing: -0.2 }}>
              {time}
            </Text>
          </View>

          {/* Class content */}
          <View style={{ flex: 1, paddingLeft: Space.sp1 }}>
            <Text
              style={{
                fontSize: 17,
                fontWeight: isNow ? '700' : '600',
                letterSpacing: -0.4,
                color: C.text,
                marginBottom: 3,
              }}
              numberOfLines={2}
            >
              {className}
            </Text>
            <Text style={{ fontSize: 13, color: C.textMute, marginBottom: 8 }} numberOfLines={1}>
              {coach}
            </Text>
            <OccupancyBar booked={booked} capacity={capacity} />
          </View>

          {/* Trailing */}
          <View style={{ alignItems: 'flex-end', justifyContent: 'flex-start', paddingTop: 2, paddingLeft: Space.sp1 }}>
            {isCancelled ? (
              <Text style={{ fontSize: 10, fontWeight: '700', letterSpacing: 0.6, color: C.textMute }}>
                CANCELADA
              </Text>
            ) : (
              <Text style={{ fontSize: 14, fontWeight: '600', color: C.textSub, letterSpacing: -0.2, fontVariant: ['tabular-nums'] }}>
                {booked}<Text style={{ fontWeight: '400', color: C.textMute }}>/{capacity}</Text>
              </Text>
            )}
          </View>
        </Animated.View>
      )}
    </Pressable>
  );
}

/**
 * Dashboard briefing class row — simplified schedule preview.
 * Lighter than ScheduleClassCard: one row with time, name, count.
 * Used in the morning briefing "Hoy" section on the Dashboard screen.
 */
export function TodayClassRow({
  time,
  className,
  booked,
  capacity,
  isNow,
  onPress,
  index = 0,
  isLast = false,
}: {
  time: string;
  className: string;
  booked: number;
  capacity: number;
  isNow?: boolean;
  onPress: () => void;
  index?: number;
  isLast?: boolean;
}) {
  const C = getColors();
  return (
    <Pressable accessibilityRole="button" onPress={onPress}>
      {({ pressed }) => (
        <Animated.View
          entering={FadeInDown.delay(index * 32).duration(280)}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: Space.sp2,
            paddingVertical: 12,
            borderBottomWidth: isLast ? 0 : 1,
            borderBottomColor: C.separator,
            opacity: pressed ? 0.88 : 1,
          }}
        >
          <Text
            style={{
              fontSize: 13,
              fontWeight: '600',
              color: isNow ? Accent : C.textMute,
              width: 44,
              letterSpacing: -0.2,
            }}
          >
            {time}
          </Text>
          <Text
            style={{
              flex: 1,
              fontSize: 16,
              fontWeight: isNow ? '700' : '500',
              color: C.text,
              letterSpacing: -0.3,
            }}
            numberOfLines={1}
          >
            {className}
          </Text>
          {isNow ? (
            <Text style={{ fontSize: 10, fontWeight: '700', color: Accent, letterSpacing: 0.6, textTransform: 'uppercase' }}>
              Ahora
            </Text>
          ) : (
            <Text style={{ fontSize: 13, color: C.textMute, fontVariant: ['tabular-nums'] }}>
              {booked}<Text style={{ color: C.separator }}>/{capacity}</Text>
            </Text>
          )}
        </Animated.View>
      )}
    </Pressable>
  );
}

/**
 * Revenue hero — GymOS instrument readout convention.
 * Number leads. Label follows. No card wrapper needed when used inline.
 * This component wraps in StaffCard because revenue summary IS a real object (it represents
 * actual committed payment data, not derived UI chrome).
 */
export function RevenueHeroCard({
  monthLabel,
  monthValue,
  thirtyDayValue,
  footnote,
}: {
  monthLabel: string;
  monthValue: string;
  thirtyDayValue: string;
  footnote?: string;
}) {
  const C = getColors();
  return (
    <StaffCard>
      {/* Number first — instrument readout convention */}
      <Text
        style={{
          fontSize: 48,
          fontWeight: '800',
          letterSpacing: -2,
          color: C.text,
          lineHeight: 52,
          marginBottom: 6,
          fontVariant: ['tabular-nums'],
        }}
      >
        {monthValue}
      </Text>
      {/* Label follows: what the number measures */}
      <Text style={{ fontSize: 11, fontWeight: '600', letterSpacing: 1, color: C.textMute, textTransform: 'uppercase', marginBottom: Space.sp3 }}>
        Ingresos · {monthLabel}
      </Text>
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          paddingTop: Space.sp2,
          borderTopWidth: 1,
          borderTopColor: C.separator,
        }}
      >
        <View>
          <Text style={{ fontSize: 22, fontWeight: '800', color: C.textSub, letterSpacing: -0.8, lineHeight: 26, fontVariant: ['tabular-nums'] }}>
            {thirtyDayValue}
          </Text>
          <Text style={{ fontSize: 11, fontWeight: '600', letterSpacing: 0.8, color: C.textMute, marginTop: 5, textTransform: 'uppercase' }}>
            30 días
          </Text>
        </View>
        {footnote ? (
          <Text style={{ fontSize: 11, color: C.textMute, alignSelf: 'flex-end', maxWidth: '45%', textAlign: 'right', lineHeight: 16 }}>
            {footnote}
          </Text>
        ) : null}
      </View>
    </StaffCard>
  );
}
