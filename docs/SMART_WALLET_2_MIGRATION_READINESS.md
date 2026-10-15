# Smart Wallet 2.0 — migration readiness for existing passes

Status: **evaluation and proposal only. No real ARES member has been migrated, and none may be
without a separate, explicit approval for each step below. Migrating existing production passes
is NO-GO.**

The question: how can a member who already holds a STATIC Apple pass end up with a DYNAMIC pass
that is registered for updates, reliably and without harm?

## 1. Facts that constrain the answer

- **Enrolling on the server changes nothing on the phone.** The installed static pass has no
  `webServiceURL`, so it never contacts the server. The device only learns about the dynamic pass
  when the member adds the pass again, from the app or a download link.
- **The QR is unchanged throughout.** Same serial, same credential, same barcode. Check-in keeps
  working with the old card, the new card and the in-app QR at every step. A migration problem is
  therefore a stale-card problem, never an access problem.
- **A dynamic card that stops updating can be wrong in a way a static card cannot.** The static
  card shows no state. A dynamic card shows one, such as `VIGENTE`, plus a validity date. If its
  registration is lost, it can keep saying `VIGENTE` after the membership ends. The date on the
  card bounds the harm, and check-in never reads the card. Even so, this new failure mode is the
  reason not to migrate blindly.
- **The evidence so far** comes from one iPhone and one replacement. See
  [`SMART_WALLET_2_STAGE_3.md`](./SMART_WALLET_2_STAGE_3.md) §0.
  - A **fresh install** registered and updated end to end.
  - An **in-place replacement** was visually correct but **lost its registration**, through two
    Wallet-sent unregistrations about a minute after registering.
  - About 9 hours later the registration **came back when the pass was opened**, before any
    toggle.

## 2. Options evaluated

| Option | What the member does | Evidence (n) | Assessment |
|---|---|---|---|
| **A. In-place replacement** | Taps "Add to Apple Wallet" again; the new pass replaces the old card | Visual success; registration lost (1 of 1) | **Unstable.** It does not guarantee a working update channel, and the loss is silent |
| **B. Open-pass recovery after A** | After re-adding, opens the pass in Wallet | Registration returned on open (1 of 1), without a toggle | **Leading hypothesis** for a one-line instruction. Unproven: n=1, and the trigger and delay are unknown |
| **C. Guided remove-and-re-add** | Deletes the old pass, then adds it again from the app | The fresh-install path worked (1 of 1, pass A) | **Most likely to register,** since it avoids the replacement path. Costs the member two steps; the in-app QR covers the gap |
| **D. Toggle Automatic Updates** | Back of pass → Automatic Updates off, then on | Produced an unregister/register pair after recovery had already happened | **Not shown to be necessary.** Fallback only |
| **E. No active migration** | Nothing; new installs (new phones, new members) get dynamic passes once enrolled | Fresh-install path (1 of 1) | **Lowest risk,** slowest coverage. Compatible with every other option |

**How much n=1 tells us.** With zero failures in *n* independent trials, the 95 % upper bound on
the failure rate is roughly 3/*n* (the "rule of three").
- One success says almost nothing: the failure rate could still be 95 %.
- To claim ≤ 10 % failure with 95 % confidence needs about 30 consecutive successes; ≤ 5 % needs
  about 60.
- Trials on a single device are correlated, so they bound that device and iOS version, not the
  member population.

The current evidence therefore supports a hypothesis to test (B or C), not a rollout.

## 3. Confirming that a member's pass is registered

**What diagnostics show.** Use `wallet-diagnostics.cli.js pass --credential <id>`, which is
read-only and prints no identifiers:

| Signal | Meaning |
|---|---|
| `REGISTERED` within minutes of the re-add, and `activeDeviceCount ≥ 1` after 10 minutes | Wallet holds an update channel now |
| No `REGISTRATION_CHURN` finding | The Stage 2 unregister-after-register pattern did not occur |
| At the next real content change: `APNS_ACCEPTED`, then `PASS_RETRIEVED` of the current version (`currentVersionRetrieved: true`) | End-to-end delivery works |

**Not available yet: a proposal, not implemented.** A delivery probe without a content change.
A push with nothing new makes the device ask for changed serials and receive none, which would
prove receipt without touching the card. Measuring it needs a `SERIALS_LISTED` history event,
which Stage 3 does not record.

**Detecting missing registrations:**
- `NO_ACTIVE_UPDATE_REGISTRATION` and `REGISTRATION_CHURN` findings, per pass and counted per studio
  (`studio --studio <id>`).
- The report never says "removed": zero registrations does not prove the pass is gone.
- The only remedy is on the member's device: open the pass, or remove and re-add it.
  **Registrations are never created server-side.**

## 4. Proposed path (each gate needs explicit approval)

1. **More staging evidence (iPhone only, synthetic passes).**
   - Run repeated trials of C (remove-and-re-add) and of A+B (replace, then open). Record for each
     trial: registration within 10 minutes, churn, recovery on open and its delay, and delivery of
     the next change.
   - Aim for at least 30 trials of the preferred path before claiming anything about a rate, and
     report the device and iOS version.
2. **Production prerequisites. Each one is a release action with its own approval.**
   - Merge and deploy the Stage 1A and Stage 3 code with every flag off. This applies two
     migrations to production.
   - Confirm the production Pass Type ID certificate is valid for more than 30 days.
   - Fix the production `webServiceURL` permanently.
   - Approve live APNs for production.
   - Decide how dead letters and certificate warnings reach a person (alert routing does not
     exist yet).
3. **Cohort 1: internal accounts only** (owner and staff who consent), allowlisted by credential
   ID.
   - Enroll them one at a time with the Stage 1A CLI, have them follow the chosen instructions,
     and confirm each one with the diagnostics.
   - Then enable the worker and pushes for that studio and observe at least 7 days of real
     changes.
4. **Cohort 2: a small group of volunteer members** (about 10), allowlisted, with the same
   confirmation.
   - **Stop criteria:** any member whose card shows a wrong state, or whose registration is
     missing 24 hours after guidance even though they followed the instructions.
5. **Expansion,** only if the cohort results meet thresholds agreed in advance. Option E applies
   to everyone else in the meantime.

## 5. Member instructions (draft copy, Spanish)

**Preferred, option C:**

> **Actualiza tu pase de ARES en Apple Wallet**
> 1. Abre Wallet, toca tu pase de ARES, luego **···** → **Eliminar pase**.
> 2. Abre la app de ARES y toca **Agregar a Apple Wallet**.
> 3. Abre el pase una vez en Wallet.
>
> Tu código QR no cambia: puedes seguir entrando con el pase o con el QR de la app.

**If the member re-added without removing (option A), add:**

> Abre tu pase en Wallet una vez para activar las actualizaciones automáticas.

**Fallback only, option D:** at the back of the pass, turn **Actualizaciones automáticas** off and
on again. This is not presented as required.

## 6. What must not happen

- No bulk enrollment, and no enrollment of anyone outside an approved allowlist.
- No server-side creation, recreation or "repair" of registrations.
- No pushes to passes outside the approved cohort.
- No claim of reliability from a handful of trials.
- No reading of "zero registrations" as "the member deleted the pass".
