import { validate } from 'class-validator';
import {
  buildManualAttendancePayload,
  GYMOS_CUID_PATTERN,
  INVALID_MEMBER_USER_ID_MESSAGE_ES,
  resolveMemberUserId,
} from '@gymos/utils';
import { ManualClassAttendanceDto } from './dto/manual-class-attendance.dto';

const SAMPLE_USER_ID = 'clh1234567890abcdefghijk';
const SAMPLE_MEMBERSHIP_ID = 'clm1234567890abcdefghijk';

describe('manual attendance memberId contract', () => {
  it('resolveMemberUserId prefers explicit userId over nested user.id', () => {
    expect(
      resolveMemberUserId({
        userId: SAMPLE_USER_ID,
        user: { id: 'clother1234567890abcdefghij' },
        membershipId: SAMPLE_MEMBERSHIP_ID,
      }),
    ).toBe(SAMPLE_USER_ID);
  });

  it('resolveMemberUserId falls back to user.id', () => {
    expect(
      resolveMemberUserId({
        user: { id: SAMPLE_USER_ID },
        membershipId: SAMPLE_MEMBERSHIP_ID,
      }),
    ).toBe(SAMPLE_USER_ID);
  });

  it('never uses membershipId as memberId', () => {
    expect(
      resolveMemberUserId({
        membershipId: SAMPLE_MEMBERSHIP_ID,
      }),
    ).toBeNull();
    expect(
      buildManualAttendancePayload({
        membershipId: SAMPLE_MEMBERSHIP_ID,
      }).ok,
    ).toBe(false);
  });

  it('buildManualAttendancePayload rejects invalid ids', () => {
    expect(buildManualAttendancePayload({ userId: 'not-a-cuid' }).ok).toBe(false);
    expect(buildManualAttendancePayload({ userId: '' }).ok).toBe(false);
    expect(buildManualAttendancePayload({}).ok).toBe(false);
  });

  it('buildManualAttendancePayload returns User.id as memberId', () => {
    expect(
      buildManualAttendancePayload({
        userId: SAMPLE_USER_ID,
        membershipId: SAMPLE_MEMBERSHIP_ID,
      }),
    ).toEqual({ ok: true, memberId: SAMPLE_USER_ID });
  });

  it('ManualClassAttendanceDto accepts Prisma User cuid', async () => {
    const dto = new ManualClassAttendanceDto();
    dto.memberId = SAMPLE_USER_ID;
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(GYMOS_CUID_PATTERN.test(SAMPLE_USER_ID)).toBe(true);
  });

  it('ManualClassAttendanceDto rejects RFC4122 uuid when User ids are cuids', async () => {
    const dto = new ManualClassAttendanceDto();
    dto.memberId = '550e8400-e29b-41d4-a716-446655440000';
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('documents Spanish client-side guard message', () => {
    expect(INVALID_MEMBER_USER_ID_MESSAGE_ES).toContain('Actualiza la lista');
  });

  it('client MemberListItem sends User.id as memberId, never membershipId', () => {
    const selectedMember = {
      membershipId: SAMPLE_MEMBERSHIP_ID,
      userId: SAMPLE_USER_ID,
      user: { id: SAMPLE_USER_ID },
    };
    expect(buildManualAttendancePayload(selectedMember)).toEqual({
      ok: true,
      memberId: SAMPLE_USER_ID,
    });
    expect(
      buildManualAttendancePayload({
        membershipId: SAMPLE_MEMBERSHIP_ID,
        user: { id: SAMPLE_MEMBERSHIP_ID },
      }).ok,
    ).toBe(false);
  });
});
