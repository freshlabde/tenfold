# tenfold — UI audit, 2026-08-09

Method: the real app, driven with Playwright at 390×844 CSS px / 2× device pixels, one screen
at a time, screenshot, look. Every finding below was seen in a picture or measured in the live
DOM — nothing here was inferred from reading the source. Where a defect had a mechanism, the
mechanism was confirmed by measurement before it was fixed.

Covered: first run, the three setup steps, the About intro, the empty and full outline, the
composer, the row menu, focus (empty and full), leaf, the editor sheet, the story guide, the
duel (rest, mid-swipe, result), Today with the daily question, search (empty, one hit, many),
the context index and both of its sheets, settings top to bottom, the pairing sheet, the
plaintext-export sheet, the local-model sheet, the cloud-consent sheet, About, the lock screen
(clean and after a wrong passphrase), the map (overview, focused family, recentred), the
image-import proposal, the assist menu and an assist proposal — each of them in slate/dark, and
outline, focus and map additionally in slate-light, register-dark, register-light, breath-dark
and breath-light.

Ratings: **P1** hurts daily use · **P2** polish · **P3** nice.

Screenshots: `design/screens/30-audit-*.png` (before/after pairs). The map comparison lives in
`design/map-alternatives.html` and `design/screens/30-audit-map-alternatives.png`.

---

## 0. What is already right

Worth naming, because the audit that only lists faults gives a false picture of the app.

- **The outline is the best screen in the product.** Rank reads instantly: the leading plate is
  lifted, the ninth and tenth have visibly sunk into the ground, and the ladder is carried by
  three channels at once (opacity, type size, plate depth) so it survives in all three skins.
- **The mono rail is a real idea, consistently applied.** Everything machine-made — counts,
  dates, progress, ranks — is set in the mono face and never mixes with human text. It is what
  makes the app feel like an instrument rather than a notes app.
- **The duel is the app's best moment.** The beam tilts under the finger, the rising card
  catches the light and the sinking one dims, and both have plain button equivalents. It is
  physical without being cute.
- **The three skins are genuinely three designs**, not one design with three palettes: register
  really is a set book, breath really is text on black. Both light themes hold up.
- **The copy is uniformly excellent.** No marketing tone, no AI-tells, and every empty state
  says something useful rather than apologising.

---

## 1. The map

### 1.1 Verdict: keep the constellation — and repair it

The alternatives were built and screenshotted before deciding:
`design/map-alternatives.html`, five panels of the same vault.

| | Representation | Verdict |
|---|---|---|
| A | the constellation as it shipped | keep the idea, not the execution |
| B | radial tree / sunburst around a centre | **rejected** — wrong shape for a tall screen |
| C | vertical branch columns | **rejected** — duplicates the outline |
| D | treemap by subtree size | **rejected** — encodes the wrong quantity |
| E | the constellation, repaired | **recommended, implemented** |

**B, radial tree.** A tidy hierarchy and a natural centre, and on a 390-wide phone it dies. At
the three-o'clock and nine-o'clock positions two names want the same line; labels have to be cut
to about thirteen characters to fit beside the ring at all; and a ring is a square shape on a
tall screen, so a third of the canvas is dead above and below it. The existing code comment was
already right about this, and the sketch confirms it visually.

**C, vertical branch columns.** By a distance the most legible of the four: full titles, no
collisions, parts as a countable row of dots, progress trivially addable. And that is exactly
the problem — it is the outline with dots added. It answers nothing the list does not already
answer, and the app already ships that screen one tap away. A second view has to be a second
*way of seeing*, or it is furniture.

**D, treemap.** Area is the loudest channel a chart has. Here it would say that a goal broken
into six steps matters more than one broken into none, which is the opposite of the method:
rank comes out of the duel, never out of how much has been written down. Rejected on semantics,
not on looks.

**A → E.** The constellation's faults were all execution faults, and all fixable:

- every family was the same brass, so nothing said which small orbs belonged to which goal;
- labels were clamped at 26 characters **mid-word** ("Less screen time in the e…");
- labels were dropped straight onto the discs, and the background-coloured stroke that keeps
  them readable then painted a visible dark box around the letters — the single most
  defect-looking thing in the whole app;
- below rank five the numeral inside a body was 8.4px at 78% opacity on a fill that had already
  been mixed down towards the background: decoration, not information;
- focusing a goal with no parts magnified one disc until it filled the screen;
- the sky ran off the bottom edge on a hard cut, and nothing anywhere said a body was tappable.

None of that is an argument against the representation. Kept, and repaired.

### 1.2 The family palette (the one place multi-colour was licensed)

The one-accent law still governs every **control**. The accent means "you": what you pressed,
what you are on, the primary action, the focus ring on a focused body. The new palette means
"the things": which parts belong to which goal. Two jobs, two systems, and no control anywhere
in the app may reach into the second one.

Decisions, in detail:

- **Ten hues at one lightness and one chroma**, in OKLCH. Dark `oklch(.735 .062 h)`, light
  `oklch(.545 .075 h)`. Only the hue moves, so no family is louder than another and none of
  them is louder than the app. `.062` is roughly a third of the chroma a normal categorical
  chart palette would use — this had to stay inside a calm room, and it does: put beside the
  old brass-only map, the repaired one does not read as "colourful", it reads as *sorted*.
- **Per theme, not per skin.** A data surface that changed meaning because somebody prefers
  serifs would be a different chart. `L .735` in dark so a body reads as *lit* against the
  night; `L .545` in light so it reads as *ink* on paper. The hues are identical in both.
- **Hue order walks the wheel in jumps**, not around it:
  `72° brass · 250° blue · 32° clay · 168° teal · 305° mauve · 108° olive · 212° steel ·
  46° bronze · 278° indigo · 140° moss`.
  Two families that end up adjacent on screen are therefore far apart in hue. Rank one keeps
  the warm end so the map still opens with the app's own colour temperature.
- **Colour-blind considerate by construction, not by luck.** Rank never rides on hue: it is
  carried by size (rank one is ~2.2× the radius of rank ten) and by how much of the family
  colour is mixed into the body (`--rm`, 80% → 34%). The pairs that collapse under
  deuteranopia — clay/olive/moss — sit at ranks 3, 6 and 10, three different sizes and three
  different brightnesses. Nothing on this screen depends on hue alone, so nothing on it is lost
  when hue is lost.
- **The script never names a colour.** `ui/map.js` writes the family *index* as a class
  (`is-fam0…is-fam9`) and the ladder as plain numbers; what those mean is decided in `app.css`,
  next to the skins. The single exception is the halo's `fill`, which is a fragment id and not
  a colour — a paint server referenced from an external stylesheet resolves against the
  stylesheet's own URL in some engines, so that one has to be an attribute.
- **Halo strength is a theme token now** (`--map-halo-in/-mid`, `--map-core`). On paper a halo
  stops reading as light and starts reading as a smudge; the light themes had ten grey smears
  behind ten orbs. Pulled back to a whisper.
- **Fallback**: where OKLCH is unavailable the whole palette collapses to the skin's accent —
  a quieter map, never a broken one. The same bargain the old hue-turn struck.

### 1.3 Map findings

| # | Finding | Rating | Status |
|---|---|---|---|
| M1 | Labels clamped mid-word at 26 characters | P1 | fixed — 32-character budget, cut on a word boundary or not at all |
| M2 | Labels placed on top of discs; the readability stroke then paints a dark box around the glyphs | P1 | fixed — the placement pass now walks a name clear of every disc, down first, up if down is blocked |
| M3 | Rank numerals unreadable from about rank five down | P1 | fixed — floor raised 8.4→10.4px, weight 600→700, opacity .78→.92, ink flip moved to where the fill actually turns |
| M4 | Every family the same brass: no way to see which parts belong to which goal | P1 | fixed — the data palette above |
| M5 | Focusing a goal with no parts fills the screen with one disc | P2 | fixed — zoom capped at 1.5× base for a bare goal |
| M6 | A focused branch centres on the geometric middle and slides under the floating header | P2 | fixed — focus now uses the same header-aware centre as the initial fit |
| M7 | The sky runs off the bottom edge on a hard cut; nothing says a body can be tapped | P2 | fixed — a bottom veil carrying one line, which goes at the first gesture (`map.hint.tap`, en/de/es) |
| M8 | Bodies too small for the canvas; the sky reads as emptier than it is | P2 | fixed — root radii 34/14.6 → 38/17, parts 10.6/7/4.8 → 11.6/7.6/5.2, `MIX_MIN` 28→34 |
| M9 | Halo reads as a smudge on paper in both light themes | P2 | fixed — per-theme halo opacity |
| M10 | The horizontal position of a goal carries no meaning while looking like it does | P3 | **not done** — see §5 |

---

## 2. Findings across the app

### P1

**A1 · The whole app slid up to 28px too high, on every screen, intermittently.**
The eyebrow lost its ascender everywhere (measured: `.eyebrow` top = −4px where it should be
24px), the duel title sat flush against the very top of the glass at y=0, and opening the
pairing sheet pushed the sheet's own title off the screen (measured: `.sheet-title` top =
−15.8px). Mechanism, confirmed by measuring `.frame.scrollTop`: `.frame` is `overflow: hidden`,
which is still a *scroll container*, and the two things that park themselves outside the frame —
the retracted toast and a closed sheet, both moved by a transform — extend its scrollable area
downwards. Any focus inside then let the browser scroll the frame to "reveal" something.
Fixed with `overflow: clip`, which creates no scroll container at all; `overflow: hidden` stays
in front of it as the fallback. `.frame.scrollTop` is now 0 on every screen measured, and there
is a regression test that says so.

**A2 · Twelve segmented-control buttons at 38px, under the 44px tap floor.**
Skin, theme, language, story depth, assistance mode, entity kind, sensitivity — every segment in
the app. The token `--tap: 44px` existed and the segment simply did not use it. Fixed; a test
now walks the settings screen and fails on anything under 44.

**A3 · The search bar rendered a native, system-blue cancel cross** next to our own close
button — two crosses, two colours, one of them owned by the platform. `type="search"` buys the
right on-screen keyboard and that control comes with it. Fixed with `appearance: none` on
`::-webkit-search-cancel-button`.

**A4 · Every goal that had parts looked struck through.**
The progress track is a full-width sunken 2px bar under the title. At 0% it is *only* the
trough, and since only a goal with parts carries one, exactly one row in ten had a rule under
its title. In register-light it collided with the row's own hairline. Fixed: the gauge is drawn
only once there is progress to show, and it is now a 56px bar rather than a full-width rule —
a gauge, not an underline. The "0/6" in the mono rail already said the rest.

**A5 · Long-form text was guillotined by the action bar.**
The About intro cut its last visible line exactly in half behind the "Begin" bar; the editor
sheet cut "DUE DATE" behind its footer; the entity sheet cut the sensitivity explanation. In
every case there was no fade, no shadow, nothing to say more existed. Fixed with a 22px veil
above `.bar` and `.sheet-foot`.

**A6 · The pairing sheet opened focused on its readonly link, which selected itself** in system
blue and dragged the app up by 102px (mechanism A1). Fixed twice over: the sheet's autofocus
now skips readonly fields, and `::selection` is a token colour.

**A7 · Settings chevrons shrank.** The chevron is a flex item beside a growing block of text;
without `flex: none` the three-line "Turn on sync" row squeezed it from 18px to **7.6px**
(measured). Three sizes of chevron on one screen. Fixed.

### P2

**A8 · The empty states opened a 50px hole between headline and sentence.**
`.empty-line` and `.empty-hint` are `<p>`s with no margin reset, so the browser's own 1em
margins were added to the flex gap. Visible on the empty outline, the empty focus screen and
the empty context index. Fixed.

**A9 · Settings had one heading rank pretending to be two.** "APPEARANCE" (a group) and "SKIN"
(one control's label) were rendered in exactly the same mono capitals, so the screen read as
one long ladder of shouting labels with no structure. Fixed: a new `.field-key`, smaller and
tighter-tracked, and `.group-key` brightened to hold the rank above it.

**A10 · The chosen segment was one grey away from the unchosen ones** in the dark themes — it
carried its state in text colour alone. Fixed: it sits on a real plate with an edge, and its
label is heavier.

**A11 · The breadcrumb pill truncated at 16 characters**, turning "Run ten kilometres again"
into "RUN TEN KI…", which names nothing. The row scrolls sideways, so the width cost nothing.
Raised to 24ch.

**A12 · The leaf breadcrumb hid the way back to the ten** that the focus screen has always
shown, so the same row of pills meant two different things one tap apart. Fixed: the leaf now
leads with "The Ten" like everything else.

**A13 · The duel's swipe glow painted a hard-edged rectangle** across the screen — a linear
gradient inside a box has a box's edges. Fixed with a radial gradient bled past the beam.

**A14 · The duel result listed every rank twice**, once in the chip on the left and once in the
mono rail on the right. Removed.

### P3 — recorded, not fixed

**A15 · The row menu is unreachable by touch from the outline.** Long press is taken by the
drag-to-reorder gesture and right-click is a desktop affordance, so edit/finish/move/delete for
a goal can only be reached by opening it first and using the "…" in its breadcrumb. This is
deliberate and documented in `ui/focus.js`, and every action has a route; it is still one
level deeper than it reads.

**A16 · The accent carries three meanings at once** — primary action, destructive action
("Delete", "Lock now") and error ("That did not open the vault"). With one accent per skin an
error cannot look like an error. Fixing it means a second semantic colour across the whole app,
which is a bigger decision than this audit's mandate (the owner licensed multi-colour for
*data-bearing surfaces*, and this is not one).

**A17 · "Import from a photo" is as loud as the primary action.** A tertiary entry point set in
full accent, sitting directly above the bar; in register-light it competes with "Put in order".

**A18 · With ten roots already written, the photo import is dead** — every proposed top-level
line is blocked by the ten-root rule and the sheet offers "Take over 0". The one line of
explanation at the bottom is correct and honest, but the flow could offer to file the picture
under an existing goal instead of ending in a dead sheet.

**A19 · The setup steps leave 40–50% of the screen empty** between the last field and the
bottom action. I tried centring the short steps and reverted it: it divorces the fields from the
heading that explains them and moves the hole *above* the content, which is worse. Head at the
top, action under the thumb, air between is the correct phone pattern, and the void is not a
defect. Recorded so the next reader does not re-litigate it.

---

## 3. Consistency notes

- Type sizes are coherent across screens (`.h-title` 26 / `.leaf-title` 24 / `.hero-title` 24 /
  `.sheet-title` 18 / `.duel-card-title` 21) and nothing was found off the scale.
- Gutters all come from `--gutter`; no screen invents its own.
- Row plates, setting rows and assist items share one padding rhythm.
- The one genuine inconsistency found was the heading rank in settings (A9) and the breadcrumb
  (A12); both fixed.

## 4. What was changed in code

`web/css/tokens.css` — the data palette (`--data-1…10`, per theme) plus the three map light
tokens, an extended token contract, and an OKLCH fallback block.
`web/css/app.css` — A1, A2, A3, A4, A5, A7, A8, A9, A10, A11, A13, plus the map's family and
numeral rules and the bottom veil.
`web/js/ui/map.js` — M1, M2, M3, M4, M5, M6, M7, M8; the hue-turn mechanism replaced by family
classes; drift accumulated once per frame instead of walked per label.
`web/js/ui/rows.js` — A4. `web/js/ui/sheet.js` — A6. `web/js/ui/settings.js` — A9.
`web/js/ui/leaf.js` — A12. `web/js/ui/duel.js` — A14.
`web/js/locales/{en,de,es}.js` — one new key, `map.hint.tap`, in all three.
`docs/CONTRACTS.md` — the data palette is now part of the token contract.

No new file under `web/`, so the service worker `SHELL` list is unchanged and `VERSION` is not
bumped (batched, per the standing rule). The precache drift test still passes.

## 5. Left open

- **M10, the meaningless horizontal axis.** In the constellation a goal's x position is decided
  by the physics and carries no information, while looking as though it might. The honest fix is
  to give it a meaning — how far the goal has been broken down, or how much of it is finished —
  which would turn the sky into a real two-axis chart (rank down, progress across). That is a
  design decision about what the map is *for*, not a defect, and it belongs to the owner.
- **A16, the overloaded accent.** Needs a decision about a second semantic colour before it can
  be built.
- **A18, photo import against a full ten.**
- The audit was run at one viewport (390×844). Nothing was checked at 320px wide, and the
  desktop framed view was only spot-checked by the existing test.
