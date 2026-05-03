# Frame: TEG ownership migration — scope tracker

Status as of **2026-05-03 early morning** — review-driven follow-up commit.

A first commit (`501d17e`) landed the rename + folder schema + viewer/folder primitives but a code review caught three Critical regressions and several Important issues. This commit (`HEAD`) addresses all of them. Specifically:

- `projects.ts`, `teams.ts`, `billingHelpers.ts` were still querying the legacy `videos` table — would have silently disabled plan-storage limits and returned zero counts on project/team list pages once data migrated. Fixed: all three now query `assets`.
- `<AssetViewer>`, `<FolderBreadcrumb>`, `<FolderGrid>`, `<NewFolderDialog>` existed but were never placed in routes. Fixed: AssetViewer wired into `-video.tsx`, `-watch.tsx`, `-share.tsx` with `assetKind` switching; folder UI wired into `-project.tsx` with `?folder=<id>` URL state for navigation.
- `assets.remove` was Convex-only, leaking B2 objects + Mux assets. Fixed: new `assetActions.remove` action does B2 + Mux cleanup before calling the internal `removeRow` mutation.
- `folders.ensurePath` could insert duplicate sibling folders under concurrent migration calls. Fixed: post-insert reconciliation collapses duplicates by keeping the lowest `_id`.
- lawn-migrate state files from the pre-2026-05-03 runs had `lawnVideoId` only; would have re-prepped against v2 and created duplicate assets. Fixed: `loadState` now wipes legacy `lawnVideoId` on failed/pending rows so re-runs do a clean v2 handshake.
- New `getSharedViewUrl` action lets shared non-video assets render in the iframe/viewer even when the share owner has disabled file downloads.
- Minor: dead `as unknown as never` cast removed; `foldersBackfill` parser handles trailing-slash titles; comments parent error messages distinguish "not found" / "unmigrated" / "wrong asset".

---

## ✅ Done

### Foundation
- **Repo extraction.** Standalone repo at `~/Empire/TEG/_shared/Tools/lawn/`. Empire `.gitignore` excludes the path. GitHub `rhonimohanraj/lawn` (origin); upstream `pingdotgg/lawn` dropped.
- **Rebrand.** README / CLAUDE.md / AGENTS.md / package.json now read "Frame" (TEG).

### Schema (`convex/schema.ts`)
- New `assets` table replaces `videos`. `assetKind` enum (video / image / audio / doc / other). `folderId` for nesting. Mux fields stay optional and only populate for `assetKind === "video"`. `legacyVideoId` field links migrated rows back to their `videos._id` source.
- New `folders` table (`parentFolderId` enables arbitrary nesting).
- `comments` + `shareLinks` write `assetId`. Legacy `videoId` fields kept as optional only so existing prod data continues to validate until the data migration runs.
- Old `videos` table preserved (deprecated) so the migration script can read from it.

### Server-side rename (Phase A)
- `convex/assets.ts` replaces `videos.ts` (table refs, function names, `Id<"assets">`, `requireAssetAccess`). `create()` accepts optional `folderId` + `assetKind` + `filename`; `list()` accepts `folderId` + `scope` for per-folder grids; new `moveToFolder` mutation; new `markNonVideoReady` internal mutation.
- `convex/assetActions.ts` replaces `videoActions.ts`. **Allowlist removed** — server uses `classifyAssetKind` from `assetKind.ts` and only video runs Mux. `markUploadComplete` flips non-video assets to `ready` immediately, skipping Mux ingest.
- `convex/assetPresence.ts` replaces `videoPresence.ts`.
- `convex/workspace.ts` updated to use `assetId` everywhere.
- `convex/comments.ts`, `shareLinks.ts`, `mux.ts`, `muxActions.ts` switched to `assetId` reads/writes.
- Legacy `videos.ts`, `videoActions.ts`, `videoPresence.ts` **deleted**.
- Legacy `/migration/{prepare,complete}` HTTP routes **removed**. Only `/migration/v2/*` remains.
- Legacy `requireVideoAccess` removed from `auth.ts`.

### Migration scripts (run-once, idempotent)
- `convex/assetsMigration.ts` — copies `videos` rows → `assets` rows (assetKind="video", legacyVideoId set), then rewires `comments.videoId` → `assetId` and `shareLinks.videoId` → `assetId` via the `by_legacy_video_id` index. Includes `migrationStatus` query.
- `convex/foldersBackfill.ts` — parses slash paths in titles (e.g. `"Lara & Logan/Lara & Logan Kilmury - Toasts.mp4"`) and materialises real folder hierarchies via `folders.ensurePath`. Includes `backfillStatus` query.

### Frontend (Phase B + C + D)
- `Id<"videos">` → `Id<"assets">`, `videoId` → `assetId`, `api.videos.*` → `api.assets.*`, `api.videoActions.*` → `api.assetActions.*`, `api.videoPresence.*` → `api.assetPresence.*` across every React file.
- `DropZone.tsx`, `UploadButton.tsx` drop the `accept="video/*"` filter; layout drops the `isVideoFile` filter. **Drag any file type** into Frame and it uploads.
- `useVideoUploadManager` sends `filename` to `assets.create` so the server classifier can distinguish image vs. doc when the browser sets `application/octet-stream`.
- New `src/components/asset-viewer/AssetViewer.tsx` — per-kind viewer switch:
  - `video` → caller renders existing `<VideoPlayer>` with Mux URL
  - `image` → fullscreen `<img>` with download button
  - `audio` → HTML5 `<audio controls>` with title + content type
  - `doc` (PDF) → `<iframe>` with browser-native PDF viewer
  - `other` / non-PDF doc → generic file card with download
- New `src/components/folders/`:
  - `FolderBreadcrumb.tsx` — project → … → current folder, click any segment to navigate
  - `FolderGrid.tsx` — list of subfolders with click-to-open
  - `NewFolderDialog.tsx` — modal + form, hits `folders.create`

### lawn-migrate
- `prepareMigrationAsset` / `completeMigrationAsset` clients hit `/migration/v2/*`.
- `mapToFrame` sends real `folderPath`; folders auto-created server-side.
- `classifyAssetKind` inferred locally; sent so server can skip Mux for non-video.
- "Not a video file (skipped)" branch removed — every file flows.

### Verification
- `bun typecheck` and `bunx convex typecheck` both clean.

---

## 🚀 To deploy / run in prod

1. **Push the schema first.** `bunx convex dev --once` (or merge into the auto-deploy on Vercel) deploys the new schema with both `videos` and `assets` tables. Existing prod data validates because `videos` is preserved and `comments.videoId` / `shareLinks.videoId` stay optional.
2. **Run the data migration:**
   ```bash
   # Re-run each batch until {done: true, processed: 0}.
   bunx convex run assetsMigration:migrateVideosBatch
   bunx convex run assetsMigration:rewireCommentsBatch
   bunx convex run assetsMigration:rewireShareLinksBatch
   # Verify:
   bunx convex run assetsMigration:migrationStatus
   ```
3. **Run the folder backfill:**
   ```bash
   bunx convex run foldersBackfill:backfillBatch
   bunx convex run foldersBackfill:backfillStatus
   ```
4. **Wire the new UI primitives into routes.** The `<FolderBreadcrumb>`, `<FolderGrid>`, `<NewFolderDialog>`, and `<AssetViewer>` components are built but not yet placed inside the project / asset pages — drop them into `app/routes/dashboard/-project.tsx` and the asset viewing routes when ready. Schema-side everything is wired (assets.list accepts folderId; folders.create exists).
5. **Cleanup commit (later).** Once migration is verified, drop:
   - `videos` table from `convex/schema.ts`
   - `legacyVideoId` field from `assets`
   - `videoId` fields + `by_video*` indexes on `comments` + `shareLinks`
   - `assetsMigration.ts` and the comments-fallback in `CommentItem.tsx`

---

## ⚠️  Known gotchas

- **`convex/_generated/api.d.ts` was hand-patched** to include the new modules. The next `bunx convex dev` will regenerate it cleanly — don't be surprised by a diff there.
- **`.env.local` lacks `CONVEX_DEPLOYMENT`** (Vercel doesn't store it). Run `bunx convex dev --once` once to populate.
- **The 3 timeouts from 01 Wedding Films** still need a retry pass with extended multipart timeout once the v2 endpoints are live.
- **CommentItem currently treats `assetId` as optional** to handle the ~1500 unmigrated comments in prod. Once the migration runs and we confirm zero rows still have `videoId` only, mark it required and drop the fallback.
