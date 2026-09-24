import { IsIn, IsOptional } from 'class-validator';

export const DAY_PASS_LIST_SCOPES = ['all', 'upcoming', 'history'] as const;
export type DayPassListScope = (typeof DAY_PASS_LIST_SCOPES)[number];

export class ListMyDayPassesQueryDto {
  /**
   * all      — every purchased pass, newest day first (legacy default; older app builds)
   * upcoming — today and future days, soonest first (what the membership screen shows)
   * history  — past days, most recent first ("Ver historial")
   */
  @IsOptional()
  @IsIn(DAY_PASS_LIST_SCOPES)
  scope?: DayPassListScope;
}
