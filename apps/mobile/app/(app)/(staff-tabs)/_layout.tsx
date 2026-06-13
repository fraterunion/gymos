import { Tabs } from 'expo-router';

import { FloatingTabBar } from '@/components/FloatingTabBar';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { canAccessStaffScan } from '@/lib/staffRole';

export default function StaffTabsLayout() {
  const { matched } = useMemberStudio();
  const role = matched?.role;
  const showScan = canAccessStaffScan(role);

  return (
    <Tabs
      initialRouteName={showScan ? 'scan' : 'today'}
      tabBar={(props) => <FloatingTabBar {...props} />}
      screenOptions={{
        headerShown: false,
      }}
    >
      <Tabs.Screen
        name="scan"
        options={{
          href: showScan ? undefined : null,
        }}
      />
      <Tabs.Screen name="today" />
      <Tabs.Screen name="profile" />
    </Tabs>
  );
}
