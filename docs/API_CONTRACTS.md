# API contracts

Base URL: `/api/v1` (global prefix). Health: `GET /health` (no prefix).

Authentication: `Authorization: Bearer <access_token>` unless noted.

---

## Phase 1 — Auth (existing)

| Method | Path | Auth | Notes |
|--------|------|------|--------|
| POST | `/auth/register` | — | Creates user; returns tokens. |
| POST | `/auth/login` | — | Returns tokens. |
| POST | `/auth/refresh` | — | Body: `{ refreshToken }`. |
| POST | `/auth/logout` | — | Body: `{ refreshToken }`. |
| POST | `/auth/logout-all` | JWT | Revokes refresh families. |
| GET | `/auth/me` | JWT | Current user profile. |

---

## Phase 3A — White-label branding (foundation)

No Stripe, mobile UI, app store builds, uploads, or refactors of booking/waitlist/check-in.

### White-label strategy

- **GymOS** = internal core platform and API.
- Each **client gym** ships its own **branded** member app (store listing, icon, colors, legal URLs, bundle IDs).
- **One backend**, many branded apps: runtime identity comes from **`slug`** + **`GET /public/studios/:slug/branding`** (and authenticated branding admin routes).
- **Future**: EAS / CI may generate per-tenant native projects from these fields; not in 3A.

**Mobile (Phase 3B):** the member app reads **`EXPO_PUBLIC_STUDIO_SLUG`** and calls this endpoint on launch before auth. See **`docs/MOBILE.md`**.

### Public branding (boot)

#### `GET /public/studios/:slug/branding`

- **Auth:** none.
- **Rules:** Studio must exist and **`deleted_at` IS NULL**. Otherwise **`404`**.
- **Response:** `200` — Public-safe JSON only: `slug`, `name`, `timezone`, and nullable branding fields (`appName`, `brandPrimaryColor`, `brandSecondaryColor`, `brandLogoUrl`, `brandIconUrl`, `brandSplashUrl`, `supportEmail`, `supportPhone`, `privacyUrl`, `termsUrl`, `iosBundleId`, `androidPackageName`, `appStoreUrl`, `playStoreUrl`). **No** internal ids or `deletedAt`.

### Studio branding (admin)

#### `GET /studios/:studioId/branding`

- **Auth:** JWT + `StudioMemberGuard` + **OWNER** or **ADMIN** only.
- **Response:** `200` — Same branding fields as public, plus **`id`**, **`slug`**, **`name`**, **`timezone`**.

#### `PATCH /studios/:studioId/branding`

- **Auth:** JWT + `StudioMemberGuard` + **OWNER** or **ADMIN** only.
- **Body:** Partial; only nullable branding fields above. **`id`**, **`slug`**, and **`name`** are **not** accepted here (use existing studio profile **`PATCH /studios/:studioId`** for name/slug).
- **Validation:** Hex colors **`#RGB`** / **`#RRGGBB`** (optional leading `#`, normalized to lowercase `#rrggbb`); URLs must be **`http`** or **`https`** with protocol; **`supportEmail`** as email; **`iosBundleId`** / **`androidPackageName`** as reverse-DNS–style strings.
- **Response:** `200` — Updated branding payload (admin shape).

---

## Phase 2A — Studio, membership plans, members

### Conventions

- **`studioId`** is always taken from the **URL path**. It is never read from the request body for authorization or scoping.
- **Soft deletes**: Users or memberships with `deletedAt` set are invisible to these endpoints. Studios with `deletedAt` set are rejected by `StudioMemberGuard`.
- **Roles** (`Role` enum): `MEMBER`, `INSTRUCTOR`, `STAFF`, `ADMIN`, `OWNER`. Staff-facing member directory endpoints require `STAFF` (or higher roles where union allows).

### User studio access

#### `GET /me/studios`

- **Auth:** JWT.
- **Response:** `200` — JSON array of objects:

```json
[
  {
    "studio": {
      "id": "string",
      "name": "string",
      "slug": "string",
      "timezone": "string"
    },
    "role": "MEMBER"
  }
]
```

- **Semantics:** One entry per **active** `StudioMembership` (`deletedAt` null) for a **non-deleted** user and **non-deleted** studio.

---

### Studios

#### `GET /studios/:studioId`

- **Auth:** JWT + `StudioMemberGuard` (active membership, non-deleted user & studio).
- **Response:** `200` — Full `Studio` row for that id (excluding soft-deleted studio → `404`).

#### `PATCH /studios/:studioId`

- **Auth:** JWT + `StudioMemberGuard` + role **OWNER** or **ADMIN**.
- **Body:** JSON partial; allowed fields only:
  - `name` — optional string, trimmed.
  - `slug` — optional string, lowercase kebab-case, unique among non-deleted studios.
  - `timezone` — optional string, trimmed.
- **Response:** `200` — Updated `Studio`.
- **Errors:** `404` studio not found; `409` slug conflict.

---

### Membership plans

All paths: `/studios/:studioId/membership-plans`.

#### `GET /studios/:studioId/membership-plans`

- **Auth:** JWT + `StudioMemberGuard`.
- **Response:** `200` — Array of plans where `active === true`, `deletedAt` null, for this `studioId`.

#### `POST /studios/:studioId/membership-plans`

- **Auth:** JWT + `StudioMemberGuard` + **OWNER** or **ADMIN**.
- **Body:**

| Field | Type | Required | Notes |
|-------|------|----------|--------|
| `name` | string | yes | Trimmed. |
| `description` | string | no | Trimmed. |
| `priceCents` | int | yes | ≥ 0. |
| `currency` | string | no | Default `usd`; trimmed lowercase, 3 chars. |
| `billingInterval` | enum | yes | `MONTHLY`, `YEARLY`, `WEEKLY`. |
| `classCredits` | int \| null | no | Omit or `null` = **unlimited** credits for the plan. |

- **Response:** `201` — Created `MembershipPlan`.

#### `PATCH /studios/:studioId/membership-plans/:planId`

- **Auth:** JWT + `StudioMemberGuard` + **OWNER** or **ADMIN**.
- **Body:** Partial update; safe fields only: `name`, `description` (including `null` to clear), `priceCents`, `currency`, `billingInterval`, `classCredits` (including `null` for unlimited), `active`.
- **Response:** `200` — Updated plan.
- **Errors:** `404` if plan missing, wrong studio, or already soft-deleted.

#### `DELETE /studios/:studioId/membership-plans/:planId`

- **Auth:** JWT + `StudioMemberGuard` + **OWNER** or **ADMIN**.
- **Response:** `204` — Soft delete: sets `deletedAt` and `active: false`. No hard delete.

---

### Members

All paths: `/studios/:studioId/members`.

#### `GET /studios/:studioId/members`

- **Auth:** JWT + `StudioMemberGuard` + **OWNER**, **ADMIN**, or **STAFF**.
- **Response:** `200` — Array of:

```json
{
  "membershipId": "string",
  "role": "MEMBER",
  "createdAt": "ISO-8601",
  "user": {
    "id": "string",
    "email": "string",
    "firstName": "string",
    "lastName": "string",
    "phone": null,
    "createdAt": "ISO-8601"
  }
}
```

- **Never includes:** `passwordHash`, `stripeCustomerId`.

#### `GET /studios/:studioId/members/:userId`

- **Auth:** JWT + `StudioMemberGuard` + **OWNER**, **ADMIN**, or **STAFF**.
- **Response:** `200` — Object:

```json
{
  "user": { "id", "email", "firstName", "lastName", "phone", "createdAt" },
  "role": "MEMBER",
  "membership": { "id", "createdAt", "updatedAt" },
  "attendances": { "totalInStudio": 0 },
  "activeSubscription": null
}
```

- **`activeSubscription`:** If the user has a subscription in this studio with status `ACTIVE` or `TRIALING`, includes plan summary (plan id, name, billing, price, `classCredits`). Stripe ids are omitted.
- **Errors:** `404` if user has no active membership in this studio or user is soft-deleted.

#### `PATCH /studios/:studioId/members/:userId/role`

- **Auth:** JWT + `StudioMemberGuard` + **OWNER** or **ADMIN**.
- **Body:** `{ "role": "<Role enum>" }`.
- **Rules:** Caller **cannot** change their **own** role (`400`).
- **Response:** `200` — Updated `StudioMembership` including `user` (public fields only).
- **Errors:** `404` if target is not an active member.

---

## Phase 2B — Class templates and schedule

All paths are under `/studios/:studioId/...`. **`studioId` is always from the URL.** No booking, waitlist, or payment logic.

### Class templates — `/studios/:studioId/class-templates`

#### `GET /studios/:studioId/class-templates`

- **Auth:** JWT + `StudioMemberGuard`.
- **Response:** `200` — Non–soft-deleted templates for the studio, including optional **`defaultInstructor`** summary (id, email, firstName, lastName, phone only — no secrets).

#### `POST /studios/:studioId/class-templates`

- **Auth:** JWT + `StudioMemberGuard` + **OWNER** or **ADMIN**.
- **Body:**

| Field | Type | Required | Notes |
|-------|------|----------|--------|
| `name` | string | yes | Trimmed. |
| `description` | string \| null | no | Trimmed. |
| `durationMinutes` | int | yes | 1–1440. |
| `defaultCapacity` | int | no | Default **10** when omitted; used when creating scheduled classes without explicit capacity. |
| `color` | string \| null | no | Short token (e.g. hex), max 32 chars. |
| `instructorId` | string \| null | no | Maps to template default instructor; if set, user must have an **active** `StudioMembership` in this studio and not be soft-deleted. |

- **Response:** `201` — Created `ClassTemplate`.

#### `PATCH /studios/:studioId/class-templates/:templateId`

- **Auth:** JWT + `StudioMemberGuard` + **OWNER** or **ADMIN**.
- **Body:** Partial; safe fields only: `name`, `description`, `durationMinutes`, `defaultCapacity`, `color`, `instructorId` (including `null` to clear default instructor).
- **Response:** `200` — Updated template.
- **Errors:** `404` if template missing, wrong studio, or already soft-deleted.

#### `DELETE /studios/:studioId/class-templates/:templateId`

- **Auth:** JWT + `StudioMemberGuard` + **OWNER** or **ADMIN**.
- **Response:** `204` — Soft delete (`deletedAt` set). No hard delete.

---

### Schedule — `/studios/:studioId/schedule`

#### `GET /studios/:studioId/schedule`

- **Auth:** JWT + `StudioMemberGuard`.
- **Query (required):** `from`, `to` — ISO 8601 date strings (`IsDateString`); **`from` &lt; `to`**.
- **Semantics:** Returns scheduled classes whose interval **overlaps** `[from, to)`, scoped to `studioId`, and whose **template is not soft-deleted**.
- **Response:** `200` — Array of scheduled classes with **`classTemplate`** summary (id, name, durationMinutes, description, defaultCapacity, color) and **`instructor`** summary (or `null`) — no `passwordHash` / `stripeCustomerId`.

#### `POST /studios/:studioId/schedule`

- **Auth:** JWT + `StudioMemberGuard` + **OWNER**, **ADMIN**, or **STAFF**.
- **Body:**

| Field | Type | Required | Notes |
|-------|------|----------|--------|
| `templateId` | string | yes | Must belong to this studio and not be soft-deleted. |
| `startTime` | datetime (ISO) | yes | Parsed to `Date`. |
| `endTime` | datetime (ISO) | yes | Must be **after** `startTime`. |
| `capacity` | int | no | If omitted, uses template **`defaultCapacity`**. Must be **&gt; 0** when set or defaulted. |
| `instructorId` | string \| null | no | If set, user must be an active member of this studio (not soft-deleted). |

- **Response:** `201` — Created `ScheduledClass` with `status: SCHEDULED`.

#### `PATCH /studios/:studioId/schedule/:scheduledClassId`

- **Auth:** JWT + `StudioMemberGuard` + **OWNER**, **ADMIN**, or **STAFF**.
- **Body:** Partial; safe fields: `startTime`, `endTime`, `capacity` (&gt; 0), `instructorId` (nullable), `status` (`ClassStatus`), `cancelReason` (nullable).
- **Validation:** Resulting (or existing) window must have **start &lt; end**. Tenant: row must belong to `studioId`.
- **Response:** `200` — Updated row. No hard delete.

#### `DELETE /studios/:studioId/schedule/:scheduledClassId`

- **Auth:** JWT + `StudioMemberGuard` + **OWNER** or **ADMIN** only.
- **Body (optional):** `{ "cancelReason"?: string }` — omit body or send `{}` if no reason.
- **Response:** `204` — Sets `status` to **`CANCELLED`**; sets **`cancelReason`** when provided in body. Row remains in DB.

---

## Phase 2C — Bookings (foundation)

No waitlist, payments, attendance, or QR. **`studioId` and `classId` / `bookingId` are always from the URL.**

### Create booking

#### `POST /studios/:studioId/classes/:classId/bookings`

- **Auth:** JWT + `StudioMemberGuard`.
- **Body:** none (books **for the authenticated user**).
- **Rules:**
  - Scheduled class must belong to `studioId`, `status === SCHEDULED`, and **`startsAt` in the future**.
  - **Capacity:** live `COUNT(*)` of rows with `status = CONFIRMED` for that class must be **&lt;** `capacity` before insert.
  - **Concurrency:** server takes `pg_advisory_xact_lock` on key **`booking_class_<scheduledClassId>`** (hashed via `hashtext`) inside the same DB transaction as the count + insert (only this lock uses raw SQL). The **same** lock is used for booking cancel, waitlist join/cancel, and waitlist promotion.
  - **MEMBER** studio role: must have a subscription in this studio with status **`ACTIVE`** or **`TRIALING`**.
  - **STAFF**, **INSTRUCTOR**, **ADMIN**, **OWNER**: subscription check skipped.
  - **Partial unique index:** at most one **CONFIRMED** booking per `(studio_id, scheduled_class_id, user_id)`. On unique violation → **`409`** with message **`Already booked for this class`**.
  - When class is full → **`409`** with message indicating class is full.
- **Response:** `201` — Booking with `status: CONFIRMED`.

### Cancel booking

#### `POST /studios/:studioId/bookings/:bookingId/cancel`

- **Auth:** JWT + `StudioMemberGuard`.
- **Rules:** Booking must belong to `studioId`. Caller may cancel **their own** booking, or staff (**STAFF**, **INSTRUCTOR**, **ADMIN**, **OWNER**) may cancel another member’s booking. Idempotent if already **`CANCELLED`** (returns **`cancelled: false`**; no promotion).
- **Response:** `200` — JSON body (never raw Prisma rows):
  - **`cancelled`:** `true` if this call moved the booking to **`CANCELLED`**; `false` if it was already cancelled.
  - **`promotion`:** `null`, or an object when the next **`WAITING`** waitlist member was promoted in the **same** transaction: `{ "performed": true, "bookingId", "waitlistEntryId", "userId" }`.
- **Semantics:** Sets `status` to **`CANCELLED`**, `cancelSource` (`MEMBER` vs `STUDIO`), `cancelledAt`. **Never deletes** the booking row. If creating the promoted **`CONFIRMED`** booking hits a unique constraint (**P2002**), the **entire** transaction (including the cancellation) is rolled back and the client receives **`409`**.

---

## Phase 2E — Waitlist (foundation)

No notifications, expiration jobs, Stripe, or UI. **`studioId`** and **`classId`** / **`entryId`** come from the URL.

### Join waitlist

#### `POST /studios/:studioId/classes/:classId/waitlist`

- **Auth:** JWT + `StudioMemberGuard`.
- **Rules:** Class must be **`SCHEDULED`** with **`startsAt` in the future**. **MEMBER** (non-elevated roles) need **`ACTIVE`** or **`TRIALING`** subscription in the studio; **STAFF** / **INSTRUCTOR** / **ADMIN** / **OWNER** bypass subscription. Inside a transaction with advisory lock **`booking_class_<classId>`**: live **`COUNT`** of **`CONFIRMED`** bookings must be **`>= capacity`** (class truly full); otherwise **`409`** **`Class has available spots — please book directly`**. Reject if the user already has a **`CONFIRMED`** booking, a **`WAITING`** waitlist row, or a **`PROMOTED`** row for this class. **`position`** is **`max(position)+1`** over all waitlist rows for that class (monotonic; no resequencing on cancel).
- **Response:** `201` — `{ id, studioId, scheduledClassId, status, position, createdAt }` (no secrets).

### Cancel waitlist entry

#### `POST /studios/:studioId/waitlist/:entryId/cancel`

- **Auth:** JWT + `StudioMemberGuard`.
- **Rules:** Entry must belong to `studioId`. The waitlist member may cancel their own entry; **STAFF** / **INSTRUCTOR** / **ADMIN** / **OWNER** may cancel another member’s **`WAITING`** entry. Uses the same **`booking_class_<classId>`** advisory lock. **`WAITING`** → **`CANCELLED`** only; **never** hard-deletes. Idempotent if already **`CANCELLED`**. **`PROMOTED`** cannot be cancelled here → **`409`**.

### Staff class waitlist

#### `GET /studios/:studioId/classes/:classId/waitlist`

- **Auth:** JWT + `StudioMemberGuard` + **STAFF**, **INSTRUCTOR**, **ADMIN**, or **OWNER**.
- **Response:** `200` — Array ordered **`WAITING`** first (each with dynamic **`queueRank`** 1…n by `position` / `createdAt`), then **`PROMOTED`** entries with **`queueRank: null`**. User payload is safe subset only.

### My waitlist

#### `GET /studios/:studioId/waitlist/me`

- **Auth:** JWT + `StudioMemberGuard`.
- **Response:** `200` — Caller’s **`WAITING`** and **`PROMOTED`** entries for this studio (excludes **`CANCELLED`** / **`EXPIRED`**). Includes `queueRank`, `waitingCountForClass`, and `scheduledClass` summary.

---

### My upcoming bookings

#### `GET /studios/:studioId/bookings/me`

- **Auth:** JWT + `StudioMemberGuard`.
- **Response:** `200` — Caller’s **`CONFIRMED`** bookings where the scheduled class is **`SCHEDULED`**, **`startsAt` ≥ now**, and the user is not soft-deleted. Includes `scheduledClass` summary (no secrets).

### Class roster

#### `GET /studios/:studioId/classes/:classId/roster`

- **Auth:** JWT + `StudioMemberGuard` + **INSTRUCTOR**, **ADMIN**, or **OWNER** only (not **STAFF**).
- **Response:** `200` — **`CONFIRMED`** bookings with **user** summary (id, email, firstName, lastName, phone). Never **`passwordHash`** or **`stripeCustomerId`**.

---

## Phase 2D — Attendance & QR check-in (foundation)

No payments, waitlists, notifications, or UI. **`studioId`**, **`bookingId`**, and **`classId`** are always from the URL (except manual body includes `bookingId` for the booking to check in).

### QR token for a booking

#### `POST /studios/:studioId/bookings/:bookingId/qr`

- **Auth:** JWT + `StudioMemberGuard`.
- **Rules:** Booking belongs to `studioId`. Only the **booking owner** may call. Booking must be **`CONFIRMED`**. Response includes a **signed JWT** (`JWT_QR_SECRET`, **5 minute** expiry). Server stores **`SHA-256`** of the token in **`qr_tokens.token_hash`** only — **never** stores the raw token.
- **Response:** `201` — `{ "qrToken": string, "expiresAt": "<ISO>" }`.

### QR check-in (staff)

#### `POST /studios/:studioId/check-ins/qr`

- **Auth:** JWT + `StudioMemberGuard` + **STAFF**, **INSTRUCTOR**, **ADMIN**, or **OWNER**.
- **Body:** `{ "qrToken": string }`.
- **Rules:** Verify JWT signature and claims `{ sub, studioId, bookingId }` match URL `studioId`. In one DB transaction: atomically claim the token with **`UPDATE … WHERE`** semantics (`updateMany` on `qr_tokens` for this `studioId` + `token_hash` with **`used_at` null**, **`invalidated_at` null**, **`expires_at` > now** → set **`used_at`**). If **no row** was updated → **`409`** **`QR token already used or expired`** (covers unknown hash, already used, expired, or invalidated). Then create **`Attendance`** (`method: QR`). Unique `(scheduled_class_id, user_id)` violation → **`409`** **`Already checked in`**. Invalid / expired **JWT** (before DB) → **`401`**. Outside window → **`400`**.

### Manual check-in

#### `POST /studios/:studioId/check-ins/manual`

- **Auth:** JWT + `StudioMemberGuard` + **STAFF**, **INSTRUCTOR**, **ADMIN**, or **OWNER**.
- **Body:** `{ "bookingId": string }` — must belong to `studioId`.
- **Rules:** Same booking/class/window rules as QR (no token). **`Attendance.method`** = **`MANUAL`**; **`checked_in_by_user_id`** = authenticated user.
- **Response:** `201` — Attendance summary (see below). Duplicate → **`409`** **`Already checked in`**.

### Booking attendance (single)

#### `GET /studios/:studioId/bookings/:bookingId/attendance`

- **Auth:** JWT + `StudioMemberGuard`.
- **Rules:** Booking owner **or** **STAFF** / **INSTRUCTOR** / **ADMIN** / **OWNER** may read.
- **Response:** `200` — `{ "attendance": AttendanceSummary | null }` (null if not checked in yet).

### Class attendance list

#### `GET /studios/:studioId/classes/:classId/attendance`

- **Auth:** JWT + `StudioMemberGuard` + **STAFF**, **INSTRUCTOR**, **ADMIN**, or **OWNER**.
- **Response:** `200` — Array of **AttendanceSummary** objects ordered by `checkedInAt`. Nested **user** is safe subset only (no **`passwordHash`** / **`stripeCustomerId`**).

### AttendanceSummary (stable shape)

- `id`, `studioId`, `scheduledClassId`, `userId`, `checkInMethod` (`QR` \| `MANUAL` \| …), `checkedInAt`, `checkedInByUserId` (null for QR), `user`: `{ id, email, firstName, lastName, phone }`.

---

## Phase 1 — Studio access smoke (internal / legacy)

| Method | Path | Auth |
|--------|------|------|
| GET | `/studios/:studioId/verify` | JWT + `StudioMemberGuard` |
| GET | `/studios/:studioId/admin-only` | JWT + `StudioMemberGuard` + `ADMIN` |

These remain for guard wiring tests; product UIs should prefer Phase 2A routes above.
