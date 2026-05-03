"use client";

import { useEffect, useState } from "react";
import { Download, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { triggerDownload } from "@/lib/download";

/**
 * Per-kind viewer switch. The Mux/HLS video player is delegated to
 * VideoPlayer (existing). Image / audio / doc / other render here.
 *
 * Every non-video kind streams from a presigned B2 download URL provided
 * by getDownloadUrl (server-side action). This component is intentionally
 * dumb — the parent passes the URL it already fetched.
 */

interface AssetViewerProps {
  assetKind: "video" | "image" | "audio" | "doc" | "other";
  title: string;
  contentType?: string;
  fileSize?: number;
  /**
   * Presigned download URL from B2. For video assets this is unused
   * (caller renders VideoPlayer with Mux playback URL instead).
   */
  downloadUrl?: string;
  /** When true, hide the download button (e.g. when share link disallows). */
  disallowDownload?: boolean;
}

function formatBytes(bytes?: number): string {
  if (!bytes || !Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

function DownloadButton({ url, filename, disabled }: { url: string; filename: string; disabled?: boolean }) {
  if (disabled) return null;
  return (
    <Button
      variant="default"
      onClick={() => triggerDownload(url, filename)}
      className="gap-2"
    >
      <Download className="h-4 w-4" />
      Download
    </Button>
  );
}

function ImageViewer({ url, title, disallowDownload }: { url: string; title: string; disallowDownload?: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 p-8 bg-[#1a1a1a]">
      <img
        src={url}
        alt={title}
        className="max-w-full max-h-[80vh] object-contain border-2 border-[#1a1a1a] bg-[#f0f0e8]"
      />
      <DownloadButton url={url} filename={title} disabled={disallowDownload} />
    </div>
  );
}

function AudioViewer({ url, title, contentType, disallowDownload }: { url: string; title: string; contentType?: string; disallowDownload?: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-6 p-12 bg-[#f0f0e8] border-2 border-[#1a1a1a]">
      <div className="text-center">
        <h2 className="text-2xl font-black tracking-tight text-[#1a1a1a]">{title}</h2>
        <p className="text-sm font-mono text-[#888] mt-1">{contentType ?? "audio"}</p>
      </div>
      <audio
        src={url}
        controls
        className="w-full max-w-2xl"
      />
      <DownloadButton url={url} filename={title} disabled={disallowDownload} />
    </div>
  );
}

function PDFViewer({ url, title, disallowDownload }: { url: string; title: string; disallowDownload?: boolean }) {
  return (
    <div className="flex flex-col gap-4 bg-[#1a1a1a]">
      <iframe
        src={url}
        title={title}
        className="w-full h-[85vh] border-2 border-[#1a1a1a] bg-[#f0f0e8]"
      />
      <div className="flex justify-center pb-4">
        <DownloadButton url={url} filename={title} disabled={disallowDownload} />
      </div>
    </div>
  );
}

function GenericFileCard({
  url,
  title,
  contentType,
  fileSize,
  disallowDownload,
}: {
  url: string;
  title: string;
  contentType?: string;
  fileSize?: number;
  disallowDownload?: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-6 p-16 bg-[#f0f0e8] border-2 border-[#1a1a1a] min-h-[60vh]">
      <FileText className="h-24 w-24 text-[#1a1a1a]" strokeWidth={1.5} />
      <div className="text-center">
        <h2 className="text-3xl font-black tracking-tight text-[#1a1a1a]">{title}</h2>
        <p className="text-sm font-mono text-[#888] mt-2">
          {contentType ?? "unknown"} · {formatBytes(fileSize)}
        </p>
      </div>
      <p className="text-sm text-[#888] text-center max-w-md">
        This file type can&apos;t be previewed inline. Download to open it
        with the right application.
      </p>
      <DownloadButton url={url} filename={title} disabled={disallowDownload} />
    </div>
  );
}

export function AssetViewer({
  assetKind,
  title,
  contentType,
  fileSize,
  downloadUrl,
  disallowDownload,
}: AssetViewerProps) {
  if (assetKind === "video") {
    // Caller renders <VideoPlayer src={muxPlaybackUrl} /> directly.
    return null;
  }

  if (!downloadUrl) {
    return (
      <div className="flex items-center justify-center min-h-[40vh] text-[#888]">
        Loading preview…
      </div>
    );
  }

  switch (assetKind) {
    case "image":
      return <ImageViewer url={downloadUrl} title={title} disallowDownload={disallowDownload} />;
    case "audio":
      return <AudioViewer url={downloadUrl} title={title} contentType={contentType} disallowDownload={disallowDownload} />;
    case "doc":
      // Browser-native PDF viewer for PDFs; fallback for other doc kinds.
      if (contentType === "application/pdf" || title.toLowerCase().endsWith(".pdf")) {
        return <PDFViewer url={downloadUrl} title={title} disallowDownload={disallowDownload} />;
      }
      return <GenericFileCard url={downloadUrl} title={title} contentType={contentType} fileSize={fileSize} disallowDownload={disallowDownload} />;
    case "other":
    default:
      return <GenericFileCard url={downloadUrl} title={title} contentType={contentType} fileSize={fileSize} disallowDownload={disallowDownload} />;
  }
}
