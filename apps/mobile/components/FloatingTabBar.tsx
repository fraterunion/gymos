import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import type { ComponentProps } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** Content height of the tab bar (icons + labels), excluding safe-area inset. */
export const TAB_BAR_HEIGHT = 56;

/**
 * Bottom padding that scrollable tab screens should add so content is not
 * hidden behind the fixed tab bar. Includes typical safe-area inset + breathing room.
 */
export const TAB_BAR_CLEARANCE = TAB_BAR_HEIGHT + 52;

/** @deprecated Use TAB_BAR_CLEARANCE */
export const FLOATING_TAB_CLEARANCE = TAB_BAR_CLEARANCE;

type IconName = ComponentProps<typeof FontAwesome>['name'];

const ROUTE_ICONS: Record<string, IconName> = {
  index: 'home',
  schedule: 'calendar',
  bookings: 'bookmark',
  membership: 'star',
  profile: 'user',
  // Staff tabs
  scan: 'qrcode',
  today: 'calendar-check-o',
  team: 'users',
};

const ROUTE_LABELS: Record<string, string> = {
  index: 'Inicio',
  schedule: 'Clases',
  bookings: 'Reservas',
  membership: 'Membresía',
  profile: 'Perfil',
  // Staff tabs
  scan: 'Escanear',
  today: 'Hoy',
  team: 'Equipo',
};

const ACTIVE_COLOR = '#FFFFFF';
const INACTIVE_COLOR = '#6B6B70';

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
  const color = isFocused ? ACTIVE_COLOR : INACTIVE_COLOR;
  const icon: IconName = ROUTE_ICONS[routeName] ?? 'circle';
  const label = ROUTE_LABELS[routeName] ?? routeName;

  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: isFocused }}
      accessibilityLabel={label}
      onPress={onPress}
      onLongPress={onLongPress}
      style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 8 }}
    >
      <FontAwesome name={icon} size={26} color={color} />
      <Text
        style={{
          marginTop: 5,
          fontSize: 10,
          fontWeight: isFocused ? '600' : '500',
          letterSpacing: 0.1,
          color,
        }}
      >
        {label}
      </Text>
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
        backgroundColor: '#0A0A0A',
        borderTopWidth: 1,
        borderTopColor: 'rgba(255,255,255,0.08)',
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
