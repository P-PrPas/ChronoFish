# Due observation workspace redesign

## Before evidence

The embryo observation round in `frontend/src/pages/due.tsx` rendered one expanded form card per embryo. The supplied demo evidence was:

- 72 embryo cards for a round of 72 embryos.
- 216 select controls (stage, outcome, and condition) plus 72 notes inputs.
- 288 repeated labels and controls.
- Approximately 7,723 px of desktop page height and 28,294 px of mobile page height.

That structure made spatial plate scanning difficult and forced researchers to traverse a long repeated form even when most wells had the same normal result.

## Design decisions

- The round is now an exception-first plate workspace. Every active embryo is represented by one compact, operable well button sorted by physical well position (`A1`, `A2`, …), with unassigned wells at the end.
- Desktop uses a 12-column map beside one selected-well editor. At the mobile breakpoint the map becomes four columns and the editor becomes a single full-width panel; there is no intentional horizontal scroll for the checkpoint workspace.
- The editor keeps stage, outcome, and condition visible. Outcome defaults to `ALIVE`; condition defaults to the API-provided `defaultCondition`. Notes and override reason are native disclosure sections and start collapsed.
- The suggested stage remains explicit. Applying it affects only currently blank, unsaved embryos and states the exact affected count. The latest application can be undone/cleared without changing manually edited values or saved/queued rows.
- One sticky confirmation bar is the only primary CTA. It always exposes the current ready count and a plain-language explanation when confirmation is disabled.
- State is communicated by symbol and text as well as semantic color: `○ Unreviewed`, `• Ready to save`, `! Exception`, `↺ Queued`, and `✓ Saved`.
- Exceptions can be located with the status filter and reviewed in the one editor. Search accepts either Well ID or the longer embryo code.

## Component breakdown

The implementation stays in the existing due page rather than adding a component dependency:

- `wellPositionKey` sorts wells by row and numeric column.
- The initial selected well is the first physical well after sorting, so an unsorted API response still opens `A1` (or the first available physical position).
- `wellButtonId` provides stable focus targets for roving keyboard navigation.
- `stateFor` gives an un-staged embryo precedence over an exception state for progress/ready status; `hasException` remains independent so abnormal defaults still appear in the exception metric and filter.
- The plate map renders one button per embryo, with a unique accessible name containing Well ID, embryo code, state, and selection state.
- The selected editor owns the existing stage/outcome/condition/notes/override payload state.
- Existing queue-drain, queue-rejection, correction, and ten-second undo flows remain wired to the same API paths and payload fields.
- The metrics strip reports ready, unreviewed, exceptions, and saved counts.

## Files changed

- `frontend/src/pages/due.tsx` — compact map/editor workflow, status derivation, safe bulk stage undo, keyboard navigation, progressive disclosure, and localized visible status labels.
- `frontend/src/styles.css` — map/editor layout, 12-column desktop and four-column mobile grid, status treatments, metrics, sticky action bar, and focus scroll margins.
- `frontend/tests/due-workflow.test.tsx` — updated targeted assertions for the plate map and single editor contract while retaining payload, rejection, correction, and undo coverage.

The requested user-owned dirty paths (`compose.yaml`, `.tmp/`, `backend/db/seeds/postgres/demo_data.sql`, and `docs/example_data/`) were not staged or changed by this work.

## Accessibility behavior

- Native buttons, selects, inputs, textarea, `fieldset`/`legend`, and `details`/`summary` provide semantic controls and grouping.
- Well buttons have at least 44 px minimum height, visible `:focus-visible` treatment from the existing tokenized CSS, `aria-pressed`, and a unique accessible name including Well ID.
- The grid uses a roving `tabIndex`; Left/Right and Up/Down select neighboring physical wells and move focus to the new well. The selected well is exposed with `aria-selected` on its grid cell and `aria-pressed` on its button.
- Status and progress regions use polite live announcements. Symbols are supplementary; state names remain visible text and are included in accessible names, so color is not the sole indicator.
- Sticky editor controls and the action bar use scroll margins so keyboard focus has clearance from sticky UI.
- Critical labels remain at readable sizes: well codes and statuses are 0.8 rem on desktop and 0.75 rem on narrow mobile, with the explicit `Ready to save` wording. All controls retain the existing 44 px target sizing.

## Responsive behavior

- Desktop: `minmax(0, 1fr) minmax(330px, 360px)` plate/editor columns; 12 grid columns with a 44 px minimum well width. The narrower editor preserves the target well size at 1440 px without document overflow.
- Up to 780 px: one workspace column with the editor ordered before the plate, four grid columns, and a stacked sticky action bar. Selecting a well deliberately scrolls the editor heading into view; a Return to plate action restores the selected well’s focus.
- Up to 430 px: tighter panel padding and filter stack; four-column cells still retain their minimum touch height. The checkpoint grid has no fixed minimum width.
- The separate batches well plate retains its existing horizontal overflow behavior; the checkpoint redesign does not alter that page.

## Browser QA follow-up

The first browser review identified five details that were addressed in the follow-up implementation:

- An API response in physical order was not guaranteed; initialization now sorts before selecting, so the first editor is the first physical well rather than the first response item (regression-covered with an unsorted `A2`, `A1` fixture).
- An `ABNORMAL` default with no selected stage was visually an exception but still unreviewed work; progress now counts it as unreviewed until stage selection, while the exception metric/filter continues to expose it for review.
- At 1440 px the prior flexible grid could produce 43.406 px wells; the 44 px grid/cell floor and 360 px editor column keep each target at least 44 × 44 px without horizontal overflow.
- Well code/status metadata was cramped at roughly 11–12 px desktop and 10–11 px mobile; it now uses 12.8 px desktop and 12 px narrow mobile, with explicit status wording.
- On 375 px, the editor no longer follows all 72 wells. It is ordered before the four-column plate, well clicks scroll to the editor, and the Return to plate action restores spatial review. Well/editor focus targets also have scroll margins so the sticky confirmation bar does not obscure keyboard focus.

## Tests and results

Commands run from `frontend/`:

```text
npm.cmd run build
✓ tsc --noEmit
✓ vite build

npx.cmd vitest run tests/due-workflow.test.tsx
✓ 1 test file, 9 tests

npm.cmd test
✓ 16 test files, 63 tests
```

The first full run exposed only stale assertions tied to the removed repeated-card DOM. Those targeted assertions were updated to check the approved compact map/single-editor behavior; the workflow payload and failure-path tests remain present. The follow-up adds regression coverage for physical-order initialization and unreviewed/exception precedence.

## Before versus after measurable metrics

For the 72-embryo demo round, the rendered structure changes deterministically as follows:

| Measure | Before | After (initial state) |
| --- | ---: | ---: |
| Embryo forms/cards | 72 expanded cards | 0 expanded cards; 72 compact WellCell buttons |
| Stage/outcome/condition selects | 216 repeated selects | 3 in one editor, plus 1 explicit bulk-stage select |
| Notes controls | 72 visible inputs | 0 until the selected well opens “Add notes” |
| Override reason controls | 1 always-visible field | 0 until the selected well opens the override disclosure |
| Visible repeated labels/controls | 288 repeated items | One editor’s fields plus map/status labels; exact count varies with disclosure state |
| Desktop map rows | Not applicable | 6 rows at 12 columns for 72 wells; each well target has a 44 px minimum |
| Mobile map rows | Not applicable | 18 rows at 4 columns for 72 wells; editor appears before the map |
| Confirm action | Page-heading CTA | One sticky primary CTA with ready/disabled explanation |
| Spatial exception review | Manual page traversal | Status filter + search + one editor |

The old pixel heights were supplied pre-change evidence. A real browser geometry measurement should be taken as part of visual QA against the actual 72-row API fixture; this repository’s current test environment does not provide reliable layout metrics.

## Known limitations and follow-ups

- Queue-drained responses are authoritative for saved IDs; queued rows are shown as `Queued` until the existing offline replay emits its drain event.
- The API currently omits exited embryos from the checkpoint response, so override reason is retained as a generic disclosed field for server-side validation without inventing client-side exit logic.
- The current undo window is the existing ten-second server contract. Its visibility is reevaluated on a render rather than by a new timer; the server remains the source of truth after expiry.
- Dark-mode and zoomed-text visual checks remain follow-ups; the reported 375 px and 1440 px layout findings are covered by the browser QA fixes above and should be rechecked during release QA.
