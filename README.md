# Frame

TEG's internal asset review platform. Forked from [pingdotgg/lawn](https://github.com/pingdotgg/lawn) (Theo's video review app) and now owned + customized in-house — no longer tracking upstream.

## What it is

A self-hosted Frame.io replacement, extended beyond video to cover every file type our teams produce: video, image, audio, PDF, project files, anything. One review surface across all TEG divisions (Films, Studios, Photobooths, FTR, Music, AV). Supports nested folders inside projects so the directory structure mirrors how editors actually organize work (`2025/Client A/Project #1/Cam1`).

## Stack

- **Frontend:** TanStack Start + React 19, Tailwind v4, brutalist design language
- **Backend:** Convex (functions + DB), TypeScript everywhere
- **Auth:** Clerk
- **Storage:** Backblaze B2 (S3-compatible) via presigned PUT + multipart for >5 GiB
- **Video transcode/playback:** Mux (gated to `assetKind === "video"`)
- **Deploy:** Vercel (project `prj_UdpPP2RzEXz7nxd4YSJzTV9SyDhk`)

## Local dev

```bash
bun install
bun dev          # vite on :5296 + convex dev in parallel
```

`.env.local` is pulled from Vercel: `vercel env pull .env.local`.

## Docs

- [Setup](docs/setup.md)
- [Deployment](docs/deployment.md)
- [Philosophy](docs/philosophy.md) — original Theo philosophy, retained
- [CLAUDE.md](CLAUDE.md) — design language for AI agents working in this repo
