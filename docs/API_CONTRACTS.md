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

## Phase 1 — Studio access smoke (internal / legacy)

| Method | Path | Auth |
|--------|------|------|
| GET | `/studios/:studioId/verify` | JWT + `StudioMemberGuard` |
| GET | `/studios/:studioId/admin-only` | JWT + `StudioMemberGuard` + `ADMIN` |

These remain for guard wiring tests; product UIs should prefer Phase 2A routes above.
