# Frame: TEG ownership migration — scope tracker

Status as of **2026-05-02 night**. This file is the canonical handoff for whoever (probably Claude in next session) picks up the videos→assets refactor + folder UI build.

---

## ✅ Done in 2026-05-02 session

1. **Repo extraction.** Lawn moved out of Empire submodule → standalone repo at `/Users/rhoni/Empire/TEG/_shared/Tools/lawn/` with its own `.git`. Empire `.gitignore` excludes the path. GitHub remote `rhonimohanraj/lawn` (origin) preserved; `pingdotgg/lawn` (upstream) dropped.
2. **Rebrand.** README / CLAUDE.md / AGENTS.md / package.json reflect "Frame" (TEG) instead of "lawn" (Theo). Existing in-app "Frame" branding from prior commits preserved.
3. **Schema rework** (`convex/schema.ts`):
   - New `assets` table replaces `videos`. Holds every file type. `assetKind` enum (`video`/`image`/`audio`/`doc`/`other`). `folderId` for nested-folder support. Mux fields stay optional and only populate for `assetKind === "video"`. `legacyVideoId` field links migrated rows back to their `videos._id` source.
   - New `folders` table with `parentFolderId` enables arbitrary nesting (`2025/Client A/Project #1/Cam1`).
   - `comments.assetId` and `shareLinks.assetId` added (optional). Legacy `videoId` fields kept optional during the migration window — both are valid foreign keys until the data migration runs.
   - Old `videos` table kept in schema as DEPRECATED so existing 1,500+ prod rows continue to validate.
4. **Data migration script** (`convex/assetsMigration.ts`) — idempotent `internalMutation` batches:
   - `migrateVideosBatch` copies videos → assets (assetKind="video", legacyVideoId set).
   - `rewireCommentsBatch` updates `comments.videoId` → `comments.assetId` via the `by_legacy_video_id` index.
   - `rewireShareLinksBatch` does the same for shareLinks.
   - `migrationStatus` query reports counts so you know when the migration is fully drained.
5. **Auth helpers** (`convex/auth.ts`): `requireAssetAccess` and `requireFolderAccess` added. Legacy `requireVideoAccess` kept until videos.ts is removed.
6. **Folders module** (`convex/folders.ts`): full CRUD — `create`, `rename`, `move`, `remove`, `list`, `breadcrumb`, plus `internalMutation ensurePath` used by the migration HTTP route to walk a slash-delimited path and create folders idempotently.
7. **Asset kind classifier** (`convex/assetKind.ts` + mirror in `lawn-migrate/src/lawn.ts`): content-type-first with extension fallback, returns `"video"|"image"|"audio"|"doc"|"other"`. `shouldRunMux()` predicate gates the Mux pipeline.
8. **Migration HTTP endpoints** (`convex/http.ts`):
   - **Legacy** `/migration/prepare` + `/migration/complete` → still write to `videos`. Untouched, in case of need to roll back.
   - **New** `/migration/v2/prepare` + `/migration/v2/complete` → write to `assets`. Accept optional `folderPath` (slash-delimited) and `assetKind` (otherwise inferred). For non-video kinds, the complete endpoint marks the asset `ready` immediately and skips the Mux pipeline.
9. **lawn-migrate updated** (`src/lawn.ts`, `src/migrate.ts`):
   - New `prepareMigrationAsset` / `completeMigrationAsset` clients hit the v2 endpoints.
   - `mapToFrame` replaces `mapToLawn`: sends a real `folderPath` (everything after the first level under each Frame.io project) so the folder tree mirrors the editor's directory structure.
   - **No more "Not a video file (skipped)" branch** — every file gets a real `assetKind` and is sent up.
   - Local `FileState` now tracks `lawnAssetId`, `lawnFolderId`, `assetKind`, `folderPath`. Old `lawnVideoId` field preserved read-only for backward state-file compatibility.
10. **Typecheck passes** on both repos (`bun typecheck` in Frame, `bun tsc --noEmit` in lawn-migrate).

---

## 🚧 Deferred to next session (with dev server running)

### Phase A — server cutover

1. **Run the data migration in prod Convex.**
   ```bash
   # From Frame repo, with CONVEX_DEPLOYMENT set in .env.local:
   bun dev  # leave running; convex dev will deploy new schema
   # In another terminal:
   bunx convex run assetsMigration:migrateVideosBatch
   bunx convex run assetsMigration:rewireCommentsBatch
   bunx convex run assetsMigration:rewireShareLinksBatch
   # Re-run each until {done: true, processed: 0}.
   bunx convex run assetsMigration:migrationStatus  # confirm all migrated
   ```
2. **Refactor `videos.ts` → `assets.ts`** — copy the file, rename `videos` table refs, `Id<"videos">` → `Id<"assets">`, `videoId` → `assetId`, `requireVideoAccess` → `requireAssetAccess`, function names like `getVideoForPlayback` → `getAssetForPlayback`. Add reads of legacy `videos` fall-through during the cutover *only if* prod migration hasn't finished — otherwise just hard cut.
3. **Refactor `videoActions.ts` → `assetActions.ts`** — same renames, plus:
   - Replace `ALLOWED_UPLOAD_CONTENT_TYPES` with `classifyAssetKind` from `assetKind.ts` (no allowlist; gate behavior per kind).
   - Insert `if (!shouldRunMux(assetKind)) markReady(); return;` at the right place in `markUploadComplete`.
4. **Refactor `videoPresence.ts` → `assetPresence.ts`** — straight rename.
5. **Refactor `comments.ts` + `shareLinks.ts`** — drop legacy `videoId` references (they only existed for the migration window).
6. **Remove old `videos.ts`/`videoActions.ts`/`videoPresence.ts`** files entirely.
7. **Drop `videos` table + legacy `videoId` fields** from `schema.ts`.

### Phase B — frontend cutover (15–20 React files)

Rename across `src/` and `app/`:
- `Id<"videos">` → `Id<"assets">`, `videoId` → `assetId`
- `api.videos.*` → `api.assets.*`
- Imports for `useVideoUploadManager` → `useAssetUploadManager` (rename file too)
- `DropZone.tsx`, `UploadButton.tsx`, `app/routes/dashboard/-layout.tsx`: drop `accept="video/*"` and `file.type.startsWith("video/")` filters; allow all kinds.
- Routes: `/v/{publicId}` → `/a/{publicId}` (keep `/v/` redirecting to `/a/` for share-link backward compat).

### Phase C — per-kind viewers

Currently the playback page assumes Mux video. Add a `<AssetViewer asset={asset} />` switch that renders:
- `video` → existing `<VideoPlayer>` (Mux)
- `image` → `<img src={presignedDownloadUrl}>` with zoom/pan
- `audio` → HTML5 `<audio controls>` + waveform if cheap
- `doc` (PDF) → `<iframe src={presignedDownloadUrl}>` or pdf.js
- `other` → `<GenericFileCard filename size downloadUrl>`

### Phase D — folder tree UI

- **Project page**: add a left-rail folder tree component (read `api.folders.list` recursively or build a single fetch).
- **Breadcrumbs** above the asset grid: read `api.folders.breadcrumb`.
- **"New folder" button**: opens a modal, calls `api.folders.create`.
- **Asset grid filtered by current `folderId`**: amend `api.assets.list` to accept `folderId` (default = root, i.e. `undefined`).
- **Drag-to-move** for folders + assets: phase E, optional first pass.

### Phase E — Backfill folders for existing 1,500+ migrated videos

The 2026-05-02 Frame.io → Lawn migration flattened folder paths into video titles (e.g. `"Lara & Logan/Lara & Logan Kilmury - Toasts.mp4"` is the title, not the path). Write a one-shot script to:
1. Read all assets where `assetKind === "video"` and `folderId === undefined` and `title.includes("/")`.
2. Split the title on `/`, treat the prefix as folder path, the leaf as the new title.
3. Call `folders.ensurePath` to create the hierarchy under the asset's project.
4. Patch the asset with the new `folderId` + cleaned `title`.

This converts the existing flat dump into the proper nested structure without touching any non-asset state.

---

## ⚠️  Known gotchas

- **`convex/_generated/api.d.ts` was hand-patched** to include `assetKind`, `assetsMigration`, and `folders` modules. The next `bunx convex dev` run will regenerate it cleanly — do not be surprised if git shows changes there.
- **`.env.local` was lost during submodule extraction** and re-pulled via `vercel env pull`. It now lacks `CONVEX_DEPLOYMENT` (which is a local-dev-only var, not stored on Vercel). Run `bunx convex dev --once` to set it the first time.
- **The 3 timeouts from 01 Wedding Films** (`Lara & Logan Kilmury - Toasts.mp4` 5.4 GB, `Ashley & Bevan Feature 1.0.mp4` 7.7 GB, `Annie & Colton - Camera #2.mp4` 12.2 GB) are still failed in lawn-migrate state. Once the v2 endpoints are live, retry these with extended multipart timeout — they were the only true failures from the 3,049-file run.
- **Auth boundary**: legacy `requireVideoAccess` is preserved during the migration window. Do not remove until phase A step 6 happens.
