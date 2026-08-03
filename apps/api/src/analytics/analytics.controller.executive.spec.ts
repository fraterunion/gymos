import { Role } from '@prisma/client';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../auth/constants';
import { AnalyticsController } from './analytics.controller';
import { ExecutiveDashboardService } from './executive-dashboard.service';

describe('AnalyticsController executive authorization', () => {
  const reflector = new Reflector();

  it('restricts GET executive to OWNER and ADMIN only', () => {
    const roles = reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      AnalyticsController.prototype.getExecutive,
      AnalyticsController,
    ]);
    expect(roles).toEqual([Role.OWNER, Role.ADMIN]);
    expect(roles).not.toContain(Role.STAFF);
  });

  it('restricts GET financial-activity to OWNER and ADMIN only', () => {
    const roles = reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      AnalyticsController.prototype.getFinancialActivity,
      AnalyticsController,
    ]);
    expect(roles).toEqual([Role.OWNER, Role.ADMIN]);
    expect(roles).not.toContain(Role.STAFF);
  });

  it('keeps other analytics routes available to STAFF via class decorator', () => {
    const classRoles = Reflect.getMetadata(ROLES_KEY, AnalyticsController);
    expect(classRoles).toContain(Role.STAFF);
  });
});

describe('ExecutiveDashboardService query budget', () => {
  it('documents a query budget under 25', () => {
    expect(ExecutiveDashboardService.QUERY_BUDGET).toBeLessThanOrEqual(25);
    expect(ExecutiveDashboardService.QUERY_BUDGET).toBe(19);
  });
});
