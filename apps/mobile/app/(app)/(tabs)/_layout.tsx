import type { ComponentProps } from 'react';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Tabs } from 'expo-router';

import { useBranding } from '@/contexts/BrandingContext';
import { useColorScheme } from 'react-native';

function TabBarIcon(props: { name: ComponentProps<typeof FontAwesome>['name']; color: string }) {
  return <FontAwesome size={22} style={{ marginBottom: -2 }} {...props} />;
}

export default function MemberTabsLayout() {
  const colorScheme = useColorScheme();
  const { primaryColor, appDisplayName } = useBranding();
  const isDark = colorScheme === 'dark';

  return (
    <Tabs
      screenOptions={{
        headerShown: true,
        headerShadowVisible: false,
        headerStyle: {
          backgroundColor: isDark ? '#0a0a0a' : '#fafafa',
        },
        headerTitleStyle: { fontWeight: '600', fontSize: 17 },
        tabBarStyle: {
          backgroundColor: isDark ? '#0a0a0a' : '#fafafa',
          borderTopColor: isDark ? '#262626' : '#e5e5e5',
        },
        tabBarActiveTintColor: primaryColor,
        tabBarInactiveTintColor: isDark ? '#737373' : '#a3a3a3',
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: appDisplayName,
          tabBarLabel: 'Home',
          tabBarIcon: ({ color }) => <TabBarIcon name="home" color={color} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color }) => <TabBarIcon name="user" color={color} />,
        }}
      />
    </Tabs>
  );
}
