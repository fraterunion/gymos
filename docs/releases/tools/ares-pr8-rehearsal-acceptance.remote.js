// REHEARSAL-ONLY acceptance for PR #8 (range cancellation + campaign delivery state).
// Synthetic data in studio 'ares-pr5-isolated-acceptance' only. Drives the real HTTP API of this
// container with a short-lived token minted for that studio's synthetic OWNER (never printed).
// Prints counts/states only.
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');
const D8 = require('/app/apps/api/dist/common/date/studio-local-date.js');
const c = new PrismaClient();
const BASE = `http://127.0.0.1:${process.env.PORT || 3000}/api/v1`;
const RUN = process.env.PR8_RUN || '1';
const out = { run: RUN, steps: {} };
const fail = (m) => { throw new Error(m); };

async function api(method, path, token, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

(async () => {
  // ── Guards ─────────────────────────────────────────────────────────────────────────────
  const host = new URL(process.env.DATABASE_URL).hostname;
  if (process.env.RAILWAY_ENVIRONMENT_NAME !== 'release-rehearsal') fail('not release-rehearsal');
  if (host !== 'postgres-rehearsal.railway.internal') fail('not the isolated rehearsal DB');
  if (process.env.EMAIL_CAMPAIGN_WORKER !== '0') fail('campaign worker not paused');
  if (!(process.env.RAILWAY_GIT_COMMIT_SHA || '').startsWith('4a4571e')) fail('not PR #8 head');
  out.guards = { env: 'release-rehearsal', db: host, worker: '0', commit: process.env.RAILWAY_GIT_COMMIT_SHA.slice(0, 7) };

  const studio = await c.studio.findFirst({ where: { slug: 'ares-pr5-isolated-acceptance', deletedAt: null } });
  if (!studio) fail('QA studio missing');
  const tz = studio.timezone;
  const ownerM = await c.studioMembership.findFirst({ where: { studioId: studio.id, role: 'OWNER', deletedAt: null }, include: { user: true } });
  if (!ownerM || !ownerM.user.email.endsWith('.invalid')) fail('synthetic owner missing');
  const sign = (u) => jwt.sign({ sub: u.id, email: u.email, platformRole: null }, process.env.JWT_SECRET, { expiresIn: '15m' });
  const owner = sign(ownerM.user);
  const S = `/studios/${studio.id}`;

  // ── Synthetic seed (QA studio only) ───────────────────────────────────────────────────
  const today = D8.getStudioLocalDateKey(new Date(), tz);
  const D = (n) => D8.addDaysToDateKey(today, n);
  const at = (k, hm) => D8.studioLocalTimeToUtc(k, hm, tz);
  const tpl = async (name) => (await c.classTemplate.findFirst({ where: { studioId: studio.id, name } }))
    ?? c.classTemplate.create({ data: { studioId: studio.id, name, durationMinutes: 60, defaultCapacity: 10, equipment: [], tags: [] } });
  const yoga = await tpl('PR8 Yoga Rango');
  const hiit = await tpl('PR8 HIIT Rango');
  const instructorEmail = 'pr8-instructor@pr8-rehearsal.invalid';
  const instructor = (await c.user.findUnique({ where: { email: instructorEmail } }))
    ?? (await c.user.create({ data: { email: instructorEmail, firstName: 'Instructor', lastName: 'PR8' } }));
  if (!(await c.studioMembership.findFirst({ where: { studioId: studio.id, userId: instructor.id } }))) {
    await c.studioMembership.create({ data: { studioId: studio.id, userId: instructor.id, role: 'INSTRUCTOR' } });
  }
  const members = (await c.studioMembership.findMany({ where: { studioId: studio.id, role: 'MEMBER', deletedAt: null, user: { email: { endsWith: '.invalid' } } }, take: 3, include: { user: true } })).map((m) => m.user);
  if (members.length < 3) fail('need 3 synthetic members');

  const offset = Number(RUN) * 7; // minutes, keeps re-runs off earlier slots
  const hm = (h, m) => `${String(h).padStart(2, '0')}:${String(m + offset).padStart(2, '0')}`;
  const fromDate = D(21), toDate = D(41);
  const series = await api('POST', `${S}/schedule-series`, owner, {
    classTemplateId: yoga.id, instructorId: instructor.id, daysOfWeek: [1, 3], startTime: hm(6, 10),
    intervalWeeks: 1, startsOn: D(14), endsOn: D(49), capacity: 10, confirmWarnings: true,
  });
  out.steps.createSeries = series.status;
  const gen1 = await api('POST', `${S}/schedule-generator/generate`, owner, { mode: 'CUSTOM', toDate: D(50) });
  out.steps.generator1 = { http: gen1.status, created: gen1.body?.totalGenerated ?? gen1.body?.generated ?? null };
  const oneOff = (startsAt) => c.scheduledClass.create({ data: { studioId: studio.id, classTemplateId: hiit.id, capacity: 3, status: 'SCHEDULED', startsAt, endsAt: new Date(startsAt.getTime() + 3600_000) } });
  const firstMinute = await oneOff(at(fromDate, hm(0, 1)));
  const beforeRange = await oneOff(at(D(20), hm(23, 1)));
  const lastLocal = await oneOff(at(toDate, hm(23, 1)));
  const afterRange = await oneOff(at(D(42), hm(0, 1)));
  const booked = await oneOff(at(D(23), hm(19, 1)));
  for (const m of members.slice(0, 2)) await c.booking.create({ data: { studioId: studio.id, scheduledClassId: booked.id, userId: m.id, status: 'CONFIRMED' } });
  await c.waitlistEntry.create({ data: { studioId: studio.id, scheduledClassId: booked.id, userId: members[2].id, status: 'WAITING', position: 1 } });
  const checkedIn = await oneOff(at(D(30), hm(19, 1)));
  await c.booking.create({ data: { studioId: studio.id, scheduledClassId: checkedIn.id, userId: members[2].id, status: 'CONFIRMED' } });
  await c.attendance.create({ data: { studioId: studio.id, scheduledClassId: checkedIn.id, userId: members[2].id, method: 'MANUAL', checkedInAt: new Date() } });
  const range = { start: D8.studioLocalDateKeyToUtcAnchor(fromDate, tz), end: D8.studioLocalDateKeyToUtcAnchor(D8.addDaysToDateKey(toDate, 1), tz) };
  const yogaInRange = await c.scheduledClass.findMany({ where: { studioId: studio.id, classTemplateId: yoga.id, startsAt: { gte: range.start, lt: range.end } } });
  out.seed = { timezone: tz, fromDate, toDate, recurringInRange: yogaInRange.length, oneOffs: 6, bookings: 3, waitlist: 1, earlyCheckIn: 1 };

  // ── Range cancellation over HTTP ──────────────────────────────────────────────────────
  const R = `${S}/schedule-operations/range-cancel`;
  const body = { fromDate, toDate, classTemplateIds: [yoga.id, hiit.id] };
  const p = await api('POST', `${R}/preview`, owner, body);
  const ids = (p.body?.classes || []).map((x) => x.id);
  out.steps.preview = {
    http: p.status, weekCount: p.body?.weekCount, totals: p.body?.totals,
    protected: (p.body?.protectedClasses || []).map((x) => x.reason),
    boundaryIncluded: ids.includes(firstMinute.id) && ids.includes(lastLocal.id),
    boundaryExcluded: !ids.includes(beforeRange.id) && !ids.includes(afterRange.id),
    recurringAllIncluded: yogaInRange.every((y) => ids.includes(y.id)),
  };
  const hiitOnly = await api('POST', `${R}/preview`, owner, { fromDate, toDate, classTemplateIds: [hiit.id] });
  const instrOnly = await api('POST', `${R}/preview`, owner, { fromDate, toDate, instructorIds: [instructor.id] });
  out.steps.filters = { hiitOnly: hiitOnly.body?.totals?.classes, instructorOnly: instrOnly.body?.totals?.classes };
  const otherOwnerM = await c.studioMembership.findFirst({ where: { role: 'OWNER', deletedAt: null, studioId: { not: studio.id } }, include: { user: true } });
  out.steps.crossStudio = otherOwnerM ? (await api('POST', `${R}/preview`, sign(otherOwnerM.user), body)).status : 'no other owner';
  const memberToken = sign(members[0]);
  out.steps.memberForbidden = (await api('POST', `${R}/preview`, memberToken, body)).status;

  const before = await c.scheduledClass.count({ where: { studioId: studio.id } });
  const key = `pr8-rehearsal-${RUN}-${Date.now()}`;
  const exec = { ...body, previewFingerprint: p.body.previewFingerprint, cancelReason: 'PR8 rehearsal acceptance', idempotencyKey: key, confirm: true };
  const [e1, e2] = await Promise.all([api('POST', R, owner, exec), api('POST', R, owner, exec)]);
  out.steps.execute = {
    http: [e1.status, e2.status],
    replayFlags: [e1.body?.idempotentReplay ?? false, e2.body?.idempotentReplay ?? false],
    cancelledCount: e1.body?.cancelledCount, cancelledBookingCount: e1.body?.cancelledBookingCount,
    expiredWaitlistCount: e1.body?.expiredWaitlistCount, protectedKept: (e1.body?.protectedClasses || []).length,
    sameResult: JSON.stringify([...(e1.body?.cancelledClassIds || [])].sort()) === JSON.stringify([...(e2.body?.cancelledClassIds || [])].sort()),
  };
  out.steps.staleFingerprintNewKey = (await api('POST', R, owner, { ...exec, idempotencyKey: `${key}-b` })).status;
  const gen2 = await api('POST', `${S}/schedule-generator/generate`, owner, { mode: 'CUSTOM', toDate: D(50) });
  const yogaAfter = await c.scheduledClass.findMany({ where: { studioId: studio.id, classTemplateId: yoga.id, startsAt: { gte: range.start, lt: range.end } } });
  out.steps.regeneration = { generatorHttp: gen2.status, inRangeBefore: yogaInRange.length, inRangeAfter: yogaAfter.length, allCancelled: yogaAfter.every((y) => y.status === 'CANCELLED'),
    futureOutsideRangeScheduled: await c.scheduledClass.count({ where: { studioId: studio.id, classTemplateId: yoga.id, status: 'SCHEDULED', startsAt: { gte: range.end } } }) };
  out.steps.db = {
    rowsBefore: before, rowsAfter: await c.scheduledClass.count({ where: { studioId: studio.id } }),
    protectedStillScheduled: (await c.scheduledClass.findUnique({ where: { id: checkedIn.id } })).status,
    protectedAttendance: await c.attendance.count({ where: { scheduledClassId: checkedIn.id } }),
    protectedBookingConfirmed: await c.booking.count({ where: { scheduledClassId: checkedIn.id, status: 'CONFIRMED' } }),
    bookedClassBookings: (await c.booking.findMany({ where: { scheduledClassId: booked.id } })).map((b) => `${b.status}/${b.cancelSource}`),
    bookedClassWaitlist: (await c.waitlistEntry.findMany({ where: { scheduledClassId: booked.id } })).map((w) => w.status),
    outsideRange: [(await c.scheduledClass.findUnique({ where: { id: beforeRange.id } })).status, (await c.scheduledClass.findUnique({ where: { id: afterRange.id } })).status],
    auditRows: await c.auditLog.count({ where: { studioId: studio.id, action: 'SCHEDULE_RANGE_CANCEL', metadata: { path: ['idempotencyKey'], equals: key } } }),
  };

  // ── Communications delivery state over HTTP (worker paused on rehearsal) ──────────────
  const C = `${S}/communications`;
  const st = await api('GET', `${C}/status`, owner);
  out.steps.commsStatus = { http: st.status, delivery: st.body?.delivery, senderSource: st.body?.sender?.source, unsubscribeConfigured: st.body?.unsubscribeConfigured, staleAfterMinutes: st.body?.staleAfterMinutes };
  const list = await api('GET', `${C}/campaigns`, owner);
  out.steps.commsCampaigns = (list.body || []).map((x) => ({ status: x.status, deliveryState: x.deliveryState, pendingCount: x.pendingCount,
    startedHoursAgo: x.startedAt ? Math.round((Date.now() - Date.parse(x.startedAt)) / 3600_000) : null }));
  const audience = { includeUserIds: [members[0].id] };
  const pv = await api('POST', `${C}/preview`, owner, audience);
  const created = await api('POST', `${C}/campaigns`, owner, { ...audience, subject: `PR8 rehearsal ${RUN}`, bodyText: 'Prueba sintética (rehearsal).', idempotencyKey: `pr8-comms-${RUN}-${Date.now()}`, previewFingerprint: pv.body?.previewFingerprint });
  const conf = await api('POST', `${C}/campaigns/${created.body?.id}/confirm`, owner, { confirm: true });
  out.steps.confirmWhilePaused = { createHttp: created.status, confirmHttp: conf.status, message: conf.body?.message, statusAfter: (await c.emailCampaign.findUnique({ where: { id: created.body?.id } }))?.status };
  out.steps.recipientsSent = await c.emailCampaignRecipient.count({ where: { studioId: studio.id, status: 'SENT' } });
  console.log('PR8ACCEPT ' + JSON.stringify(out));
})().catch((e) => console.log('PR8ACCEPT_ERR ' + String(e && e.message).slice(0, 300) + ' ' + JSON.stringify(out))).finally(() => c.$disconnect());
