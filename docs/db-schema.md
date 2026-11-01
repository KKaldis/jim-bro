# Database schema

This document explains every table in the database — what it represents and the
business logic behind it — for both human contributors and the AI agent.

The schema is defined in [`packages/db_postgres/src/schema.ts`](../packages/db_postgres/src/schema.ts)
and is the **single source of truth**. Changes ship as migrations: edit the schema,
run `npm run db:generate` (`drizzle-kit generate`) to write a SQL file in
[`drizzle/`](../drizzle), then apply it with `npx drizzle-kit migrate` locally or
`npm run db:migrate:prod` in prod. Prefer `migrate` over `db:push`. Generated files
can be hand-edited to add data backfills (e.g. `0015` copies per-day water goals to
the profile before dropping them), and `push` skips those.

When a migration **drops a column**, deploy the code first and migrate after. Drizzle's
`select()` lists every schema column, so the old code breaks as soon as the column is gone.
Take a backup first (`npm run db:backup:prod`), since drops can't be undone.

Two layers:

1. **Better Auth tables** — `user`, `session`, `account`, `verification`. Names and
   columns are dictated by Better Auth; don't rename them.
2. **App tables** — everything else. Every app table has a `user_id` FK to `user.id`
   with `ON DELETE CASCADE`, so `DELETE /me` tears a user's entire footprint down in
   one statement.

## Design conventions

- Storage is **metric** (kg, cm, g/ml). Imperial input is converted at the API
  boundary, never stored.
- Nested-but-bounded structures (diet rotation, meal items) are stored as **JSONB**
  blobs — they're per-user data we read whole and never query into. Things we _do_
  query into (body-comp time series, workout sets) are **normalized** into rows.
- Dates are `YYYY-MM-DD` `varchar(10)` strings, not `date` columns, so they round-trip
  to the API without timezone games.

---

## Better Auth tables

### Aren't `user` / `session` / `account` / `verification` / `profile` redundant?

No — and this comes up because they look alike (every one has an id + timestamps, and
several reference a user). They're a **normalized auth model**, each with a distinct
_cardinality_ and _role_:

| Table          | Rows per user                | What it is                                                            | Why it's separate                                          |
| -------------- | ---------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------- |
| `user`         | 1                            | Identity (email, name, verified flag)                                 | The row everything else FKs to                             |
| `account`      | **N** (one per login method) | A linked credential / OAuth provider — password hash, provider tokens | A user can have password **+** Google **+** Apple = 3 rows |
| `session`      | **N** (one per device)       | An active browser login — session token, 30-day expiry, IP/UA         | Logged in on phone + laptop = 2 rows                       |
| `verification` | transient                    | Pending email-verify / password-reset tokens                          | Created then consumed; not bound to one user row           |
| `profile`      | 1                            | App / fitness domain (sex, birth_year, height, goal…)                 | App-owned, kept off the library-managed `user` table       |

The one field that genuinely appears twice is **`email`**: it's in `user.email`, and for
the email/password login it's also `account.accountId` (with the hash in
`account.password`). That's intentional — `user` is "who you are," `account` is "a way
you can log in." Adding OAuth later means _new `account` rows_, not a schema change, so
the duplication is the price of that flexibility. Collapsing it would break Better Auth.

`user`, `session`, `account`, and `verification` are **owned by Better Auth** (registered
with its Drizzle adapter in [`packages/auth/src/auth.ts`](../packages/auth/src/auth.ts)).
The app only ever _reads_ `user`; the library does all writes. **Do not merge, rename, or
hand-write to these tables.**

`profile` vs `user` is the only pairing that's yours to decide, and keeping them split is
correct: there's **zero column overlap** (user = email/name; profile =
sex/birth_year/height/activity/goal), and `user` is migrated to Better Auth's own expected shape
— putting domain columns there would couple your fitness data to the auth library.

### `user`

The account. `id` is a Better Auth CUID/UUID string and is the FK target for every
app table. Holds email, verification flag, name, timestamps. Everything else
about a person lives in `profile` and the app tables — `user` is identity only.

- **No `image` column.** Login is email + password only, and avatars
  are static SVGs. Better Auth's core user model still has `image`: signup sends
  `image: null`, and `updateUser` forwards any `image` in the body. The Drizzle adapter
  throws on fields missing from the schema, so a `databaseHooks.user` create/update hook
  in [`auth.ts`](../packages/auth/src/auth.ts) strips it. Re-add the column (and remove
  the hook) if OAuth or avatar upload ever lands.
- `email_verified` is set by Better Auth when the user clicks the verification link, but
  nothing in the app gates on it yet.

### `session`

Active login sessions (token, expiry, IP, user agent). Managed entirely by Better
Auth; the app never writes here directly.

### `account`

Credential / OAuth provider links (password hash, access/refresh tokens, provider id).
One user can have several. Managed by Better Auth.

### `verification`

Short-lived email-verification / password-reset tokens. Managed by Better Auth.

---

## App tables

### `profile`

**One row per user. Stable identity + targets only.**

Holds `sex`, `birth_year`, `height_cm`, `activity_level`, `goal`, plus optional
`target_weight_kg`, dietary `restrictions` (JSONB string array), and `notes`.

- `gym_machine_ids` (JSONB string array, nullable) — catalog machine ids the
  user's gym has (snake_case, e.g. `["lat_pulldown_machine","leg_press_machine"]`).
  Optional equipment-availability filter: when non-empty, `search_exercises
{ available_only: true }` restricts machine exercises to this list (free-weight
  / bodyweight always pass). NULL/empty = no constraint. No FK to the static
  catalog — unknown ids are tolerated, same as `exercise_id` / `machine_id` refs.
- `water_goal_ml` (nullable) — the **only** daily hydration goal, applied to every day.
  NULL = app default (2500 ml). There is no per-day water goal (see `water_log`).

Business logic:

- **Weight and body fat are deliberately NOT here.** They live in `body_comp_entry`
  as a time series. Anything needing "current weight" merges the profile's static
  fields (height/sex/birth*year/activity/goal) with the \_latest* `body_comp_entry` at compute
  time. There is no `profile.weight_kg` to keep in sync.
- Agent tools: `update_profile` writes it; `compute_targets` and `get_todays_macros`
  read it. New-user onboarding is "profile missing" → collect fields → `update_profile`.

### `diet_plan` → `diet_plan_day` → `diet_plan_meal` → `diet_plan_portion`

**The user's recurring meal template, normalized** (mirrors the workout
`plan → day → exercise` split).

- `diet_plan`: one row per user (`user_id` unique; bigserial `id` so multi-plan later
  is "drop the constraint"). Carries `start_date` (anchors index-based rotation) and
  per-column `default_target_*` macros (fallback daily target).
- `diet_plan_day`: rotation day — `position` (index-mode order), `weekdays` text[]
  (one day can run Mon AND Thu; empty = index-only), `name`, per-column `target_*`
  override.
- `diet_plan_meal`: `slot` (breakfast | lunch | … | free text), optional `time`
  (HH:MM), `position`.
- `diet_plan_portion`: `food` (soft ref to `pantry_item.name`, no FK — survives
  renames/deletes), `grams`, `position`, and **override-only** macro columns: NULL =
  resolve LIVE from the pantry at read time; non-NULL = absolute macros for this
  portion (inline/estimated foods). `fiber_g` NULL = unknown, 0 = known zero.

Business logic:

- Drives the **daily macro target** (`dayTargetFromPlan`, via the shared
  `dietDayForDate`: weekday match → index rotation → first day → default) shown in
  `get_todays_macros` and used as the "remaining vs target" baseline.
- Drives the **shopping list** (`buildShoppingList` multiplies planned meals over N days
  and subtracts the pantry).
- **Live resolution:** `resolvePortion` / `resolveDietPlan` (`@fa/shared/diet.ts`)
  compute planned macros from the current pantry; a `null` resolution surfaces as
  "needs enrichment" — never zero, never a crash.
- Agent tools: `get_diet_plan` (read), `save_diet_plan` (full replace),
  `delete_diet_plan` (drop the whole template), granular
  `update_diet_day` / `add|update|remove_diet_meal` / `add|update|remove_diet_portion`,
  and `log_planned_meal` ("ate as planned": resolve now, freeze into `meal_log`).
  REST: `/diet/plan` + granular day/meal/portion routes + `/diet/log-planned` (the
  Diet tab on the Nutrition screen uses these).

### `pantry_item`

**Composite PK `(user_id, name)`. The user's single food + supplement catalog.**

There is **no shared/global food database** — a food "exists" for a user iff it's a
pantry row. Each row carries quantity on hand (`quantity` + `unit` of g/ml/pcs),
`grams_per_serving` (so count-based `pcs` items resolve to macros), per-100 g/ml macros
(nullable until known), `category` (supplements are category `supplement`), `barcode`, and a
`to_buy` restock flag. Indexed by `(user_id, barcode)` so a
scanned label resolves against the user's own pantry first.

Business logic:

- Logging a meal looks up macros here first (`lookup_food` / `lookup_product` →
  `add_food`).
- Agent tools: `lookup_food`, `add_food`, `update_food`, `update_pantry`,
  `substitute_food`, `shopping_list`.

### `meal_log`

**PK `(user_id, date)`. One row per day; `meals` is a JSONB `Meal[]`.**

The authoritative record of what was actually eaten on a given day.

Business logic:

- `eaten_today` / `remaining_today` in `get_todays_macros` are **derived from this table
  only** — the agent must never re-sum meals from memory.
- Agent tools: `log_meal`, `update_meal`, `delete_meal`, `preview_meal` (preview does
  _not_ write).

### `daily_steps` / `water_log`

**PK `(user_id, date)`. One upserted row per day holding the day's absolute total.**

- `daily_steps.steps` — pedometer total; `goal` is a per-day step target (nullable →
  app default), written by the step counter UI and `log_steps`.
- `water_log.ml` — water intake total. **No goal column**: the hydration goal is
  `profile.water_goal_ml`. The old per-day `water_log.goal` was a legacy override that
  nothing wrote anymore. It was dropped in `0015`, which first copied each user's latest
  per-day goal to the profile where the profile had none.
- Agent tools: `log_water` (its `goal_ml` writes the profile), `get_water_status`,
  `log_steps`.

### `body_comp_entry`

**Append-only time series. The single source of truth for body state.**

Each row stores raw measurements the user entered (`weight_kg`, `body_fat_pct`,
`body_fat_method`, `waist_cm`, `neck_cm`, `hip_cm`) **and** values derived from them at
write time (`body_fat_pct_navy`, `bmi`, `ffmi`, `ffmi_normalized`, `fat_free_mass_kg`,
`fat_mass_kg`). Indexed by `(user_id, date)`.

Business logic:

- Computed values are **snapshotted with the profile's height/sex at write time**. If
  the user later corrects their height/sex, prior rows keep their original computed
  values — a deliberate trade-off for cheap time-series reads. A future "recompute" pass
  could refresh them.
- The **latest** entry is "current" everywhere: BMR/TDEE math, the dashboard headline,
  MET-based kcal estimates.
- Agent tools: `log_body_comp` (writes + computes), `progress_report` (windowed trend),
  `update_body_comp_entry` (edits an existing entry, recomputes), `delete_body_comp_entry`.

### `conversation_message`

**Append-only. One row per chat message.**

`content` is the full Anthropic content-block array (text + thinking + tool_use +
tool_result). **Image blocks are stripped on save** (replaced by a text placeholder) to
keep rows small and avoid re-paying for image tokens on every turn. `provider` + `model`
attribute each row to the LLM active when it was written, so a conversation that spans a
model switch can be audited per message. Indexed by `(user_id, id)`.

Business logic:

- This _is_ the chat history — loaded at the start of each turn, appended after.
  `resetConversation` (the `/reset` command) wipes it.

### `usage_ledger`

**Append-only ledger of API spend. One row per provider API call (one agent-loop
iteration).** `chat_id` groups iterations of a single `/chat`; `iteration_index` orders
them; `message_id` links to the assistant message produced (`ON DELETE SET NULL` so
erasing chat history preserves cost rows). Records token counts, `provider`, `model`,
`stop_reason`.

Business logic:

- Written by `logUsage` during `chat()`; pruned nightly by `pruneUsageLedger` (rows
  older than 12 months).
- ⚠️ **Currently write-only — see "Review" below.** The token usage users actually see
  (CLI `/usage`, web `ChatUsage`) comes from the live API response, not this table.

### `ai_usage_event`

**AI usage preview.** One row per AI operation: a chat turn (all iterations), a
food/receipt scan, or a chat photo description. `kind` is `llm | image_recognition`;
`source` is the product surface. Stores raw provider token counts, web searches, and
`cost_usd_micros` — the estimated cost at the provider's list price
([`@fa/shared/usage`](../packages/shared/src/usage.ts) `MODEL_PRICES`), NULL for an
unpriced model. `chat_id` joins back to `usage_ledger`. Written by `recordUsage` in
[`@fa/agent/usage`](../packages/agent/src/usage.ts), which then hands the row to
`onUsage` listeners (server extensions); read by `GET /me/usage`.

---

## Food item model: how pantry / meal_log / diet_plan relate

The three food tables look like they store "the same thing," and it's tempting to give
them an identical schema so items can be swapped between them ("I had this in my pantry
→ add it to a meal → put it in the plan"). **They deliberately do not share one schema** —
here's the model, the reason, and the contract that makes swapping work anyway.

### Three concepts, two shared value-objects

| Concept        | Table                                | Role                                              | Macros stored                                                     |
| -------------- | ------------------------------------ | ------------------------------------------------- | ----------------------------------------------------------------- |
| **Definition** | `pantry_item`                        | catalog + inventory ("what chicken*breast \_is*") | **per-100 g/ml**                                                  |
| **Eaten**      | `meal_log`                           | dated history ("what I _ate_")                    | absolute for the portion, **frozen**                              |
| **Planned**    | `diet_plan` (→ day → meal → portion) | forward template ("what I _intend_ to eat")       | **live-resolved** from the pantry (per-portion override optional) |

The shared value-objects (in [`packages/shared/src/types.ts`](../packages/shared/src/types.ts)):

- **`Macros`** — `{ kcal, p, f, c, fiber? }`. The universal currency; every layer speaks it.
- **`MealItem`** (frozen, `meal_log`) vs **`Portion`** (resolvable, `diet_plan`) — both
  are `{ food, grams }` + macros, but `MealItem extends Macros` (always present, frozen)
  while a `Portion`'s macros are optional (absent → resolve live; present → override).
  Logging a planned meal (`log_planned_meal`) resolves the plan's `Portion`s against the
  pantry now and freezes them into `MealItem`s — copy semantics, not shared rows.

The **join key** across all three is the food's canonical snake_case `name`
(`pantry_item.name` ↔ `MealItem.food`). It's a soft reference by design — same reasoning
as the workout catalog ids: renaming/removing a pantry item must not orphan meal history.

### Why pantry does NOT get the same schema

`PantryItem.macros` are **per-100 g/ml** (a definition); `MealItem` macros are **absolute
for the portion eaten** (a consumption). Forcing one shape onto both collapses that
distinction, and the first reader that treats a per-100 definition as a portion total
produces silently wrong numbers. Pantry rows also carry inventory state (`quantity` on
hand, `to_buy`, `barcode`, `grams_per_serving`) that is meaningless on a meal line.

So the relationship is **reference + conversion**, not schema identity:

- pantry → portion: `buildMealItem(pantry, food, grams)`
  ([`food.ts`](../packages/shared/src/food.ts)) resolves the food and scales per-100
  macros to the portion via `macrosFor`.
- portion → pantry: the `add_food` tool promotes a logged/estimated food into the
  catalog (per-100 macros).

### Freeze vs live-resolve (the one real policy decision)

- **`meal_log` freezes macros at log time.** History must not silently change when a
  pantry item's macros are later corrected. `MealItem extends Macros` is that freeze.
- **`diet_plan` should live-resolve in the redesign.** A forward-looking template should
  reflect the _current_ pantry definition — fix a food's macros once and every planned
  meal updates. (Today's `diet_plan` inherits frozen `MealItem` macros; this is one of
  the things the reimplementation changes.)

### Contract for the `diet_plan` reimplementation

Target shape — one `Portion` type, two policies:

```ts
// One line of food, anywhere a human eats/plans it.
type Portion = {
  food: string; // canonical pantry name (soft ref — survives pantry deletes)
  grams: number; // always grams; pcs items convert via grams_per_serving
  macros?: Macros; // ABSOLUTE for this portion.
  //   meal_log:  always present (frozen at log time)
  //   diet_plan: absent → resolve live from pantry;
  //              present → explicit override / non-pantry food
  source?: "db" | "estimated" | "manual";
};
```

Resolution rule for a planned `Portion`:
`macros ?? buildMealItem(pantry, food, grams)?.macros ?? null` — and a plan item that
resolves to `null` (food no longer in pantry, no macros known) surfaces as "needs
enrichment" rather than crashing or counting as zero.

Rules of thumb:

- Logging a planned meal ("I ate what the plan said") = resolve the plan's portions
  against the pantry **now**, then write the frozen result to `meal_log`.
- Promoting an eaten meal into the plan = copy `{food, grams}` and **drop** the frozen
  macros (let the plan resolve live), unless the item was inline/estimated — then keep
  them as an override.
- Never store per-100 macros in a `Portion`, and never store portion macros on a
  `pantry_item`.

### Column layout: when does each macro get its own column?

- **`pantry_item` (definition):** one column per macro — `kcal`, `protein_g`, `fat_g`,
  `carbs_g`, `fiber_g` — already the case. **`fiber_g` must stay nullable**: `NULL` means
  "not known yet" (awaiting enrichment), `0` means "known zero." `sumMacros` preserves
  that distinction, so the UI can tell "no fiber data" from "ate zero fiber."
- **`meal_log` (today):** macros stay inside the JSONB items. The house rule (see
  schema header) is JSONB for blobs we read whole and never query into — every consumer
  loads the full day and computes in process, and per-user volume is tiny.
- **If the `diet_plan` rebuild normalizes** (plan → day → meal → portion rows, mirroring
  the workout tables), then each portion row gets real columns: `kcal`, `p`, `f`, `c`,
  `fiber` (nullable) — exactly like `workout_session_set` got `reps`/`weight_kg`/`rpe`.
  Normalize when you want per-portion edits and SQL-shaped questions ("top fiber sources
  this month", "average protein on training days"); don't put a JSONB macro blob inside
  an otherwise normalized row.

### Template vs instance vs log (the UX lifecycle)

The diet rebuild should mirror the pattern the workout tables already use
(`workout_plan` template → `workout_session` dated instance, `plan_day_id` nullable):

| Layer                                               | Keyed by                               | Mutability                                  | Macros        |
| --------------------------------------------------- | -------------------------------------- | ------------------------------------------- | ------------- |
| **Template** — `diet_plan` (→ day → meal → portion) | weekday / rotation index, **no dates** | edit freely; affects all future occurrences | live-resolved |
| **Override** (optional) — a planned one-off day     | **a specific date**                    | edit freely until eaten                     | live-resolved |
| **Log** — `meal_log`                                | a specific date                        | corrections only (`update_meal`)            | **frozen**    |

Lifecycle answers this encodes:

- **"I hit my diet today"** → copy semantics, not shared rows: resolve the template's
  portions against the pantry _now_, freeze the result into `meal_log`. Yes, the log is
  a different schema — deliberately, because history must never change when the template
  or pantry is later edited. UX: a one-tap "ate as planned" per meal (and per day) that
  does resolve-then-freeze; partially-followed days log meal-by-meal.
- **"Edit just one day, not the plan"** → never silently mutate the template. Two cases:
  - _Deviating today:_ don't edit the plan at all — just log what was actually eaten.
    The template is a default, not a contract; `meal_log` is already the per-date record.
  - _Planning a one-off in advance_ ("Friday I'm eating out, swap dinner"): a date-keyed
    **override day** that shadows the template for that date only. Day resolution becomes:
    `override(date) ?? template(weekday/index)`. When edits land on a template day, the
    UI/agent must ask the calendar question: "just this Friday, or every Friday?"
- **"Edit a portion's internals"** → argues for the normalized template (per-portion
  rows), enabling granular agent edits ("swap rice for potatoes on leg day") exactly like
  `updatePlanExercise` does for workouts — no round-tripping the whole plan.

---

## Workout tables

Normalized split: `plan → day → exercise` (the prescription) and `session → set` (what
was actually lifted). `exercise_id` / `machine_id` are **plain text references** to the
static catalog in `@fa/shared/data` — intentionally **no FK**, so catalog ids can be
renamed/removed without orphaning history, and future user-custom exercises slot in
without a schema change.

**Catalog fields (`@fa/shared/data`, not DB columns).** The exercise catalog
(`exercises.ts`, exposed via `search_exercises` and `GET /workout/catalog`) carries
per-exercise `id`, `name`, `type`, `equipment`, `primary_muscles`, `secondary_muscles`,
optional `machine_id`, `tracks`, `notes`, and an optional `metadata` object —
`{ video_url?, image_urls?[], description? }` — for reference media / how-to content
(see `ExerciseMetadata` in `workout-types.ts`). `metadata` is **defined but not yet
populated or surfaced** (reserved for a future change); don't rely on it being present.
A user's available equipment lives on `profile.gym_machine_ids` and is applied via
`search_exercises { available_only: true }`.

### `workout_plan`

One row per plan (`name`, `notes`). A user can have several. Indexed by `user_id`.
Tools: `get_workout_plans`, `save_workout_plan`, `delete_workout_plan`.

### `workout_plan_day`

One row per day in a plan. `weekdays` is a Postgres `text[]` (a day can run on Mon **and**
Thu in one row; empty = unscheduled template day). Has `name` and `focus`. Cascades from
`workout_plan`.

### `workout_plan_exercise`

The prescription: which `exercise_id` (+ optional `machine_id`), `order`, `target_sets`,
`target_reps`, `target_weight_kg`, `notes`. Cascades from `workout_plan_day`. Supports
granular agent edits ("add X to Chest Day 1", "bump the target to 70kg") without
round-tripping the whole plan.

### `workout_session`

One row per session. `date` plus an optional `plan_day_id` (`ON DELETE SET NULL` — ad-hoc
unplanned sessions are allowed; multiple per date are fine). Carries `name`,
`duration_min`, `kcal_burned`, `notes`, `started_at`. Mutable while open: the UI creates
it up front, appends sets, then patches duration/kcal on "finish". Indexed by
`(user_id, date)`.

### `workout_session_set`

One row per set: `exercise_id` (+ optional `machine_id`), `set_index` (auto-assigned
1-based per session+exercise), `reps`, `weight_kg`, `rpe`, `completed_at`. Cascades from
`workout_session`. Indexed by `(exercise_id, completed_at)` to power the per-exercise
progress / "last time you did X" / PR-detection queries.

---

## Review: cleanup candidates

A pass over what each table actually feeds, for the "is anything dead weight?" question.
**Every app table is wired into at least one feature — none is fully dead.** Notes on
what's weak or write-only:

1. **`usage_ledger` is effectively write-only.** It's written (`logUsage`) and pruned
   (`pruneUsageLedger`), but its only query method, `usageSince`, is **never called**
   anywhere in the codebase. The usage figures shown to users come straight from the
   live API response, not from this table. So today the ledger is a latent
   analytics store with no consumer.
   - **Options:** (a) keep it — it's cheap, append-only, auto-pruned, and is the only
     historical record of per-provider spend if you ever build a cost dashboard; or
     (b) drop the table + `logUsage` + `pruneUsageLedger` + `usageSince` if you've
     decided per-message cost history isn't a product direction.
   - Either way, **`usageSince` is dead code** and can be removed now.

2. **`tool_feature_request` is write-only by design.** It's an inbox triaged by hand
   in SQL. Nothing in the app ever reads or changes `status` from its default `open`.

3. **Write-only audit columns (keep).** `conversation_message.provider` / `model` are
   written but never read by the app; they exist for manual cost queries.

Everything else (`profile`, `pantry_item`, `meal_log`, `body_comp_entry`,
`conversation_message`, the four `diet_plan*` tables, and all five workout tables) is
actively read and written by shipping features.
