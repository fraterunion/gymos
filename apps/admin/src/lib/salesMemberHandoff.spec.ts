import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { MemberProfile } from "./api/members.ts";
import { parseSalesMemberParam, salesHrefForMember, salesMemberFromProfile, SALES_MEMBER_PARAM } from "./salesMemberHandoff.ts";

const MEMBER_ID = "cmvtwuxof0000pp2rp9bqsqhz";

function profile(overrides: { role?: MemberProfile["role"]; id?: string } = {}): MemberProfile {
  return {
    user: { id: overrides.id ?? MEMBER_ID, email: "qa-cash@example.invalid", firstName: "QA", lastName: "Efectivo", phone: null, createdAt: "2026-10-01T00:00:00.000Z" },
    role: overrides.role ?? "MEMBER",
    membership: { id: "sm_1", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" },
    bookingStats: { totalBookings: 3, attendedCount: 2, noShowCount: 1, cancelledCount: 0, upcomingCount: 0 },
  } as unknown as MemberProfile;
}

describe("Member 360 → Ventas handoff", () => {
  it("links to /sales with only the member id, which round-trips through the query string", () => {
    const href = salesHrefForMember(MEMBER_ID);
    assert.equal(href, `/sales?member=${MEMBER_ID}`);
    const param = new URL(href, "https://admin.example").searchParams.get(SALES_MEMBER_PARAM);
    assert.equal(parseSalesMemberParam(param), MEMBER_ID);
  });

  it("ignores anything that is not a plain id (never sent to the API)", () => {
    for (const raw of [null, undefined, "", "   ", "../studios/other", "a/b", "x?y=1", "id with spaces", "x".repeat(65)]) {
      assert.equal(parseSalesMemberParam(raw), null, String(raw));
    }
  });

  it("preselects only the requested MEMBER from the studio-scoped profile", () => {
    const row = salesMemberFromProfile(profile(), MEMBER_ID);
    assert.ok(row);
    assert.equal(row.user.id, MEMBER_ID);
    assert.equal(row.userId, MEMBER_ID);
    assert.equal(row.membershipId, "sm_1");
    assert.equal(row.role, "MEMBER");
    assert.equal(row.subscription, null);
  });

  it("refuses staff profiles and a profile that does not match the requested id", () => {
    assert.equal(salesMemberFromProfile(profile({ role: "STAFF" }), MEMBER_ID), null);
    assert.equal(salesMemberFromProfile(profile({ role: "OWNER" }), MEMBER_ID), null);
    assert.equal(salesMemberFromProfile(profile({ id: "cmsomeoneelse000000000000" }), MEMBER_ID), null);
  });
});
