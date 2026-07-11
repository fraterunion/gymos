import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import type { ComponentProps } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Accent } from '@/constants/Theme';

/** Content height of the tab bar (icons + labels), excluding safe-area inset. */
export const TAB_BAR_HEIGHT = 64;

/**
 * Bottom padding that scrollable tab screens should add so content is not
 * hidden behind the fixed tab bar. Includes typical safe-area inset + breathing room.
 */
export const TAB_BAR_CLEARANCE = TAB_BAR_HEIGHT + 48;

/** @deprecated Use TAB_BAR_CLEARANCE */
export const FLOATING_TAB_CLEARANCE = TAB_BAR_CLEARANCE;

type IconName = ComponentProps<typeof FontAwesome>['name'];

const ROUTE_ICONS: Record<string, IconName> = {
  index: 'home',
  schedule: 'calendar',
  bookings: 'bookmark',
  membership: 'star',
  profile: 'user',
  scan: 'qrcode',
  today: 'calendar-check-o',
  horario: 'calendar',
  dashboard: 'line-chart',
  team: 'users',
};

const ROUTE_LABELS: Record<string, string> = {
  index: 'Inicio',
  schedule: 'Clases',
  bookings: 'Reservas',
  membership: 'Membresía',
  profile: 'Perfil',
  scan: 'Escanear',
  today: 'Hoy',
  horario: 'Horario',
  dashboard: 'Panel',
  team: 'Equipo',
};

const INACTIVE_COLOR = 'rgba(255,255,255,0.38)';

function TabItem({
  routeName,
  isFocused,
  onPress,
  onLongPress,
}: {
  routeName: string;
  isFocused: boolean;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const icon: IconName = ROUTE_ICONS[routeName] ?? 'circle';
  const label = ROUTE_LABELS[routeName] ?? routeName;
  const scale = useSharedValue(1);
  const anim = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: isFocused }}
      accessibilityLabel={label}
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={() => { scale.value = withTiming(0.94, { duration: 80 }); }}
      onPressOut={() => { scale.value = withTiming(1, { duration: 140 }); }}
      style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 10 }}
    >
      <Animated.View style={[{ alignItems: 'center' }, anim]}>
        {isFocused ? (
          <View
            style={{
              position: 'absolute',
              top: -6,
              width: 32,
              height: 3,
              borderRadius: 2,
              backgroundColor: Accent,
            }}
          />
        ) : null}
        <FontAwesome name={icon} size={22} color={isFocused ? '#FFFFFF' : INACTIVE_COLOR} />
        <Text
          style={{
            marginTop: 6,
            fontSize: 10,
            fontWeight: isFocused ? '700' : '500',
            letterSpacing: 0.2,
            color: isFocused ? '#FFFFFF' : INACTIVE_COLOR,
          }}
        >
          {label}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function FloatingTabBar({ state, descriptors: _descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();

  return (
    <View
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: '#000000',
        borderTopWidth: 1,
        borderTopColor: 'rgba(255,255,255,0.07)',
        paddingBottom: insets.bottom,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          height: TAB_BAR_HEIGHT,
          alignItems: 'center',
        }}
      >
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
              onPress={onPress}
              onLongPress={onLongPress}
            />
          );
        })}
      </View>
    </View>
  );
}
