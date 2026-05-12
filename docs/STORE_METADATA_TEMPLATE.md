# Store metadata template (white-label member app)

Fill **one copy per client**. Replace tokens like `{{STUDIO_DISPLAY_NAME}}` with the gym’s **unique** names and facts. This file is **not** submitted to stores as-is—it is an internal worksheet.

**Related:** [`CLIENT_LAUNCH_CHECKLIST.md`](./CLIENT_LAUNCH_CHECKLIST.md), [`WHITE_LABEL_BUILDS.md`](./WHITE_LABEL_BUILDS.md), [`MOBILE.md`](./MOBILE.md).

---

## Warnings (read first)

1. **Do not reuse identical metadata** (title, description, keywords) across every client. Stores and users expect **distinct** brands; duplicate copy can hurt discoverability and raise policy questions.
2. **Runtime branding ≠ store listing** — In-app colors/logos come from the **branding API** for `EXPO_PUBLIC_STUDIO_SLUG`. **App Store / Play** titles and descriptions are edited in **Apple/Google consoles** (and should still align with the brand voice).
3. **Native identity is locked per binary** — `APP_DISPLAY_NAME`, bundle id, package, and `APP_SCHEME` come from **`app.config.ts` + env** ([`WHITE_LABEL_BUILDS.md`](./WHITE_LABEL_BUILDS.md)). **Bundle id / package must not change** after a public release if you intend to stay on the same listing.
4. **Unique scheme per client** — `APP_SCHEME` must be unique; Stripe return URLs on the API must use **that** scheme.

---

## Token legend

| Token | Meaning |
|-------|---------|
| `{{STUDIO_DISPLAY_NAME}}` | Marketing name (often matches `APP_DISPLAY_NAME`). |
| `{{CITY_OR_AREA}}` | Location hook for copy (e.g. “Toluca”, “Downtown Austin”). |
| `{{PRIMARY_OFFER}}` | What they sell (e.g. “Reformer Pilates”, “Small-group strength”). |
| `{{PRIVACY_URL}}` | HTTPS privacy policy. |
| `{{TERMS_URL}}` | HTTPS terms of use. |
| `{{SUPPORT_EMAIL}}` | Monitored support address. |
| `{{SUPPORT_PHONE}}` | E.164 or local display format as used in-store. |
| `{{WEBSITE_URL}}` | Marketing site (optional). |

---

## App Store (iOS)

Character limits change over time—verify against [Apple App Store Connect](https://developer.apple.com/help/app-store-connect/) before submit.

### App information

| Field | Max / notes | Your copy |
|-------|-------------|-----------|
| **App name** | ~30 characters (policy-enforced) | `{{STUDIO_DISPLAY_NAME}}` |
| **Subtitle** | ~30 characters | Example: *`{{PRIMARY_OFFER}} in {{CITY_OR_AREA}}`* |
| **Promotional text** | Optional; can update without new binary | |
| **Description** | Long-form | Use **long description** template below |
| **Keywords** | Comma-separated, no spaces after commas | **Unique per client** — mix brand + service + city |
| **What’s new** | Per release | |

### Long description (template — fitness / studio)

```text
{{STUDIO_DISPLAY_NAME}} is the member app for our studio in {{CITY_OR_AREA}}.

BOOK CLASSES
Browse the schedule, reserve your spot, and manage bookings in a few taps.

MEMBERSHIPS
View plans, subscribe securely, and manage billing when your studio enables it.

STAY ON TRACK
See your upcoming sessions and check in when your studio supports QR check-in.

Support: {{SUPPORT_EMAIL}}
Website: {{WEBSITE_URL}}
```

### Keywords (example pattern — replace tokens; do not copy verbatim to multiple clients)

```text
{{STUDIO_DISPLAY_NAME}},{{PRIMARY_OFFER}},gym,fitness,classes,{{CITY_OR_AREA}}
```

### Privacy & support (App Store)

| Item | Value |
|------|-------|
| Privacy policy URL | `{{PRIVACY_URL}}` |
| Support URL | `{{WEBSITE_URL}}` or dedicated help page |
| Marketing URL | Optional |

---

## Google Play (Android)

Verify current limits in Play Console.

| Field | Limit (typical) | Your copy |
|-------|-----------------|-----------|
| **App name** | 30 characters | `{{STUDIO_DISPLAY_NAME}}` |
| **Short description** | 80 characters | One line value prop |
| **Full description** | 4000 characters | Expand long description template with local differentiators |

### Short description (template)

```text
Book {{PRIMARY_OFFER}} classes at {{STUDIO_DISPLAY_NAME}} in {{CITY_OR_AREA}}.
```

### Full description (template)

Reuse and extend the **App Store long description** block above; add **data safety**-relevant facts (e.g. account email used for login) consistent with your Play **Data safety** form.

### Graphics

| Asset | Notes |
|-------|--------|
| Phone screenshots | Required sizes per Play policy |
| Feature graphic | If required for your listing type |
| Icon | Must match branding; binary icon comes from `APP_ICON_PATH` |

---

## Support (both platforms)

| Item | Template |
|------|----------|
| Primary support | `{{SUPPORT_EMAIL}}` |
| Phone (if shown) | `{{SUPPORT_PHONE}}` |
| Response SLA | Define internally (e.g. “business hours 24h”) |

---

## Legal (both platforms)

| Item | Template |
|------|----------|
| Privacy policy | `{{PRIVACY_URL}}` — must match in-app links if shown |
| Terms of use | `{{TERMS_URL}}` |
| Refund / subscription disclosures | Follow Apple/Google subscription rules; align with your **studio** policy and Stripe setup |

---

## Onboarding copy (in-app / first-run — optional)

Use if you add a first-run screen; keep short and **non-medical** unless compliant.

| Screen | Suggested placeholder |
|--------|----------------------|
| Welcome title | “Welcome to {{STUDIO_DISPLAY_NAME}}” |
| Body | “Sign in with the email your studio has on file. Book classes from the Schedule tab and manage membership from Membership.” |
| CTA | “Continue” |

---

## Appendix A — Example: ARES Fitness (illustrative only)

**Do not** ship this verbatim if it does not match the real business.

- **Title:** ARES Fitness  
- **Subtitle:** Strength & conditioning in [Your city]  
- **Short description (Play):** Book small-group strength sessions and open gym at ARES Fitness.  
- **Keywords (App Store):** ares fitness,strength training,gym,classes,[neighborhood]  
- **Long description:** Expand templates with real schedule types, pricing disclaimers (“membership required where applicable”), and real support email.

---

## Appendix B — Example: Pilates Toluca (illustrative only)

- **Title:** Pilates Toluca  
- **Subtitle:** Reformer Pilates in Toluca  
- **Short description (Play):** Reserve reformer classes and manage your membership at Pilates Toluca.  
- **Keywords:** pilates,reformer,studio,toluca,fitness,classes  
- **Long description:** Emphasize class types (reformer, levels), first-time client flow, and local contact.

---

## Revision log (internal)

| Version | Date | Author | Notes |
|---------|------|--------|-------|
| 1.0 | | | Initial Phase 5C template |
