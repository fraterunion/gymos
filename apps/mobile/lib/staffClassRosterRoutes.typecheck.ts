import { staffClassRosterHref, STAFF_CLASS_ROSTER_ROUTE } from '@/lib/staffClassRosterRoutes';

/** Type-checked canonical staff roster route used by Today and Schedule tabs. */
export function assertStaffRosterRouteTypes(): void {
  const href = staffClassRosterHref('cls_123', 'ARES Flow');
  void href;
  void STAFF_CLASS_ROSTER_ROUTE;
}

assertStaffRosterRouteTypes();
