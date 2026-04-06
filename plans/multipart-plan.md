# Multipart Upload + Plan-Aware Limits Stack

## Status

- [x] Stack 1 — Base PR: multipart upload foundation
- [ ] Stack 2 — Follow-up PR: plan-aware limits + better upload errors
- [ ] Stack 3 — Final PR: copy and UI updates

## Objective

Roll out larger uploads in the correct order:

1. **quietly add multipart upload support first** so the app can actually handle files above the current single-request ceiling
2. **layer plan-aware validation and better error messages on top** once the transport is capable
3. **finish with copy/UI updates** so the product accurately communicates the new limits

This sequencing avoids promising 10GB / 50GB uploads before the upload pipeline can really support them.

---

## Why this order

The current upload flow uses a single presigned S3 `PUT` from the browser:

- `convex/videoActions.ts` issues one upload URL
- `app/routes/dashboard/-useVideoUploadManager.ts` uploads the whole file with one `XMLHttpRequest`
- `convex/videoActions.ts` currently enforces a hard cap of `5 * GIBIBYTE`

That means the app cannot truthfully support 10GB or 50GB uploads until the transport changes to multipart upload.

So the stack should be:

1. **Capability first** — multipart upload foundation
2. **Correctness second** — plan-aware size limits + better error messages
3. **Communication last** — pricing/settings/home/upload copy updates

---

## Stack 1 — Base PR: multipart upload foundation

**Status:** Implemented on the branch.

### Landed changes

- Replaced the dashboard uploader's single-request direct upload flow with S3 multipart upload.
- Added multipart Convex actions in `convex/videoActions.ts`:
  - `createMultipartUpload`
  - `getMultipartUploadPartUrls`
  - `completeMultipartUpload`
  - `abortMultipartUpload`
- Updated `app/routes/dashboard/-useVideoUploadManager.ts` to:
  - split files into parts
  - upload parts with bounded parallelism
  - batch presigned part URL requests
  - aggregate progress and ETA across multipart uploads
  - abort in-flight uploads and clean up multipart sessions on failure/cancel
- Removed the old 5 GiB direct-upload bottleneck from the main upload path and from post-upload verification.
- Kept the existing `markUploadComplete` handoff into S3 verification and Mux ingest.

## Goal

Replace the current single-request direct upload flow with S3 multipart upload so files larger than 5 GiB are technically possible.

This PR should be mostly infrastructural and intentionally light on visible product changes.

## Scope

### Backend

Primary file:
- `convex/videoActions.ts`

Add multipart actions for the upload lifecycle:

1. `createMultipartUpload`
   - verify member access to the video/project
   - create the S3 multipart upload
   - return enough metadata for the client to upload parts
   - persist upload metadata if needed for cleanup/completion

2. `getMultipartUploadPartUrl`
   - presign an `UploadPart` request for a specific part number
   - validate the caller can continue the upload

3. `completeMultipartUpload`
   - accept uploaded part metadata from the client
   - complete the multipart upload in S3
   - return success metadata to the client

4. `abortMultipartUpload`
   - allow cancellation and cleanup of incomplete multipart uploads
   - should be safe to call on cancellation/error paths

Keep existing post-upload processing logic:
- `markUploadComplete` should remain the handoff into:
  - object existence verification
  - metadata reconciliation
  - transition to `processing`
  - Mux ingest kickoff

### Frontend

Primary file:
- `app/routes/dashboard/-useVideoUploadManager.ts`

Replace the single XHR `PUT` flow with multipart upload logic:

1. split each file into chunks
2. request part URLs from the backend
3. upload parts directly to S3
4. collect `ETag` values per part
5. complete the multipart upload
6. call `markUploadComplete`

### Upload behavior requirements

- preserve current upload tray UX
- preserve cancellation support
- preserve progress percentages and ETA
- support aggregate progress across parts
- use limited parallelism for performance
- avoid obvious waterfalls where possible

### Suggested implementation details

- chunk size: something in the ~8–16 MiB range
- concurrency: small fixed parallelism, e.g. 3–5 parts at a time
- retries: optional for this base PR, but at least structure the code so retries can be added without rewriting the uploader
- cancellation:
  - abort in-flight browser requests
  - call `abortMultipartUpload`
  - mark the upload failed/cleaned up consistently

## Non-goals for this PR

- no new pricing or marketing copy
- no new user-facing plan messaging
- no visible 10GB / 50GB promise yet
- no attempt to perfect all upload error copy yet

## Acceptance criteria

1. uploads no longer depend on a single presigned `PUT`
2. the old 5 GiB direct-upload bottleneck is removed from the main upload path
3. upload progress and cancellation still work in the dashboard upload tray
4. completed uploads still flow into the existing S3 verification + Mux ingestion path
5. small uploads continue to work reliably with no UX regression

## Likely files touched

- `convex/videoActions.ts`
- `app/routes/dashboard/-useVideoUploadManager.ts`
- possibly `convex/videos.ts` if extra upload metadata needs to be stored
- possibly `convex/schema.ts` if multipart state must be persisted

---

## Stack 2 — Follow-up PR: plan-aware limits + better upload errors

## Goal

Now that multipart exists, enforce the requested per-plan file-size limits and return much better upload errors for the two important failure classes:

1. **file too large for the plan**
2. **file would push the team over its storage allowance**

## Requested product behavior

- Basic plan: **max file size 10GB**
- Pro plan: **max file size 50GB**

This PR should make those limits real in application logic.

## Scope

### Billing/domain constants

Primary file:
- `convex/billingHelpers.ts`

Add a new source of truth for per-file upload limits:

- `TEAM_PLAN_MAX_FILE_SIZE_BYTES`
  - `basic: 10 * GIBIBYTE`
  - `pro: 50 * GIBIBYTE`

Keep existing storage limits as separate concerns:
- `TEAM_PLAN_STORAGE_LIMIT_BYTES`
  - basic storage remains 100GB
  - pro storage remains 1TB

Consider adding small shared helpers for:
- formatting bytes into readable GB/TB strings
- formatting plan labels consistently

### Plan-aware file size validation

Primary file:
- `convex/videos.ts`

In `create(...)`:
- validate the incoming file size against the team’s plan-specific max file size before upload begins
- continue to validate storage availability with `assertTeamCanStoreBytes(...)`
- fail early so the user doesn’t start a huge upload only to be rejected later

### Final backend sanity check after upload

Primary file:
- `convex/videoActions.ts`

In the post-upload verification path:
- verify the uploaded object actually exists
- verify the final object size is valid
- verify the uploaded object is still within the team’s per-file plan limit
- keep content-type validation in place

This ensures the client is not the only layer enforcing limits.

### Better storage-limit errors

Primary file:
- `convex/billingHelpers.ts`

Improve `assertTeamCanStoreBytes(...)` to produce richer, actionable messages.

Instead of a generic message like:
- `Storage limit reached for the basic plan. Upgrade to continue uploading.`

Prefer messages that include:
- plan name
- current storage usage
- storage limit
- incoming file size
- recommended action

Example target:
- `This upload would exceed your team's Basic plan storage limit. You're using 96 GB of 100 GB, and this file is 8 GB. Upgrade to Pro or delete old videos to free up space.`

### Better “file too large” errors

Return plan-aware messages for file size failures.

Example targets:

Basic:
- `This file is too large for the Basic plan. Basic supports files up to 10 GB. Upgrade to Pro for files up to 50 GB.`

Pro:
- `This file is too large for the Pro plan. Pro supports files up to 50 GB.`

### Frontend error handling

Primary file:
- `app/routes/dashboard/-useVideoUploadManager.ts`

Improve the upload manager so upload tray errors are clearer and less raw.

Potential improvements:
- normalize backend errors into cleaner display text when needed
- optionally add client-side prechecks before starting multipart upload for instant feedback
- keep inline upload errors attached to the relevant upload item

Client-side prechecks are useful for convenience, but backend validation remains the source of truth.

## Acceptance criteria

1. Basic users cannot upload files over 10GB
2. Pro users cannot upload files over 50GB
3. users get a clearly different error for:
   - per-file plan max violation
   - total storage limit violation
4. post-upload verification still rejects invalid uploads even if the client misbehaves
5. upload tray surfaces actionable errors instead of generic failures

## Likely files touched

- `convex/billingHelpers.ts`
- `convex/videos.ts`
- `convex/videoActions.ts`
- `app/routes/dashboard/-useVideoUploadManager.ts`
- maybe `src/components/upload/UploadProgress.tsx` if tiny copy polish is needed

---

## Stack 3 — Final PR: copy and UI updates

## Goal

Update visible plan copy so the product accurately communicates the new per-file upload limits and aligns with the backend behavior.

This PR should mostly be presentation and messaging.

## Scope

### Billing/settings UI

Primary file:
- `app/routes/dashboard/-settings.tsx`

Update plan cards/details to show both:
- storage included
- max file size per plan

Target messaging:
- Basic: `100GB storage` + `Max file size 10GB`
- Pro: `1TB storage` + `Max file size 50GB`

### Pricing page

Primary file:
- `app/routes/-pricing.tsx`

Update pricing cards to include the new per-file max.

### Homepage pricing section

Primary file:
- `app/routes/-home.tsx`

Update the homepage pricing cards / structured copy so it also reflects the new file-size limits.

### Optional upload entry-point hints

Possible file:
- `src/components/upload/DropZone.tsx`

Optional lightweight UX improvement:
- show supported formats more explicitly
- optionally mention that max file size depends on plan, or show the concrete limit if team billing context is available

This should stay small and not create extra complexity unless the data is already easy to access.

## Acceptance criteria

1. settings/billing UI reflects the new per-file limits
2. pricing page reflects the new per-file limits
3. homepage pricing copy reflects the new per-file limits
4. no visible copy conflicts remain between product marketing and actual app behavior

## Likely files touched

- `app/routes/dashboard/-settings.tsx`
- `app/routes/-pricing.tsx`
- `app/routes/-home.tsx`
- optionally `src/components/upload/DropZone.tsx`

---

## Cross-stack notes

## Data and terminology

The codebase currently uses binary units:
- `GIBIBYTE = 1024 ** 3`
- `TEBIBYTE = 1024 ** 4`

UI may still say `GB` / `TB` for simplicity, but implementation should remain internally consistent.

## Important separation of concerns

There are now two different kinds of size limits:

1. **Per-file limit**
   - Basic: 10GB
   - Pro: 50GB

2. **Total team storage limit**
   - Basic: 100GB
   - Pro: 1TB

Error messages and UI copy should make these feel clearly different.

## Rollout recommendation

1. land **Stack 1** first with minimal product noise
2. stack **Stack 2** on top so the new capability is enforced correctly
3. stack **Stack 3** last so public and in-app copy only changes once the system is truly ready

## Success criteria for the full stack

1. uploads above 5 GiB are technically supported by the transport layer
2. Basic can upload up to 10GB files
3. Pro can upload up to 50GB files
4. users get clear, actionable upload errors
5. billing/pricing/home surfaces all reflect the same limits
6. upload UX remains fast and cancelable with no major regression
