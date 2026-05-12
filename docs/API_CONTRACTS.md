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

## Phase 1 — Studio access smoke (internal / legacy)

| Method | Path | Auth |
|--------|------|------|
| GET | `/studios/:studioId/verify` | JWT + `StudioMemberGuard` |
| GET | `/studios/:studioId/admin-only` | JWT + `StudioMemberGuard` + `ADMIN` |

These remain for guard wiring tests; product UIs should prefer Phase 2A routes above.
