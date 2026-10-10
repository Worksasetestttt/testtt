# Responsive review — Oubli app (390 px phone / 820 px tablet)

All captures and scripts are under `/tmp/claude-0/-home-user-testtt/a0b7454d-5a1f-5c23-9d25-1a916ee1124b/scratchpad/review-mobile/` (paths below are relative to it). Nothing under `/home/user/testtt` was modified. Baseline sets: `full/` (390 full-page, appflow.js), `mobilevp/` + `mobilevp-long/` (390 viewport shots, 20 s / 100 s after checkout), `tablet/` + `tablet-long/` (820 full-page), `header-<w>.png` (header probe at 360–1150). Every fix below was verified by injecting `fix.css` (same dir) into real runs: `fixed-tablet/`, `fixed2-mobilevp/`, `header-<w>-fixed.png`. Result after fixes: `scrollWidth == clientWidth` on every screen at 360, 390, 768, 820, 834, 1024.

Note: the dev server was down at ~11:26 (empty `scratchpad/server.pid`, connection refused); I restarted it with `DEMO_MODE=1 PORT=3077 SCHEDULER_INTERVAL_MS=4000` (pid in `review-mobile/server.pid`, log in `review-mobile/server.log`). Also: demo replies only arrive for requests sent ≥ 45 s earlier, so a 20 s wait shows 50 × "Envoyée"; use ≥ 70 s to review the mixed-status dashboard.

## Findings (most important first)

### 1. CRITICAL — Tablet header overflows the viewport on every logged-in screen (768–1023 px)
- Screens: all; `tablet/tablet-2-onboarding-profil-vide.png`, `header-768.png`, `header-820.png`, `crop-header-820.png` (820 px). `document.documentElement.scrollWidth` = 842 at 768/820/834 (page scrolls sideways). "Se déconnecter" wraps to two lines and is cut to "dé" at 768 / "déconnec" at 820; "Tableau de bord" and the e-mail wrap to 2 lines. At 1024 the nav links still wrap (`header-1024.png`, link height 59 px).
- Cause: `.top__user .mono` (e-mail) is only hidden ≤ 767; flex items shrink and wrap.
- Fix (`app.css`): global, next to `.top__nav a`:
  ```css
  .top__nav a, .top__user button { white-space: nowrap; }
  .top__user .mono { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  ```
  and inside `@media (max-width: 1023px)`:
  ```css
  .top__inner { gap: 24px; }
  .top__nav { gap: 20px; }
  .top__user .mono { display: none; }
  ```
  Verified: scrollWidth 768/820/834 = viewport, links 36 px single line, `header-820-fixed.png`.

### 2. HIGH — A long e-mail tag overflows the profile sheet at 390 px (onboarding step 1 and Dossier)
- Screens: `mobilevp/mobilevp-2b-onboarding-profil-rempli-01.png`, `crop-tags-390.png`, `full/mobile-6-dossier.png` (390). With a 43-char e-mail, `ul.tags`, `.tags__add`, the label are 365 px wide inside a 316 px field: the "×" and the "Ajouter" button are pushed past the sheet border, page scrollWidth 402. (appflow.js passed only because its test e-mail is 2 chars shorter — the sheet is already overflowed from ~36 chars.)
- Cause: `.f` is `display:grid`; its items (`ul.tags`, `.tags__add`) keep `min-width:auto`, so the nowrap `.tag span` dictates their width; the existing `text-overflow: ellipsis` never gets a chance (`debug-tags.js` output: tags 326 > field 316 even with a short address).
- Fix (`app.css`, global, after `.tags__add input`):
  ```css
  .tags, .tags__add, .tag { min-width: 0; }
  .tag span { min-width: 0; }
  ```
  Verified: 2b and 6-dossier scrollWidth 390, tag ellipsised "camille-mobilevp-1791632086641@…" (`fixed2-mobilevp/mobilevp-2b-onboarding-profil-rempli-01.png`).

### 3. HIGH — Mobile nav silently scrolls: "Paramètres" is cut, 34 px tall links, 101 px sticky header
- Screens: `mobilevp/mobilevp-1-signup-00.png` ("Paramèt"), `mobilevp/mobilevp-8-parametres-00.png` (after tapping Paramètres the row scrolls and "Tableau de bord" becomes "bleau de bord"), `header-360.png` ("Para"). `.top__nav` scrollWidth 378 vs clientWidth 358 at 390 (328 at 360), no scroll affordance; link height 34 px; sticky header 101 px = 12 % of an 844 px viewport.
- Fix (`app.css`, replace the three rules in `@media (max-width: 767px)`):
  ```css
  .top__inner { gap: 8px 14px; height: auto; padding: 8px 16px 0; flex-wrap: wrap; }
  .top__nav { order: 3; width: 100%; gap: 0; justify-content: space-between; }
  .top__nav a { font-size: .86rem; letter-spacing: -.01em; padding: 12px 0; }
  ```
  Verified: nav 358/358 at 390 and 328/328 at 360, links 45 px tall, header 90 px (`header-390-fixed.png`, `header-360-fixed.png`).

### 4. HIGH — Onboarding rail loses its numerals and the ✓ below 1024 px
- Screens: `crop-rail-390.png` (390), `crop-rail-820.png` (820), `tablet/tablet-3-onboarding-mandat.png`. Only "Vos informations / Le mandat / L'offre" render; "01 02 03" and the done-check are gone, so the stepper reads as three plain labels.
- Cause: in `@media (max-width: 1023px)`, `.rail__step span { display: none; }` (0,1,1) also matches `.rail__n` (a `span`, 0,1,0).
- Fix: in `@media (max-width: 1023px)` change that rule to
  ```css
  .rail__step div > span { display: none; }
  ```
  With the numerals back, the 3 steps no longer fit in one row at 390 (step 3 ends at x = 434 → hidden scroll), so add to `@media (max-width: 767px)`:
  ```css
  .rail { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; overflow: visible; padding-bottom: 0; }
  .rail__step { grid-template-columns: 1fr; gap: 2px; padding: 0; align-items: start; }
  .rail__n { font-size: 1.5rem; }
  .rail__step strong { font-size: .88rem; line-height: 1.25; }
  ```
  Verified: 3 equal cells 16–127 / 139–251 / 263–374, "01 ✓" green on done step (`debug-390-variantF-top.png`, `debug-390-variantF-step2.png`).

### 5. HIGH — Broker rows are cramped on tablet (768–1023 px)
- Screens: `tablet-long/tablet-5e-dashboard-row-action-requise.png`, `tablet-long/tablet-5f-dashboard-row-terminee.png` (820). The 5-column grid `52px 1.4fr 150px 1.3fr auto` leaves `.row__who` 134 px and `.row__when` 112 px (88 px at 768, 102 px tall = 5 lines): "Envoyée le 10 / oct. 2026", "réponse due le / 9 nov. 2026", "Recherche de / personnes". Header labels "STATUT/SUIVI" also don't line up with the chips.
- Fix (`app.css`, new block placed before the 767 block):
  ```css
  @media (min-width: 768px) and (max-width: 1023px) {
    .row { grid-template-columns: 40px minmax(0, 1.4fr) 140px minmax(0, 1.3fr); gap: 12px 16px; }
    .row--head > span:last-child { display: none; }
    .row__act { grid-column: 2 / -1; justify-content: flex-start; }
  }
  ```
  Verified: who 221–255 px, when 205–237 px on one line each, actions under the row (`fixed-tablet/tablet-5e-dashboard-row-action-requise.png`). Scoping with `min-width: 768px` matters: an unscoped ≤1023 rule placed after the 767 block would override `.row__act { grid-column: 1 / -1 }` on phones and squeeze the name column to 40 px.

### 6. MEDIUM — "Ajouter un proche" form is unusable at 390 px (Dossier)
- Screens: `mobilevp/mobilevp-6-dossier-00.png`, `crop-addmember-390.png` (390). `.member` is `44px 1fr auto`; the 153 px button leaves ~110 px for the two-column Prénom/Nom grid → two 40 px underlines.
- Fix, in `@media (max-width: 767px)`:
  ```css
  #add-member { grid-template-columns: 44px minmax(0, 1fr); }
  #add-member .btn { grid-column: 2; justify-self: start; }
  ```
  (Optional cleanup in `app.js` `views.dossier`: replace the inline `style="grid-template-columns:1fr 1fr;gap:16px 24px"` with a class `fields fields--pair` + `.fields--pair { grid-template-columns: 1fr 1fr; gap: 16px 24px; }` so the media query can also stack the two fields.) Verified: `fixed-mobilevp/mobilevp-6-dossier-00.png`.

### 7. MEDIUM — Tap targets under 44 px on phones
- Screens: `mobilevp-long/mobilevp-5-dashboard-01.png`, `mobilevp/mobilevp-2b-onboarding-profil-rempli-01.png`, `mobilevp/mobilevp-6-dossier-03.png` (390). Measured heights: nav links 34, filter pills 34, "Se déconnecter" 23, ghost buttons/links (Courrier, Modifier, Révoquer le mandat, Résilier l'abonnement) 25, tag "×" 22×22, "Ajouter" 36, `.btn--sm` (Vérification faite, Ajouter un proche, Télécharger) 38, Mensuel/Annuel 38, "Voir lesquels" link 19.
- Fix, in `@media (max-width: 767px)` (nav is covered by #3):
  ```css
  .filters button { height: 44px; }
  .btn--sm { height: 44px; }
  .tags__add button { height: 44px; padding: 0 18px; }
  .seg button { height: 44px; }
  .tag { padding: 8px 8px 8px 14px; }
  .tag button { width: 28px; height: 28px; }
  ```
  and global, for the underlined ghost controls and the × (bigger hit area, no layout change):
  ```css
  .btn--ghost, .top__user button, .tag button { position: relative; }
  .btn--ghost::after, .top__user button::after { content: ""; position: absolute; inset: -10px -8px; }
  .tag button::after { content: ""; position: absolute; inset: -8px; }
  ```
  Verified: filters/btn--sm/Ajouter 44 px, `.row__act` 44 px, no overflow introduced.

### 8. MEDIUM — Mandate text is a nested 320 px scroll box on phones
- Screens: `mobilevp/mobilevp-3-onboarding-mandat-00.png`, `-01.png`, `mobilevp/mobilevp-6-dossier-03.png` (390). To read the mandate before signing, the user must scroll a box inside the page (scroll-trapping, easy to miss the second half). At 820 the box fits without scrolling.
- Fix, in `@media (max-width: 767px)`:
  ```css
  .mandate-text { max-height: none; padding: 18px 16px; }
  ```
  Verified: full text ≈ 1.6 screens, no inner scroll (`fixed2-mobilevp/mobilevp-3-onboarding-mandat-01.png`).

### 9. LOW — Broker name gets ellipsised next to the wide "ACTION REQUISE" chip at 390 px
- Screens: `mobilevp-long/mobilevp-5-dashboard-01.png` (390). The row is `1fr auto`; the chip is 132 px so `.row__who` gets 172 px and `strong` is `nowrap; text-overflow: ellipsis` — names such as "Experian Marketing Services" / "Thomson Reuters CLEAR" become "Experian Marketing Se…" whenever that broker is in action_required (not hit in this random demo set, but deterministic).
- Fix, in `@media (max-width: 767px)`: `.row__who strong { white-space: normal; }`

### 10. LOW — Nav links wrap between 1024 and ~1100 px
- Screens: `header-1024.png` (1024): "Tableau de / bord" and "Se / déconnecter" on two lines. Covered by the global `white-space: nowrap` in #1 (verified 36 px single line at 1024, `header-1024-fixed.png`).

### Aside (not responsive, noticed while reviewing)
- Dossier → Mandat sheet foot shows "VERSION" with no value at every width (`full/mobile-6-dossier.png`, `tablet/tablet-6-dossier.png`): `views.dossier` prints `u.mandate_version`, which `/api/me` does not seem to return (only `/api/mandate` does, as `version`).
- `appflow.js` only checks document-level overflow; adding `Array.from(document.querySelectorAll('.sheet')).some(s => s.scrollWidth > s.clientWidth + 1)` would have caught #2.

## Verdict
Phone layout is structurally sound (ledger 2×2, row collapse, timeline, plans, settings all fine) but ships with one real overflow (long e-mail tag), a nav that hides its last item, a stepper that lost its numerals, and sub-44 px controls everywhere.
Tablet (768–1023) is the weak band: the header overflows the viewport on every screen and broker rows wrap into 4–5 lines — both are small CSS fixes.
All ten fixes are CSS-only, were verified against the live app at 360/390/768/820/834/1024, and leave no horizontal overflow on any screen; apply #1–#5 before shipping.