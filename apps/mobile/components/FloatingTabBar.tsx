import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import type { ComponentProps } from 'react';
import { useEffect } from 'react';
import { Pressable, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useBranding } from '@/contexts/BrandingContext';

/**
 * Bottom padding that all scrollable tab screens must add to prevent content
 * from being obscured by the floating bar. Accounts for bar height (68px) +
 * bottom offset (16px) + max safe-area inset (36px) + breathing room.
 */
export const FLOATING_TAB_CLEARANCE = 128;

const BAR_HEIGHT = 68;

type IconName = ComponentProps<typeof FontAwesome>['name'];

const ROUTE_ICONS: Record<string, IconName> = {
  index:      'home',
  schedule:   'calendar',
  bookings:   'bookmark',
  membership: 'star',
  profile:    'user',
};

// ---------------------------------------------------------------------------
// Single tab item with spring press + animated accent indicator
// ---------------------------------------------------------------------------

function TabItem({
  routeName,
  isFocused,
  accentColor,
  onPress,
  onLongPress,
}: {
  routeName: string;
  isFocused: boolean;
  accentColor: string;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const scale = useSharedValue(1);
  const dotScale = useSharedValue(isFocused ? 1 : 0);
  const iconOpacity = useSharedValue(isFocused ? 1 : 0.32);

  // Animate dot and icon opacity when focus changes
  useEffect(() => {
    dotScale.value = withSpring(isFocused ? 1 : 0, { damping: 18, stiffness: 320 });
    iconOpacity.value = withTiming(isFocused ? 1 : 0.32, { duration: 180 });
  }, [isFocused, dotScale, iconOpacity]);

  const scaleStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const dotStyle = useAnimatedStyle(() => ({ transform: [{ scale: dotScale.value }] }));
  const iconStyle = useAnimatedStyle(() => ({ opacity: iconOpacity.value }));

  const icon: IconName = ROUTE_ICONS[routeName] ?? 'circle';

  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: isFocused }}
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={() => { scale.value = withSpring(0.82, { damping: 16, stiffness: 450 }); }}
      onPressOut={() => { scale.value = withSpring(1.0, { damping: 14, stiffness: 200 }); }}
      style={{ flex: 1, alignItems: 'center', justifyContent: 'center', height: BAR_HEIGHT }}
    >
      <Animated.View style={[{ alignItems: 'center', gap: 5 }, scaleStyle]}>
        <Animated.View style={iconStyle}>
          <FontAwesome
            name={icon}
            size={22}
            color={isFocused ? accentColor : '#FFFFFF'}
          />
        </Animated.View>

        {/* Accent dot — springs in/out on tab switch */}
        <Animated.View
          style={[
            {
              width: 4,
              height: 4,
              borderRadius: 2,
              backgroundColor: accentColor,
            },
            dotStyle,
          ]}
        />
      </Animated.View>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Floating bar
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function FloatingTabBar({ state, descriptors: _descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const { primaryColor } = useBranding();

  return (
    // Outer wrapper is touch-transparent so gestures pass through the gap
    // between the pill bar and the screen edges.
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        bottom: insets.bottom + 16,
        left: 24,
        right: 24,
      }}
    >
      {/* The actual pill — glass morphism via layered translucency */}
      <View
        style={{
          flexDirection: 'row',
          backgroundColor: 'rgba(12,12,16,0.82)',
          borderRadius: 28,
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.10)',
          height: BAR_HEIGHT,
          alignItems: 'center',
          paddingHorizontal: 4,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 12 },
          shadowOpacity: 0.65,
          shadowRadius: 32,
          elevation: 26,
        }}
      >
        {/* Top edge highlight — simulates glass catching overhead light */}
        <View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 1,
            backgroundColor: 'rgba(255,255,255,0.14)',
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
          }}
        />
        {/* Subtle inner bottom shadow — depth below tabs */}
        <View
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: 18,
            backgroundColor: 'rgba(0,0,0,0.10)',
            borderBottomLeftRadius: 28,
            borderBottomRightRadius: 28,
          }}
        />

        {state.routes.map((route, index) => {
          const isFocused = state.index === index;

          const onPress = () => {
            const event = navigation.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            });
            if (!isFocused && !event.defaultPrevented) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              navigation.navigate(route.name as any, route.params as any);
            }
          };

          const onLongPress = () => {
            navigation.emit({ type: 'tabLongPress', target: route.key });
          };

          return (
            <TabItem
              key={route.key}
              routeName={route.name}
              isFocused={isFocused}
              accentColor={primaryColor}
              onPress={onPress}
              onLongPress={onLongPress}
            />
          );
        })}
      </View>
    </View>
  );
}
