# Oubli app — desktop design review (1280 px)

**Context / caveat.** `/home/user/testtt/app/app.css` and `app.js` were rewritten at 11:09:40, after the first flow run. All findings below were verified against the **current** files. Screenshots in `/tmp/claude-0/-home-user-testtt/a0b7454d-5a1f-5c23-9d25-1a916ee1124b/scratchpad/review-desktop/`: `v-*.png` are 1280×860 viewport shots of the current code (dashboard taken after ~3 min so demo replies had arrived: 41 done / 9 action required); `run2/desktop-*.png` is the full flow on the current code; the root `desktop-*.png` set is the pre-11:09 version (ignore for dashboard rows). Note: demo replies only start ≥45 s after send + a 20 s tick, so a 20 s dashboard wait shows an all-"Envoyée" board; wait ≥90 s. Line numbers refer to the current files. No console errors, no horizontal overflow.

---

## 1. MAJOR — Identity fields stretch to the tallest sibling (the "name form not adapted" complaint)
**Screens:** onboarding `v-2-onboarding-top.png`, settings `v-8-settings.png`, dossier `run2/desktop-6-dossier.png`.
`.f` is `display:grid` with default `align-content: normal` (= stretch) and `.fields` stretches items, so in any row where one field has a hint (Date de naissance, Nouveau mot de passe) the sibling inputs grow to fill: measured `#f-first_name` h = 70 px vs `#f-birth_date` h = 47 px; Prénom's underline sits 108 px below its label, Nom/Prénom/Pays underlines don't line up with the date's, and on Settings "Mot de passe actuel" bottoms out 26 px lower than "Nouveau mot de passe". Reads as broken.
**Fix (app.css L85–86):**
```css
.fields { display: grid; gap: 26px 36px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); align-items: start; }
.f { display: grid; gap: 6px; min-width: 0; position: relative; align-content: start; }
```

## 2. MAJOR — Onboarding rail numerals render at 13.6 px instead of 44 px
**Screen:** `v-2-onboarding-top.png` (left rail).
`.rail__step span { display:block; font-size:.85rem; margin-top:2px }` (L152, specificity 0,1,1) overrides `.rail__n { font-size: 2.75rem }` (L150, 0,1,0). The 56 px column, the connector `::before` (left 27 px / top 44 px) and the ✓ were designed for a 44 px Fraunces numeral; instead "01/02/03" are tiny grey labels floating top-left and the rail line starts in a void. This is the landing's `.step__num` motif, so it's the one piece of the onboarding that should be unmistakably on-brand.
**Fix (app.css L152):** change the selector
```css
.rail__step > div > span { display: block; font-size: .85rem; line-height: 1.45; margin-top: 2px; }
```
(or, if you prefer not to touch it, append `.rail__step .rail__n { font-size: 2.75rem; margin-top: 0; }` after L152). Verified computed `.rail__n` font-size is currently `13.6px`.

## 3. MAJOR — Broker table: header columns don't match the rows; rows are 145 px / 92 px tall
**Screens:** `v-5b-dash-rows.png`, `v-5d-dash-filter-action.png`, `v-5e-dash-filter-done.png`.
`.row` (L219) ends with `auto`; in `.row--head` the 5th span is empty → 0 px, in data rows it holds "Vérification faite + Courrier" (~210 px). Result: header "STATUT" at x 431 while chips sit at x 317, "SUIVI" at x 583 while dates start at x 467. The squeezed fr columns (who ≈ 132 px, when ≈ 110 px) truncate "TruePeopleSear…", wrap "Recherche de personnes" to 2 mono lines and wrap both date lines → 4-line cells; measured row heights 145 px (action required) / 92 px (done). Fifty of these make the page 5 200 px tall. The landing's mock rows are 48 px.
**Fix, three parts:**
(a) app.css L219 — fixed widths so head and body share a template:
```css
.row { display: grid; grid-template-columns: 40px minmax(0, 1fr) 140px 184px 76px; gap: 16px; align-items: center; padding: 14px 28px; border-top: 1px solid var(--border); transition: background .15s; }
.row__who small { display: block; color: var(--muted); font-size: .8rem; font-family: var(--font-mono); letter-spacing: .02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row__note { grid-column: 2 / -1; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; color: var(--muted); font-size: .85rem; margin-top: -4px; }
```
and L212: `.dash-grid { grid-template-columns: minmax(0, 1fr) 320px; … }`.
(b) app.js `rowsHtml` (L135–136) — keep the actions column to "Courrier" only and put the resolve button on the note line:
```js
var act = r.sent_at ? '<button class="btn btn--ghost" type="button" data-mails="' + esc(r.id) + '">Courrier</button>' : '';
var note = (r.note && r.status !== 'done' ? esc(r.note) + ' ' : '') + (r.status === 'action_required' ? '<button class="btn btn--sm" type="button" data-resolve="' + esc(r.id) + '">Vérification faite</button>' : '');
return '<div class="row" data-row="' + esc(r.id) + '">' + dots(r.sensitivity) + '<div class="row__who"><strong>' + esc(r.broker) + '</strong><small>' + esc(r.category) + '</small></div><div>' + chip(r.status) + '</div><div class="row__when">' + when + '</div><div class="row__act">' + act + '</div>' + (note ? '<p class="row__note">' + note + '</p>' : '') + '</div>';
```
(c) app.js L132–133 — one line per date so the 184 px column never wraps:
```js
var when = r.status === 'done' ? '<span>Effacée le ' + fmtDate(r.completed_at, { day: 'numeric', month: 'short' }) + '</span><small>' + (r.next_check_at ? 'revérif. le ' + fmtDate(r.next_check_at) : basis) + '</small>'
  : r.sent_at ? '<span>Envoyée le ' + fmtDate(r.sent_at, { day: 'numeric', month: 'short' }) + '</span><small>' + (r.due_at ? 'réponse due le ' + fmtDate(r.due_at, { day: 'numeric', month: 'short' }) : basis) + '</small>'
  : '<span>Prochain envoi</span><small>' + basis + '</small>';
```
Expected row height ≈ 62 px, header aligned.

## 4. MAJOR — Journal is a 2 222 px column of 7-line green paragraphs
**Screens:** `v-5-dash-top.png`, `v-5b-dash-rows.png` (right column).
`.timeline li { grid-template-columns: 90px 1fr }` (L236) inside a 340 px sheet leaves 148 px for text; a typical event ("Dun & Bradstreet confirme l'effacement — suppression confirmée (simulation). Nouvelle vérification dans 90 jours.") becomes 7 lines / 195 px, ×14 entries. Whole entries are tinted green/amber (L246–248), so the sidebar out-shouts the table. The Échéances card is pushed 2 200 px down.
**Fix:** stack time above message at every width, colour only the dot, show fewer entries.
app.css L236–248 replace with:
```css
.timeline li { position: relative; display: grid; grid-template-columns: 1fr; gap: 3px; padding: 10px 0 10px 22px; font-size: .9rem; line-height: 1.45; }
.timeline li::before { content: ""; position: absolute; left: 4px; top: 0; bottom: 0; width: 1px; background: var(--border); }
.timeline li:first-child::before { top: 18px; }
.timeline li:last-child::before { bottom: calc(100% - 18px); }
.timeline li::after { content: ""; position: absolute; left: 0; top: 14px; width: 9px; height: 9px; border-radius: 50%; background: var(--surface); border: 1.5px solid var(--border-strong); }
.timeline li.t-done::after { background: var(--success); border-color: var(--success); }
.timeline li.t-sent::after { background: var(--text); border-color: var(--text); }
.timeline li.t-action_required::after, .timeline li.t-followup::after { background: var(--warning); border-color: var(--warning); }
.timeline li.t-error::after, .timeline li.t-refused::after { background: var(--danger); border-color: var(--danger); }
.timeline time { font-family: var(--font-mono); font-size: .7rem; letter-spacing: .04em; color: var(--muted); }
```
(delete the three `.timeline .t-done / .t-action_required / .t-error` colour rules). app.js L151: `d.events.slice(0, 14)` → `d.events.slice(0, 8)`. Also delete the now-redundant `.timeline li { grid-template-columns: 1fr; gap: 2px; }` in the 767 px media block (L305).

## 5. MAJOR — The loudest CTA on Billing is a downgrade; onboarding features the wrong plan
**Screens:** `v-7-billing.png` + `run2/desktop-7-abonnement.png`, `run2/desktop-4-onboarding-offre.png`.
`plansBlock` hardcodes `plan--featured` to `individuel` and gives it the solid vermilion `.btn`, so a Famille subscriber sees "Passer à Individuel" as the only solid button on the page while their own plan gets a thin accent border. During onboarding the user already chose Famille at signup (`user.plan` is stored — verified in `/api/me`: `"plan":"famille"`) yet Individuel is framed in ink and Famille's button is outline.
**Fix (app.js L119 and L122):**
```js
var featured = u && u.plan ? u.plan : 'individuel', subscribed = !!(u && u.subscription_status === 'active');
// L119
return '<div class="sheet plan' + (k === featured ? ' plan--featured' : '') + (cur ? ' is-current' : '') + '">…
// L122 button class
'<button class="btn btn--block' + (subscribed || k !== featured ? ' btn--outline' : '') + '" type="button" data-checkout="' + k + '">'
```
(solid only for the chosen plan during onboarding; every plan-change button on Billing is outline).

## 6. MAJOR — Ledger: "Terminées" column sits 11 px higher than the other three
**Screen:** `v-5-dash-top.png`.
`.ledger { align-items: center }` (L197) vertically centres each stat; the 4th sub-line "effacements confirmés" wraps to two lines, making that stat taller, so its label/number float up (measured label tops 405 / 405 / 405 / 394). The dividers also stop short of the ring.
**Fix (app.css L197–198, L203):**
```css
.ledger { display: grid; grid-template-columns: repeat(4, 1fr) auto; align-items: stretch; padding: 8px 32px; }
.ledger__stat { padding: 22px 28px 22px 0; margin-right: 28px; border-right: 1px solid var(--border); display: grid; gap: 6px; align-content: start; }
.ledger__ring { display: flex; align-items: center; align-self: center; gap: 16px; padding: 14px 0; }
```

## 7. MAJOR — Mandate text is clipped mid-line with no scroll affordance
**Screens:** `v-3-mandate.png` (onboarding), `v-6b-dossier-mandate.png` (dossier).
`.mandate-text { max-height: 320px; overflow: auto }` (L160): scrollHeight 474 vs 318 visible; with overlay/hidden scrollbars the last visible line is sliced through its x-height and nothing says "scroll". The user is then asked to tick "J'ai lu le mandat" on a document that looks truncated. The full text is only ~155 px taller.
**Fix (app.css L160):** `.mandate-text { …; max-height: none; overflow: visible; }`. If a cap is really wanted: `max-height: 440px; overflow: auto; scrollbar-gutter: stable; padding-bottom: 32px;` and style the scrollbar (`.mandate-text::-webkit-scrollbar { width: 8px } .mandate-text::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 4px }`). Same treatment for `.mail-body` (L230, `max-height: 380px`).

## 8. MINOR — Dossier mandate foot prints a bare "VERSION"
**Screen:** `v-6b-dossier-mandate.png` (bottom right).
`u.mandate_version` is absent from the `/api/me` payload for this user, so L165 renders "Version " with nothing after it.
**Fix (app.js L165):** replace `'<span class="mono">Version ' + esc(u.mandate_version || '') + '</span>'` with
```js
((u.mandate_version || state.config.mandate_version) ? '<span class="mono">Version ' + esc(u.mandate_version || state.config.mandate_version) + '</span>' : '')
```

## 9. MINOR — Échéances: value and caption pushed to opposite edges, "—" rows look broken
**Screen:** `v-5g-dash-sidebar-bottom.png`.
`.deadline { grid-template-columns: 1fr auto }` (L250) right-aligns the caption ~150 px from its figure; "— prochaine réponse due" reads as an error.
**Fix:** app.css L250: `.deadline { display: flex; align-items: baseline; gap: 10px; font-size: .92rem; }`. app.js L157: only render rows that have a value:
```js
(nextDue ? '<div class="deadline"><b>' + fmtDate(nextDue) + '</b><span>prochaine réponse due</span></div>' : '') + (d.next_check_at ? '<div class="deadline"><b>' + fmtDate(d.next_check_at) + '</b><span>prochaine vérification</span></div>' : '') + (c.queued ? '<div class="deadline"><b>' + c.queued + '</b><span>demandes à envoyer</span></div>' : '')
```
and show `'<p class="empty" style="padding:20px 32px">Aucune échéance.</p>'` if all three are empty.

## 10. MINOR — 41 tilted "TERMINÉE" stamps in one column
**Screen:** `v-5e-dash-filter-done.png`.
`.chip--done { transform: rotate(-2deg); border: 1.5px }` (L119). One rotated stamp on the mandate is charming; 41 identical tilts in a table column read as misalignment, and the 1.5 px border makes that chip taller than its siblings. Keep the stamp for `.stamp`, not for table chips.
**Fix (app.css L119):** `.chip--done { color: var(--success-ink); background: var(--success-soft); border-color: var(--success); }` (remove `transform` and the 1.5 px border).

## 11. MINOR — Orphaned "Pays de résidence" select; identity grid is 3 columns on onboarding, 4 on Dossier
**Screens:** `v-2-onboarding-top.png`, `run2/desktop-6-dossier.png`.
`repeat(auto-fit, minmax(220px,1fr))` yields 3 columns in the 844 px onboarding sheet (select alone on row 2 with ⅔ empty) and 4 in the 1 132 px dossier sheet. A fixed 2×2 (Prénom | Nom / Date | Pays) reads as a form, not a spreadsheet.
**Fix:** app.js L95 `'<div class="fields">'` → `'<div class="fields fields--2">'`; app.css add `.fields--2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }`. Optional: tone down the native date icon `.f input[type="date"]::-webkit-calendar-picker-indicator { opacity: .55; cursor: pointer; }`.

## 12. MINOR — Four ink-bordered "Ajouter" pills compete with the primary button
**Screen:** `v-2b-onboarding-tags.png`.
`.tags__add button` (L107) uses a 1 px ink border + 600 weight, so the four add buttons form a column of secondary CTAs as heavy as "Enregistrer et continuer"; they also sit 8 px above the underline baseline. The tag pills themselves are fine (this fixes the old "ugly squares" complaint).
**Fix (app.css L107–108):**
```css
.tags__add button { flex: none; height: 32px; padding: 0 12px; margin-bottom: 7px; border-radius: 999px; border: 1px solid var(--border-strong); color: var(--muted); font-size: .85rem; font-weight: 500; background: transparent; transition: border-color .15s, color .15s; }
.tags__add button:hover { border-color: var(--text); color: var(--text); background: transparent; }
```

## 13. MINOR — Opened mail panel misaligned with the row and the toggle has no open state
**Screen:** `v-5f-dash-mail.png`.
`.mail { grid-column: 1 / -1 }` (L229) starts the mono header and the mail box under the sensitivity dots (x 107) while the row's text column starts at x 169; "Courrier" stays identical when open.
**Fix:** app.css L229: `.mail { grid-column: 2 / -1; display: grid; gap: 12px; padding: 4px 0 8px; }`. app.js L295 `if (open) { open.remove(); return; }` → `if (open) { open.remove(); t.textContent = 'Courrier'; return; }` and after L299 `row.appendChild(box);` add `t.textContent = 'Fermer';`.

## 14. MINOR — Settings: "Supprimer le compte" password underline runs 1 066 px
**Screen:** `run2/desktop-8-parametres.png`.
A lone field in `.fields` auto-fit takes the full sheet width; a password rule spanning the page looks like a divider.
**Fix (app.css):** `#delete-form .fields { max-width: 420px; }`.

## 15. MINOR — Dashboard vertical rhythm: notices use 24 px, everything else 28 px
**Screen:** `v-5-dash-top.png`.
`.dash-head` (28 px), `.dash-grid` (28 px) and `.stack` (28 px) share one beat; the three notices in `views.dashboard` (app.js L144–146) carry `style="margin-bottom:24px"`.
**Fix:** replace the three `style="margin-bottom:24px"` with `style="margin-bottom:28px"` (or drop the inline styles and add `.view > .notice { margin-bottom: 28px; }`).

---

**Verdict.** The bones are right: paper/ink/vermilion, Fraunces display + mono eyebrows + underlined fields read as the same product as the landing, and auth, mandate signature, plan cards and sheet chrome are already at a Stripe-grade finish.
Two CSS slips (stretched `.f` rows, the `.rail__step span` override) are what made the identity form feel "not adapted", and the dashboard's weakness is purely structural: a misaligned, over-tall broker table beside a journal that wraps into seven-line paragraphs.
Apply items 1–7 (≈40 lines of CSS/JS) and the app will look finished; 8–15 are polish that an engineer can do in one pass.