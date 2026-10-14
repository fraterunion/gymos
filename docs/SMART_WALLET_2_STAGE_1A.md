# Smart Wallet 2.0 — Stage 1A: foundation

Status: **implemented locally on `feat/smart-wallet-foundation`. Not deployed. Every new flag is
OFF by default.** The real-iPhone staging test is specified in
[`SMART_WALLET_2_STAGING_SPIKE.md`](./SMART_WALLET_2_STAGING_SPIKE.md) and has not been run.

Stage 1A proves the critical architecture of a server-authoritative, self-updating Apple Wallet
pass without changing what any member sees today:

1. a pure **WalletAccessSnapshot** computed from canonical entitlement;
2. the **static plan-name fix** (see [`WALLET_STATIC_PLAN_NAME_FIX.md`](./WALLET_STATIC_PLAN_NAME_FIX.md));
3. **dynamic Apple passes** with the same identity as the static pass, a PassKit web service URL,
   and a per-pass authentication token;
4. the **PassKit web service** and an **APNs client**, behind disabled flags;
5. an **operator CLI** that works on one credential at a time, with no background jobs.

The pass stays informational. Check-in and booking authorization are unchanged and never read
anything introduced here.

## 1. WalletAccessSnapshot

`src/wallet/access/wallet-access-snapshot.ts`: pure function `computeWalletAccessSnapshot(input, now)`.

- **Inputs.** The studio timezone, the member, the credential (`revokedAt`), whether the studio
  membership is active, every subscription row with its plan's scope fields, and ACTIVE day
  passes. `WalletAccessSnapshotLoader` reads them, scoped by the credential's own
  `(studioId, userId)`.
- **Entitlement.** Only `deriveMembershipLifecycle` decides entitlement, and only
  `selectPrimaryMembership` picks the primary membership. `Subscription.status` is never read on
  its own to decide whether a membership is current.
- **Overall state**, in precedence order:

  | State | Meaning |
  |---|---|
  | `CREDENTIAL_REVOKED` | The credential was revoked. The pass discloses nothing else. |
  | `NO_MEMBERSHIP` | Not a member of the studio, or no rows at all. |
  | `ACCESS_VALID` | At least one membership is entitled now. |
  | `DAY_PASS_TODAY` | No membership is entitled, but there is an ACTIVE day pass for studio-local today. |
  | `PAYMENT_PENDING` | A membership is `PAST_DUE`. |
  | `SCHEDULED` | A membership has not started yet (`SCHEDULED`, or a future `currentPeriodStart`). |
  | `INACTIVE` | Memberships existed and ended (expired, canceled, paused). |

- **Supersession.** Superseded rows (`supersededBySubscriptionId` set, or a supersession
  `endReason`) are history and are never listed as non-entitled memberships.
- **`nextTransitionAt`** is the earliest future instant at which the snapshot could change purely
  because time passed. Candidates are an entitled window's end, a scheduled start, or a
  studio-local midnight for a day pass. It is stored on the artifact. Stage 1A has no scheduler
  that acts on it.

`wallet-access-display.ts` maps a snapshot to es-MX pass fields. It uses a fixed month table so
output does not depend on the Node ICU build. Wording rules:

- The header shows the membership **state** (`VIGENTE`, `VENCIDA`, `PAGO PENDIENTE`, `PROGRAMADA`,
  `PASE DE DÍA`, `SIN MEMBRESÍA`, `REEMPLAZADO`). It never says "ACCESO".
- Scope text comes only from plan fields. A class-limited plan reads "Clases de tu plan · N clases
  por periodo" and never mentions gym access. Gym access ("Gimnasio", with its hours window) appears
  only when `openGymAccess` is true. A day pass says "Clases del pase de día" only.
- An end at studio-local midnight is shown as the previous day. Any other end shows the date and
  time, e.g. "Vigente hasta el 9 oct 2026, 06:03".
- `voided` is true **only** for a revoked credential, never because a membership lapsed.

## 2. Dynamic Apple pass

`pkpass-dynamic-builder.ts` builds the pass JSON. `AppleWalletProvider.renderDynamicPass` renders
it without signing; `signRenderedPass` signs it.

- **Same identity as the static pass.** It keeps the same `serialNumber` (the WalletCredential id),
  the same barcode message, the same pass type, team and colors. Installing it over the static
  pass replaces that pass.
- **Additions.** `webServiceURL` (from `WALLET_PASSKIT_WEB_SERVICE_URL`) and a per-pass
  `authenticationToken`. The header carries the state, secondary fields carry plan and validity,
  an auxiliary field carries scope, and back fields carry one line per membership or day pass.
- **Omissions.** No `expirationDate`, `relevantDate`, locations or `changeMessage`, so nothing
  hides, surfaces or notifies by itself.
- **Versioning.** `APPLE_DYNAMIC_PASS_TEMPLATE_VERSION = 1` is stored in
  `dynamicTemplateVersion`, separate from the static `templateVersion`. A static template bump
  never touches a dynamic pass, and the reverse also holds. Fingerprint specs pin both templates.
- **Content hash.** SHA-256 over `pass.json` plus every packaged asset by name. It deliberately
  excludes the signature, which carries a signing time and is never byte-identical. Equal hashes
  mean an identical pass on the device.

### Token lifecycle (never rotated)

| Event | Token |
|---|---|
| Enrollment (STATIC → DYNAMIC) | Minted once: 32 random bytes, base64url, 43 characters. Only its SHA-256 is stored, in `authenticationTokenHash`. |
| Every later rebuild | Recovered from the stored signed pass and verified in constant time against the stored hash, then reused. |
| Recovery or verification fails | **The build fails** with `WALLET_DYNAMIC_TOKEN_UNRECOVERABLE`. Nothing is written and nothing is rotated. |

The barcode follows the same pattern. The raw credential is read from the stored pass and
accepted only if its SHA-256 equals the credential row's hash; otherwise the error is
`WALLET_DYNAMIC_BARCODE_UNRECOVERABLE`.

### Writes

`WalletDynamicPassService.enroll` / `refresh`:

1. Read the rows, compute the snapshot, render, and sign. No transaction is held during these steps.
2. Compare content hashes. If they are equal, return `unchanged` without writing.
3. Run one `UPDATE` guarded by `passMode`, `passVersion` and `updatedAt` (optimistic concurrency).
   A lost race gives `WALLET_DYNAMIC_CONCURRENT_MODIFICATION` and leaves the row untouched.
4. `passVersion` increments. `lastModifiedAt` is stamped at write time and always moves forward.

Enrollment is explicit, per credential, and refuses:

- a revoked credential;
- a missing Apple artifact;
- a static artifact not on the current static template. Such an artifact could still be
  rewritten by the static refresh path, so it is excluded.

The static path treats a DYNAMIC artifact as never stale. It serves the stored bytes and never
rebuilds them.

## 3. Database (additive)

Migration `20261013120000_wallet_dynamic_pass_foundation`:

- **`wallet_pass_artifacts`** gains nine columns: `pass_mode`, `dynamic_template_version`,
  `authentication_token_hash`, `content_hash`, `pass_version`, `last_modified_at`,
  `next_transition_at`, `snapshot_schema_version` and `dynamic_enabled_at`. Each is nullable or
  has a constant default, and every existing row becomes `STATIC` with `pass_version = 0`.
- **CHECK `wallet_pass_artifacts_dynamic_fields_consistency`.** A DYNAMIC row must be an Apple row
  with bytes, a token hash, a template version, a content hash, `lastModifiedAt` and
  `dynamicEnabledAt`.
- **New table `wallet_pass_registrations`.** It has a unique key on
  `(deviceLibraryIdentifier, passTypeIdentifier, serialNumber)`. Its foreign keys are
  `studio` (RESTRICT) and `artifact` (CASCADE).

Lock impact is milliseconds. Rollback SQL is in the migration header and was executed in
simulation (section 8).

## 4. PassKit web service

`/api/v1/wallet/passkit/v1/...` follows Apple's "Adding a Web Service to Update Passes".
`webServiceURL` = `https://<api-host>/api/v1/wallet/passkit`.

| Route | Auth | Responses |
|---|---|---|
| `POST devices/{device}/registrations/{passType}/{serial}` | `ApplePass <token>` | 201 new, 200 already registered (push token refreshed), 400 bad body, 401 |
| `GET devices/{device}/registrations/{passType}?passesUpdatedSince=` | none (Apple design) | 200 `{serialNumbers, lastUpdated}`, 204 none |
| `DELETE devices/{device}/registrations/{passType}/{serial}` | `ApplePass <token>` | 200 (idempotent), 401 |
| `GET passes/{passType}/{serial}` | `ApplePass <token>` | 200 `application/vnd.apple.pkpass` + `Last-Modified`, 401 |
| `POST log` | none | 200 |

- **Default off.** Every route returns 404 unless `WALLET_PASSKIT_ROUTES_ENABLED=true`.
- **Uniform 401.** Every authentication failure returns the same 401: wrong pass type, malformed
  or unknown serial, STATIC pass, or a missing or wrong token. The route is not an oracle for
  which serials exist.
- **Tenant isolation.** A registration's `studioId` is copied from the pass's own credential; no
  request field selects a studio. One pass's token never authenticates another pass.
- **Bounded input.** Identifier patterns and lengths are enforced. Push tokens must be hex.
  Registrations are capped at 10 devices per pass, and the serials response at 100. Device logs
  keep 20 messages of up to 512 characters, strip control characters, redact long tokens, and
  are never persisted.
- **Bodies parsed by hand.** A field Apple adds in the future cannot break registration under the
  global strict ValidationPipe.
- **Cursor.** `lastUpdated` is never newer than the server clock minus 2 s. A pass whose write
  commits just after a poll is still delivered on the next poll.
- **Safe logs.** Logs carry studio and credential ids and a 12-hex hash of the device id. They
  never contain tokens, push tokens, barcodes or member names.
- **Throttling.** `PublicThrottlerGuard`, 120 requests/min.

The GET-pass route serves the stored artifact. It does not recompute or sign.

## 5. APNs

`ApnsClient` uses HTTP/2 with TLS client authentication, using the pass-signing certificate and
key from the existing P12.

- **Request.** `POST /3/device/<pushToken>`, `apns-topic: <passTypeIdentifier>`, body `{}`. This
  matches Apple's contract: the same certificate that signed the pass, an empty payload, and the
  production environment only.
- **Host.** Fixed to `api.push.apple.com` and not configurable by environment variable.
- **Robustness.** One session per batch, and a timeout per request.
- **Invalid tokens.** `410` and `BadDeviceToken` / `Unregistered` / `DeviceTokenNotForTopic` mark a
  token invalid, and its registration is deleted after the batch.
- **Gating.** `WalletPassPushService` is off unless `WALLET_APNS_ENABLED=true`.
- **Tests.** Tests use a local HTTP/2 server that demands a client certificate. A guard makes any
  connection to `*.apple.com` throw.

## 6. Flags

See [`ENV_VARS.md`](./ENV_VARS.md#smart-wallet-20-stage-1a-all-off-by-default).

| Flag | Default | Effect |
|---|---|---|
| `WALLET_DYNAMIC_PASSES_ENABLED` | `false` | Enrollment and refresh refuse when off |
| `WALLET_PASSKIT_ROUTES_ENABLED` | `false` | All PassKit routes return 404 when off |
| `WALLET_APNS_ENABLED` | `false` | Pushes refuse when off |
| `WALLET_PASSKIT_WEB_SERVICE_URL` | unset | Required when either of the first two flags is on; strictly validated at boot |

**Rollback with flags off.** A DYNAMIC artifact left behind is still served as stored and never
rebuilt as static. Its device registrations stop receiving updates. The member keeps a working
identity pass with the same QR.

## 7. Operator CLI

`node dist/cli/wallet-dynamic-pass.cli.js <command> --credential <walletCredentialId> [--confirm] [--push]`

| Command | Writes | Needs |
|---|---|---|
| `preview` | no | nothing |
| `status` | no | nothing |
| `enroll` | yes, one artifact | `WALLET_DYNAMIC_PASSES_ENABLED=true` + `--confirm` (otherwise prints a dry-run preview) |
| `refresh` | only if content changed | same; `--push` pushes only an `updated` pass, and only with `WALLET_APNS_ENABLED=true` |
| `push` | deletes invalid registrations | `WALLET_APNS_ENABLED=true` + `--confirm` |

Exit codes are 0 done, 2 refused by a safety rule (nothing written), and 1 failure. Output never
contains the token, the barcode or the member's name.

## 8. Verification (local, isolated database `gymos_wallet_test`)

- **Unit tests.** 124 suites / 1,549 tests pass. They include the snapshot matrix (25 cases,
  including the October 2026 regression and fixed-duration TRIALING / lapsed-cycle cases), the display wording, the token utilities, both template
  fingerprints, PKCS#7 signature verification of a dynamic pass with openssl against the test
  WWDR (plus a tamper check that must fail), the static compatibility check, the env validation,
  the APNs client against a local HTTP/2 server, and the static-path protections.
- **e2e tests.** New suites: `wallet-dynamic-pass.e2e-spec.ts` (17 tests) and
  `wallet-dynamic-pass-disabled.e2e-spec.ts` (4 tests). The full API e2e run passed with
  46 suites / 540 tests, including every existing wallet and check-in suite. Two earlier full runs
  each had one transient transport-level failure: a login 404 in `membership-usage` and a socket
  hang-up in `billing`. Each was in a different suite this work does not touch, and each suite
  passed when run alone and in the clean full run.
- **Migration simulation:**
  - a fresh install of 57 migrations;
  - an upgrade from the base commit's 56 migrations with representative existing wallet rows,
    after which existing rows were byte-identical, including `updated_at`;
  - a no-op re-deploy;
  - schema drift identical to base, i.e. no new drift;
  - the same final schema on the upgrade and fresh paths;
  - the documented rollback SQL, which restores exactly the base schema.
- **Static bundle, base vs this branch.** A temporary harness built static passes with the
  base commit's provider (`e365d2d`) and with this branch's refactored provider, from identical
  inputs and test PKI. It covered three cases: brand assets with a plan, brand assets without a
  plan, and placeholder icons. In every case `pass.json`, `manifest.json` and every image were
  byte-identical, with the same zip members in the same order. Only the PKCS#7 `signature`,
  which embeds a signing time, can differ. The harness was not committed.
- **CLI smoke.** The compiled CLI was run against a seeded synthetic member: usage, status,
  preview, dry-run enroll, refused enroll with the flag off, confirmed enroll, unchanged refresh,
  and refused push with APNs off.

## 9. Known limitations (deliberate in Stage 1A)

- Passes change only when the operator runs `refresh`. No scheduler acts on `nextTransitionAt`,
  and no event hooks exist in billing, sales or check-in.
- The GET-pass route serves stored bytes. On-demand recompute is a next-stage decision.
- No staff or admin UI. Enrollment is CLI only.
- Whether Wallet registers for updates after a static pass is **replaced** by a dynamic one
  with the same serial is not documented by Apple. That is the main question for the staging test.
- `sharingProhibited` is not set, so the pass can be shared, as with the static pass today.
- Google Wallet is unchanged. Its objects remain static and `state: ACTIVE`.
