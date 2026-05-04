# Convex Point-in-Time Restore — Runbook

**When this runbook applies:** Rolling back the `acrobatic-shepherd-48` Convex deployment to a snapshot timestamp earlier than now to recover asset rows that were hard-deleted via `projects.remove`.

**What restore does:** rolls back **Convex data only** (rows in tables). Code (TypeScript, components, Convex function definitions) lives in git and is unaffected.

---

## Pre-restore inventory (state captured 2026-05-04 ~01:16 CDT)

- **Git tag:** `pre-convex-restore-2026-05-04` at commit `3007af9` — every redesign + recovery commit (`9441d55..3007af9`) is here.
- **Convex parachute:** `.restore-checkpoint-2026-05-04/pre-restore-snapshot.zip` (902 KB) — full export of current prod DB. If the chosen restore timestamp turns out to be wrong, this can be re-imported via `bunx convex import --prod --table <name>` (or via the dashboard's "Restore from snapshot" button) to undo the rollback.
- **Current row counts (pre-restore):** 3,800 assets · 369 folders · 27 projects.

---

## What gets lost on restore (and how to re-apply)

Picking a restore point earlier than today wipes everything Convex did after that timestamp. The code work stays. Specifically:

| Lost on restore | Recovery path after restore |
|---|---|
| `restructureFrameio:*` consolidation (58 → 27 canonical projects) | Re-run the same script sequence from `convex/restructureFrameio.ts` |
| `activityBackfill:backfillAll` denormalization (sizeBytes + lastModifiedAt on all projects/folders/assets) | `bunx convex run --prod activityBackfill:backfillAll` |
| Any folder moves / renames done in the UI today | Manual redo |
| Today's recovery dedup work (Recovered Assets project + 50 dup rows) | Not needed — restore predates it |
| `e071f88` schema additions (denormalized fields, share scope, etc.) | Already in `convex/schema.ts` in git — redeploys automatically with `bunx convex deploy --yes` |

---

## Picking the restore timestamp

Open https://dashboard.convex.dev/d/acrobatic-shepherd-48 → Settings → Snapshot Export / History.

**Goal:** pick the latest snapshot **before** the project deletion that lost the videos. Trade-off:

- **Earlier than the deletion** → videos come back, lose later work (folder reorganization, etc.).
- **Earlier than `restructureFrameio` runs (mid-day 2026-05-04)** → also loses the 58→27 consolidation, must re-run scripts.

If you don't remember the exact deletion time, check the dashboard's audit log or pick a timestamp ~30 min before you noticed the loss.

---

## Step-by-step

### 1. Confirm code is pushed (so any redeploy after restore picks up the latest)

```bash
cd /Users/rhoni/Empire/TEG/_shared/Tools/lawn
git push origin main
git push origin pre-convex-restore-2026-05-04
```

### 2. Trigger the restore

In the Convex dashboard for `acrobatic-shepherd-48`:
- Settings → "Snapshot Restore" (or equivalent — exact UI may vary)
- Pick the chosen timestamp
- Confirm — this is irreversible without re-importing the parachute

Wait for the dashboard to report restore complete (usually < 1 minute for a DB this size).

### 3. Redeploy code so functions match the (now-rolled-back) schema

The restore rolls schema back too. Redeploy the latest code so all functions match:

```bash
cd /Users/rhoni/Empire/TEG/_shared/Tools/lawn
bunx convex deploy --yes
```

If the schema has new fields the rolled-back data doesn't, Convex will accept it (optional fields). If the rolled-back schema has fields the new code doesn't reference, that's also fine — they'll just be ignored.

### 4. Re-run the denormalization backfill

```bash
bunx convex run --prod activityBackfill:backfillAll
```

This walks every project + folder + asset and refills `sizeBytes` and `lastModifiedAt`. Idempotent — safe to run repeatedly.

### 5. Spot-check

- Open https://frame.tridenteventgroup.ca/dashboard
- Verify recovered projects show with their assets
- Click into a recovered video URL — playback should work (Mux assets aren't affected by Convex restore)
- Verify share links resolve (test one team-side, one client-side)
- Run `bunx convex run --prod migrationStatus:summary` to sanity-check totals

### 6. Re-run consolidation (only if restore predates today's `restructureFrameio` work)

If the restore point was earlier than mid-day 2026-05-04, the 27-canonical-project structure is gone. Re-run:

```bash
# These are the actions called during today's consolidation —
# inspect convex/restructureFrameio.ts for the canonical sequence.
bunx convex run --prod restructureFrameio:dryRun
# review output, then:
bunx convex run --prod restructureFrameio:execute
```

### 7. Vercel redeploy (only if needed)

The frontend on Vercel auto-deploys from `main`. No action needed unless you see a stale build — in which case:

```bash
# from lawn dir
vercel --prod --yes
```

---

## If the restore went wrong (parachute path)

If you picked the wrong timestamp and want to undo:

**Option A — re-restore via dashboard:** pick a different timestamp from the snapshot list. Convex keeps multiple history points.

**Option B — import the parachute zip:**
```bash
cd /Users/rhoni/Empire/TEG/_shared/Tools/lawn
# Use the dashboard "Restore from snapshot" UI and upload:
.restore-checkpoint-2026-05-04/pre-restore-snapshot.zip
```
This drops everything currently in prod and replaces it with the 2026-05-04 01:16 CDT state captured before any restore action.

---

## Known follow-ups (orthogonal to restore)

- **Route filename inconsistency:** `app/routes/dashboard/$teamSlug.$projectId.$videoId.tsx` — TanStack uses the filename for the URL pattern, so the URL is `/$videoId/...` even though the createFileRoute string previously said `$assetId`. To make URLs use `$assetId`, rename the file (don't just edit content). Not urgent — works fine as-is.
- **CLAUDE.md is stale:** still describes the original brutalist design language. Track A redesign deliberately moved away from that. Update next session.

---

## Quick reference

| Thing | Value |
|---|---|
| Convex deployment | `acrobatic-shepherd-48` (prod) |
| Convex dashboard | https://dashboard.convex.dev/d/acrobatic-shepherd-48 |
| Frame URL | https://frame.tridenteventgroup.ca |
| Vercel project | `lawn` under `story93` scope |
| Git tag (code snapshot) | `pre-convex-restore-2026-05-04` (commit `3007af9`) |
| Convex parachute | `.restore-checkpoint-2026-05-04/pre-restore-snapshot.zip` |
| Convex CLI gotcha | Always pass `--prod` — without it, CLI hits anonymous dev deployment |
