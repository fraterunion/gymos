# ARES — campaign sender + multi-week class cancellation: rollout plan

Branch `feat/ares-campaign-sender-and-range-cancel` (draft PR). **No Prisma migration.** Merging redeploys
the Railway `api` (code only) and Vercel `gymos-admin`. Nothing here sends email or cancels classes
by itself.

## What changes

### A. Email campaigns (Communications)
- **Campaign-only sender.** `EMAIL_CAMPAIGN_SENDERS` (JSON keyed by studio slug) sets From and Reply-To for
  Communications campaigns only. For ARES: `ARES Training Club <fernando@arestrainingclub.com>`, with
  Reply-To `fernando@arestrainingclub.com`.
  - Password recovery and every other transactional email keep `EMAIL_FROM_ADDRESS`.
  - Studios that aren't listed keep today's behaviour.
- **Fail-closed checks.** These are refused, and the admin shows the reason:
  - an invalid entry;
  - unparseable JSON;
  - a From address outside the verified domain of `EMAIL_FROM_ADDRESS`.
- **Paused delivery** (`EMAIL_CAMPAIGN_WORKER=0`): confirm, retry and resume are refused (409).
  - A campaign can't be queued while delivery is paused.
  - The admin shows "Envíos pausados" and disables sending.
- **No surprise sends.** The worker delivers a queued campaign automatically only within
  `EMAIL_CAMPAIGN_STALE_AFTER_MINUTES` (default 360) of its last confirm, retry or resume.
  - Older queued campaigns show as "Detenida · requiere reanudar".
  - They send only after an explicit, audited "Reanudar envío".
- **Admin.** A new status banner shows active or paused delivery, the From and the Reply-To. Each
  campaign shows its state and pending count, with one explicit action: confirm, resume or retry
  failed.
- **Kept unchanged:** filters, include/exclude, preview fingerprint, confirmation, idempotency,
  history, the unsubscribe link, List-Unsubscribe headers and suppression.

### B. "Cancelar clases por rango de fechas" (Schedule → ••• menu)
- **Scope.** Studio-local date range, inclusive on both ends, up to 184 days and 2,000 classes.
  Optional filters by class type and by instructor.
- **Exact preview.** Lists every class grouped by week, with its booking and waitlist counts. It
  also lists the protected classes that will be kept: already started or completed, or a future
  class with an early check-in.
- **Execute.** Requires explicit confirmation and the preview fingerprint. An optional reason is
  stored on each class.
  - The whole operation runs in one transaction.
  - The update is conditional: the class must still be scheduled, in the future and without
    attendance. If not, everything rolls back with a 409; there are no partial results.
  - It uses the existing cascade: bookings become `CANCELLED/STUDIO` and waitlist entries become
    `EXPIRED`.
  - It's idempotent, serialized with an advisory lock, and writes an audit row
    (`SCHEDULE_RANGE_CANCEL`).
- **Soft cancel only.** Classes are never deleted. Cancelled rows keep their unique slot, so the
  daily generator cannot recreate them (proved in e2e). Series stay active for other dates.

## Production activation checklist

Each step is separately approved.

0. **Preconditions (read-only).**
   - CI is green on the PR head and `/health` returns 200.
   - Production still has `EMAIL_CAMPAIGN_WORKER=0`.
   - Production has 0 email campaigns.
   - The Smart Wallet configuration digest is unchanged.
1. **Merge the PR** (approval). There is no migration. Expect a Railway `api` redeploy (it waits
   for CI) and a Vercel `gymos-admin` deploy.
   - In the deploy window the new admin may call routes the old API doesn't have yet (404), with
     no writes: Communications `status`, and range-cancel `preview` and `execute`.
2. **Post-deploy smoke (read-only).**
   - `/health` returns 200.
   - Communications → banner shows "Envíos pausados".
   - Schedule → ••• → *Cancelar clases por rango de fechas* → preview a future week, then close
     **without** confirming.
3. **Set the campaign sender** (approval; this redeploys the API):
   ```bash
   railway variable set 'EMAIL_CAMPAIGN_SENDERS={"ares-fitness":{"fromName":"ARES Training Club","fromAddress":"fernando@arestrainingclub.com","replyTo":"fernando@arestrainingclub.com"}}' -s api -e production
   ```
   - Verify the banner shows `De: ARES Training Club <fernando@arestrainingclub.com> · Responder a: fernando@arestrainingclub.com`.
   - Delivery is still paused at this point.
4. **Internal acceptance send** (approval). Run exactly one campaign to **one** internal recipient,
   chosen with "Incluir" and no filters.
   - Keep the paused window as short as possible: enable delivery (step 5), immediately confirm the
     one-recipient campaign, verify, and only then announce availability to Fernando.
   - In the received message check:
     - From = `ARES Training Club <fernando@arestrainingclub.com>`;
     - Reply-To = Fernando;
     - DKIM and DMARC = pass (`d=arestrainingclub.com`);
     - `List-Unsubscribe` present;
     - a reply reaches Fernando's mailbox.
5. **Enable delivery** (approval; this redeploys the API):
   `railway variable set EMAIL_CAMPAIGN_WORKER=1 -s api -e production`, or delete the variable.
   Before enabling, re-confirm 0 queued campaigns (`SENDING`), so nothing old can send.
6. **Hand over to Fernando.**
   - Send small segments first.
   - Monitor each campaign's history: sent, failed, omitted.
   - Pause any time with `EMAIL_CAMPAIGN_WORKER=0`; queued campaigns then show "En pausa" and never
     resume on their own after the stale window.

### Rollback
- **Email.** `EMAIL_CAMPAIGN_WORKER=0` stops delivery immediately; nothing new can be queued.
  Removing `EMAIL_CAMPAIGN_SENDERS` restores the previous sender.
- **Code.** Redeploy the previous Railway `api` deployment and use Vercel Instant Rollback for the
  admin. No schema change is involved.
- **A range cancellation is a data operation, not a deploy.** Cancelled classes stay as rows, and
  the audit row lists every class and the counts.
  - An operator can recreate a class individually; creating it in the same slot reactivates an
    empty cancelled row.
  - Bookings cancelled by the cascade are not restored automatically.
