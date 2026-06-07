import { Tabs } from 'expo-router';

import { FloatingTabBar } from '@/components/FloatingTabBar';
import { PublicScheduleProvider } from '@/contexts/PublicScheduleContext';

export default function MemberTabsLayout() {
  return (
    <PublicScheduleProvider>
      <Tabs
        tabBar={(props) => <FloatingTabBar {...props} />}
        screenOptions={{
          headerShown: false,
        }}
      >
        <Tabs.Screen name="index" />
        <Tabs.Screen name="schedule" />
        <Tabs.Screen name="bookings" />
        <Tabs.Screen name="membership" />
        <Tabs.Screen name="profile" />
      </Tabs>
    </PublicScheduleProvider>
  );
}
