import { Tabs } from 'expo-router';

import { FloatingTabBar } from '@/components/FloatingTabBar';

export const unstable_settings = {
  initialRouteName: 'scan',
};

export default function StaffTabsLayout() {
  return (
    <Tabs
      initialRouteName="scan"
      tabBar={(props) => <FloatingTabBar {...props} />}
      screenOptions={{
        headerShown: false,
      }}
    >
      <Tabs.Screen name="scan" />
      <Tabs.Screen name="today" />
      <Tabs.Screen name="profile" />
    </Tabs>
  );
}
