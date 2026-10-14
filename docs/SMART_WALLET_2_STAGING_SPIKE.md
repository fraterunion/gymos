# Smart Wallet 2.0 — real-iPhone staging spike (specification, NOT executed)

This is the minimum staging setup to prove, on a real iPhone, what Stage 1A cannot prove locally.
**Nothing here has been run.** Each step that creates, changes or sends something needs explicit
approval before it happens. Production (the `api` service on `main`, its Neon database, the ARES
OTA channel and the billing cron) is not touched at any point.

## What the spike must prove

| # | Check | Evidence that passes it |
|---|---|---|
| 1 | A fresh dynamic pass installs | Wallet shows the pass with header `ESTADO` and the expected state |
| 2 | Device registration reaches the service | `wallet.passkit.registered` (outcome `created`) in staging logs; CLI `status` shows `registrations: 1` |
| 3 | A content update is pushed | CLI `refresh --confirm --push` prints `outcome: updated` and an APNs summary with `delivered: 1` |
| 4 | Wallet downloads the changed pass | Staging logs show the serials `GET` then `wallet.passkit.pass_served` with the new `passVersion`; the phone shows the new state |
| 5 | A static test pass installs | Wallet shows the pass with `PLAN …` header (or empty) and no state header |
| 6 | It is replaced by a dynamic pass of the same identity | Re-download offers to replace the existing pass (same serial); the card now shows `ESTADO` |
| 7 | Whether automatic update registration occurs after the replacement | **Observed result is the finding.** Either `wallet.passkit.registered` arrives for that serial, or it does not (and Wallet's device log says why) |
| 8 | The QR is unchanged | CLI `status` `qrFingerprint` identical before and after (5→6), and the replaced pass's QR scans at the staging desk as the same credential |

Check 7 is the open question: Apple documents that a pass with the same pass type and serial
replaces the installed one, but not whether replacing a pass that had no `webServiceURL` makes
Wallet register. The answer decides how existing members are migrated in Stage 2: a silent
replacement, a prompted re-add, or both.

## Decisions the operator must make first

1. **Where staging runs.**
   - **Recommended: a separate Railway environment** (e.g. `staging-wallet`) in the existing
     project. It contains only an API service deployed from `feat/smart-wallet-foundation`, has
     no cron service and no Vercel or Expo changes, and uses the Railway-provided
     `*.up.railway.app` domain. That domain has public TLS, so no DNS work is needed.
   - Alternative: the API runs locally behind an HTTPS tunnel. This requires no Railway changes
     and no branch push, but the tunnel hostname is signed into the test passes, so they stop
     updating when the tunnel ends.
2. **Which Pass Type ID signs the staging passes.**
   - **Recommended: a dedicated staging Pass Type ID** (e.g. `pass.<team-domain>.member.staging`)
     with its own certificate. This keeps the production signing secret out of another
     environment, and a staging mistake can never produce a pass Wallet treats as a production
     pass. It is an Apple Developer change that needs approval and takes about 15 minutes.
   - Alternative: reuse the production Pass Type ID certificate. This means fewer steps but copies
     a production secret into staging. Staging serials never collide with production ones, since
     they come from a different database.
3. **Which database.** A **new, empty** Neon database or branch created without production data,
   migrated with `prisma migrate deploy`. Never a copy of production: it would carry real members
   and real wallet credentials.
4. **The production `webServiceURL` domain (decide now, use later).** It is signed into every
   production dynamic pass and must outlive any infrastructure change. The recommendation is the
   existing production API domain, `https://<prod-api-domain>/api/v1/wallet/passkit`. It is not
   used in this spike.

## Certificate and Apple dependencies

- **Team ID**, for `WALLET_APPLE_TEAM_ID`.
- **Pass Type ID** registered under that team, for `WALLET_APPLE_PASS_TYPE_ID`.
- **Pass Type ID certificate + private key** as a `.p12` (base64) and its password, for
  `WALLET_APPLE_SIGNING_CERT_P12_BASE64` and `WALLET_APPLE_SIGNING_CERT_PASSWORD`. The same
  identity authenticates the APNs pushes; Apple requires this.
- **Apple WWDR intermediate (G4)** as PEM (base64), for `WALLET_APPLE_WWDR_CERT_PEM_BASE64`.
- **Expiry check.** Verify that the Pass Type ID certificate has not expired and will not expire
  during the spike. It lasts one year. When it expires, both signing and pushes stop.
- **APNs environment.** Pass updates are delivered only by production APNs (`api.push.apple.com`,
  fixed in code). This spike is therefore the first contact with live APNs and needs its own
  explicit approval.
- **No App Store, TestFlight or OTA change.** The pass reaches the phone through Safari.

## Staging configuration (API service only)

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` (exercises the strict validation: https required) |
| `DATABASE_URL` | the new empty staging database |
| `JWT_SECRET`, `JWT_QR_SECRET` | new random values, never the production ones |
| `CORS_ORIGIN` | the staging domain (no browser client is used) |
| `STRIPE_*` (6 keys) | **test-mode** keys only (production validation requires them; nothing is charged) |
| `EXPO_BUILD_WEBHOOK_SECRET` | any random 16+ chars (required by production validation; unused) |
| `WALLET_APPLE_*` (5 keys) | per decision 2 |
| `WALLET_PASSKIT_WEB_SERVICE_URL` | `https://<staging-domain>/api/v1/wallet/passkit` |
| `WALLET_DYNAMIC_PASSES_ENABLED` | `true` |
| `WALLET_PASSKIT_ROUTES_ENABLED` | `true` |
| `WALLET_APNS_ENABLED` | `false` until step 3, then `true` for the push steps only |
| `WALLET_GOOGLE_*`, `BILLING_*`, alert webhooks | **unset** |

Start command: the standard API start (`node dist/main.js`). The operator CLI runs inside the
service with `railway ssh` against the same environment:
`node dist/cli/wallet-dynamic-pass.cli.js …`.

## Seed data (staging only)

One studio (timezone `America/Mexico_City`), one OWNER test account, and two MEMBER test
accounts with known passwords supplied through the environment, never committed:

- **Member A.** An active cash Full Access membership whose period ends in about 30 days.
  Used for checks 1–4.
- **Member B.** No membership. Used for checks 5–8.

A small staging-only seed script that reads its passwords from environment variables still has
to be written. It is listed as preparation work below.

## Operator runbook

Before anything else: approval to push the branch, to create the staging environment, database
and (if chosen) Pass Type ID, and to contact live APNs.

**Preparation**

1. Push `feat/smart-wallet-foundation` (approval). Production is unaffected: Railway production
   only deploys `main`.
2. Create the staging database and the `staging-wallet` environment with the variables above.
   Deploy, and confirm `GET /health` returns OK.
3. Run `prisma migrate deploy` (part of the deploy), then the staging seed.
4. Test `curl -i https://<staging-domain>/api/v1/wallet/passkit/v1/devices/x/registrations/<passType>`.
   It must return `204` (routes on, nothing registered).

**Checks 1–4 (member A, fresh dynamic install)**

5. Log in as member A (`POST /api/v1/auth/login`), then `POST /api/v1/studios/<studio>/wallet/credential`.
   This issues the credential and the static artifact. Note the credential id: it is the pass serial.
6. Run `cli status --credential <id>` and record `qrFingerprint`. Run `cli enroll --credential <id>`
   as a dry run, then `--confirm`.
7. `POST /api/v1/studios/<studio>/wallet/apple/download-link` gives a 90-second URL. Open it in
   Safari on the iPhone (AirDrop the link or scan a QR of it), then tap **Add**. This is **check 1**.
8. Within about a minute, logs show `wallet.passkit.registered` and `cli status` shows
   `registrations: 1`. This is **check 2**.
9. Change member A's data in staging, for example expire the membership period. Set
   `WALLET_APNS_ENABLED=true` (approval for live APNs), then run
   `cli refresh --credential <id> --confirm --push`. This is **check 3**.
10. Watch the phone: the header changes (e.g. `VIGENTE` → `VENCIDA`). Logs show the serials `GET`,
    then `wallet.passkit.pass_served` with the new `passVersion`. This is **check 4**.

**Checks 5–8 (member B, static → dynamic replacement)**

11. With dynamic enrollment not yet run for B, log in as member B and repeat step 7 to install
    B's **static** pass. This is **check 5**. Record `cli status` `qrFingerprint` and confirm
    `passMode: STATIC`.
12. Run `cli enroll --credential <B> --confirm`. The server-side artifact is now dynamic with the
    same serial. The phone does not know yet.
13. Mint a new download link for B and open it on the same iPhone. Record exactly what Wallet
    shows (an "Update" / replace prompt, or a duplicate) and whether the card now shows `ESTADO`.
    This is **check 6**.
14. Watch for `wallet.passkit.registered` for B's serial for 10 minutes, then lock and unlock the
    phone and reopen the pass. Record the result either way. This is **check 7**. If no
    registration arrives, capture Wallet's device log (Console.app on a Mac, process `passd`) and
    any `wallet.passkit.device_log` lines.
15. Run `cli status` for B: `qrFingerprint` must equal step 11. Then scan B's pass at the staging
    desk (wallet check-in scan with the OWNER account). It must resolve to B. This is **check 8**.
16. If check 7 passed, repeat step 9 for B to prove the replaced pass also updates.

**Teardown**

17. Set every `WALLET_*_ENABLED` flag to `false` in staging and remove the test passes from the
    phone. Then delete the staging environment and database, or keep them for Stage 1B; that is
    the operator's decision. If a dedicated staging Pass Type ID was created, keep it for later
    stages or revoke its certificate.

## Preparation work still to be built (small)

- A staging-only seed script (studio, owner and two members, with passwords from the environment).
- Optional: a CLI `export` command that writes a pass to a file, as an alternative to the
  90-second download link.

## Risks specific to the spike

- First contact with live APNs. Pushes go only to the staging device tokens the test registered.
- If the staging webServiceURL changes after passes are installed, those passes can never update.
  Treat staging passes as disposable.
- Check 7 may legitimately fail. That is a finding, not a defect, and it changes the Stage 2
  migration plan rather than Stage 1A.
