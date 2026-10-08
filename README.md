# Shift Bidding

A web app that runs a contact center's shift bid from start to finish. Agents rank the shifts they want, the app hands out seats by rank, and the final schedules go straight onto the workforce management timeline in [Assembled](https://www.assembled.com/). After the bid, agents trade shifts and swap rest days with each other, with admin approval. Coaches get their own bid, and each LOB's agents are shared out between its coaches by schedule overlap.

**[Try the live demo →](https://spacecarl9001.github.io/shift-bidding-demo/)**

The demo is the real app (`public/app.js`, unchanged) running on made-up people. A small stand-in backend in your browser replaces Supabase and Assembled, so you can click everything, including approving swaps and "pushing" schedules, and nothing leaves the page. Use the **Demo** button (bottom right) to sign in as an admin, a limited admin, an agent mid-bid, an agent with a published shift, or a coach. **Reset the demo data** puts it back the way it started.

## What it does

**For admins** (eight steps, one LOB at a time)
1. **Agents**: sync the roster from Assembled, import scorecard ranks from a CSV, approve schedule accommodations in tiers, and reset logins.
2. **Shift shells**: the shifts agents can bid on, with seats per shell. Import them from a CSV, group them into sets, and edit them safely when bids already exist.
3. **Bid window**: when each LOB can bid, optionally requiring a full ranking.
4. **Auto assign**: hands out seats in rank order. Manual assignments go first, then accommodation tiers, then ranks. Ties go to whoever bid first, and anyone whose picks are all taken gets a random open seat.
5. **Results**: review and export the results, then publish them. Agents see nothing until a LOB is published. After the bid, give a late joiner an open seat or move someone to one.
6. **Swaps**: approve shift trades (for good, before the push) and rest-day swaps (after the push). A swap is previewed against what is really in Assembled before it is approved. Unanswered trades are declined automatically when the trade window closes.
7. **Coaches**: Smart Scheduling picks coach schedules from the LOB's own shells to maximise the hours agents share with their coach. The coaches bid on those shifts in their own coach bid, and agents are shared out evenly by schedule overlap. Coach groups are then updated in Assembled.
8. **Apply to Assembled**: puts the final schedules on the staffing timeline, with a preview first. It skips days where someone already has PTO or training, and has an optional transition week so nobody works too many days in a row when their schedule changes.

**For agents**: rank shifts by moving them up and down, see the assigned shift and coach once results are published, and trade or swap rest days with a colleague.

**Permissions**: every admin can view every tab, but each change needs one of eight permissions (roster, shells, windows, assign, swaps, push, manual, admins). These are enforced by the database and the server, not just by greyed-out buttons.

## How it's built

- **Frontend**: plain JavaScript, HTML and CSS (`public/`), no framework or build step.
- **Backend**: [Supabase](https://supabase.com/) Postgres with row-level security on every table. Writes that must be all-or-nothing (bids, assignments, trades, swaps, open seats) are `security definer` functions that do their own checks (`supabase/`).
- **Server functions**: Node.js serverless functions on Vercel (`api/`) for everything that needs the Assembled API key: roster sync, schedule push, swap approval and coach group updates. Calls are paced to stay under Assembled's rate limit.
- **Scheduling logic** (`lib/`):
  - turning weekly shift shells into real times across time zones and daylight saving
  - planning rest-day swaps against existing events
  - planning transition weeks
  - an even split of agents between coaches using the Hungarian algorithm
  - a local search for the best coach schedules
- **Tests**: `scripts/check-*.js` run against a live Supabase project. They create throwaway users and rows, check what visitors, agents and admins can and cannot do, and clean up afterwards.

```
public/     the browser app (index.html, app.js, styles.css)
api/        serverless functions, one per file, served at /api/<name>
lib/        scheduling and coaching logic shared by the functions
supabase/   database schema, security rules and functions (SQL)
scripts/    live database checks
demo/       the browser-only demo: sample data and a stand-in backend
index.html  the demo page (GitHub Pages)
```

## Running the real app

1. Install Node.js 20.12 or newer, then run `npm install`.
2. Create a Supabase project and run the SQL files in `supabase/`, in this order:
   1. `schema.sql`
   2. `rls-policies.sql`
   3. `save-functions.sql`
   4. `swaps.sql`
   5. `shift-trades.sql`
   6. `manual-assignments.sql`
   7. `coaching.sql`
3. Copy `.env.example` to `.env.local` and fill it in. You need these values:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_KEY`
   - `ASSEMBLED_API_KEY`
   - `ADMIN_EMAILS`
4. Run `npm run dev` and open http://localhost:3000.
5. Run `npm run check:rls` (and the other `check:*` scripts) to verify the database rules.

Deploy with `npm run deploy` (Vercel). Never commit `.env.local` or any keys.

## The demo

`demo/mock.js` gives the app the same Supabase client it normally gets, with the same `from()`, `rpc()` and `auth` calls, backed by tables in `localStorage`. The database functions and API handlers it contains mirror `supabase/*.sql` and `api/*.js`, and a fake Assembled sits behind them. `demo/lib-bundle.js` is built from `lib/` by `node demo/build.js`, so the demo runs the same scheduling code as production. All names and emails in `demo/seed.js` are made up.
