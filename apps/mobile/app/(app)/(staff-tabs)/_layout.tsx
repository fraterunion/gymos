import { Tabs } from 'expo-router';

import { FloatingTabBar } from '@/components/FloatingTabBar';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import { canAccessStaffScan, canAccessTeamTab, staffTabsInitialRoute } from '@/lib/staffRole';
import { canAccessExecutiveDashboard } from '@/lib/executivePermissions';

export default function StaffTabsLayout() {
  const { matched } = useMemberStudio();
  const role = matched?.role;
  const showScan = canAccessStaffScan(role);
  const showTeam = canAccessTeamTab(role);
  const showDashboard = canAccessExecutiveDashboard(role);

  return (
    <Tabs
      initialRouteName={staffTabsInitialRoute(role)}
      tabBar={(props) => <FloatingTabBar {...props} />}
      screenOptions={{
        headerShown: false,
      }}
    >
      <Tabs.Screen
        name="dashboard"
        options={{
          href: showDashboard ? undefined : null,
        }}
      />
      <Tabs.Screen
        name="scan"
        options={{
          href: showScan ? undefined : null,
        }}
      />
      <Tabs.Screen name="horario" />
      <Tabs.Screen
        name="team"
        options={{
          href: showTeam ? undefined : null,
        }}
      />
      <Tabs.Screen name="profile" />
    </Tabs>
  );
}
