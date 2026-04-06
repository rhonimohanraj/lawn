import { useAction, useMutation } from "convex/react";
import { useCallback, useState } from "react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import type { UploadStatus } from "@/components/upload/UploadProgress";

const PART_UPLOAD_CONCURRENCY = 4;
const PART_URL_BATCH_SIZE = 16;

interface MultipartUploadPart {
  partNumber: number;
  start: number;
  end: number;
  size: number;
}

export interface ManagedUploadItem {
  id: string;
  projectId: Id<"projects">;
  file: File;
  videoId?: Id<"videos">;
  progress: number;
  status: UploadStatus;
  error?: string;
  bytesPerSecond?: number;
  estimatedSecondsRemaining?: number | null;
  abortController?: AbortController;
}

function createUploadId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

function createMultipartParts(file: File, partSizeBytes: number) {
  const parts: MultipartUploadPart[] = [];

  for (let start = 0, partNumber = 1; start < file.size; start += partSizeBytes, partNumber += 1) {
    const end = Math.min(start + partSizeBytes, file.size);
    parts.push({
      partNumber,
      start,
      end,
      size: end - start,
    });
  }

  return parts;
}

function uploadBlobPartToUrl(args: {
  url: string;
  blob: Blob;
  abortSignal: AbortSignal;
  onProgress: (loadedBytes: number) => void;
}) {
  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    const cleanup = () => {
      args.abortSignal.removeEventListener("abort", handleAbort);
    };

    const handleAbort = () => {
      xhr.abort();
    };

    xhr.upload.addEventListener("progress", (event) => {
      const loadedBytes = event.lengthComputable ? event.loaded : 0;
      args.onProgress(Math.min(args.blob.size, loadedBytes));
    });

    xhr.addEventListener("load", () => {
      cleanup();
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`Upload failed: ${xhr.status} ${xhr.statusText}`));
        return;
      }

      const etag = xhr.getResponseHeader("ETag") ?? xhr.getResponseHeader("etag");
      if (!etag) {
        reject(new Error("Upload failed: Missing ETag from storage provider"));
        return;
      }

      args.onProgress(args.blob.size);
      resolve(etag);
    });

    xhr.addEventListener("error", () => {
      cleanup();
      reject(new Error("Upload failed: Network error"));
    });

    xhr.addEventListener("abort", () => {
      cleanup();
      reject(new Error("Upload cancelled"));
    });

    args.abortSignal.addEventListener("abort", handleAbort, { once: true });

    xhr.open("PUT", args.url);
    xhr.send(args.blob);
  });
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
) {
  let nextIndex = 0;
  let firstError: unknown;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      if (firstError) {
        return;
      }

      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      try {
        await worker(items[currentIndex]);
      } catch (error) {
        firstError = error;
        throw error;
      }
    }
  });

  await Promise.all(runners);
}

export function useVideoUploadManager() {
  const createVideo = useMutation(api.videos.create);
  const createMultipartUpload = useAction(api.videoActions.createMultipartUpload);
  const getMultipartUploadPartUrls = useAction(
    api.videoActions.getMultipartUploadPartUrls,
  );
  const completeMultipartUpload = useAction(
    api.videoActions.completeMultipartUpload,
  );
  const abortMultipartUpload = useAction(api.videoActions.abortMultipartUpload);
  const markUploadComplete = useAction(api.videoActions.markUploadComplete);
  const markUploadFailed = useAction(api.videoActions.markUploadFailed);
  const [uploads, setUploads] = useState<ManagedUploadItem[]>([]);

  const uploadFilesToProject = useCallback(
    async (projectId: Id<"projects">, files: File[]) => {
      for (const file of files) {
        const uploadId = createUploadId();
        const title = file.name.replace(/\.[^/.]+$/, "");
        const abortController = new AbortController();

        setUploads((prev) => [
          ...prev,
          {
            id: uploadId,
            projectId,
            file,
            progress: 0,
            status: "pending",
            abortController,
          },
        ]);

        let createdVideoId: Id<"videos"> | undefined;
        let multipartKey: string | undefined;
        let multipartUploadId: string | undefined;
        let hasCompletedMultipartUpload = false;

        try {
          createdVideoId = await createVideo({
            projectId,
            title,
            fileSize: file.size,
            contentType: file.type || "video/mp4",
          });

          setUploads((prev) =>
            prev.map((upload) =>
              upload.id === uploadId
                ? { ...upload, videoId: createdVideoId, status: "uploading" }
                : upload,
            ),
          );

          const multipartUpload = await createMultipartUpload({
            videoId: createdVideoId,
            filename: file.name,
            fileSize: file.size,
            contentType: file.type || "video/mp4",
          });

          multipartKey = multipartUpload.key;
          multipartUploadId = multipartUpload.multipartUploadId;

          const parts = createMultipartParts(file, multipartUpload.partSizeBytes);
          if (parts.length !== multipartUpload.totalParts) {
            throw new Error("Multipart upload was initialized with an invalid part count.");
          }

          let uploadedBytes = 0;
          let lastMeasuredBytes = 0;
          let lastMeasuredAt = Date.now();
          const recentSpeeds: number[] = [];
          const uploadedBytesByPart = new Map<number, number>();
          const completedParts: Array<{ partNumber: number; etag: string }> = [];
          const partUrlBatchCache = new Map<number, Promise<Map<number, string>>>();

          const updateUploadMetrics = () => {
            const progress = Math.min(100, Math.round((uploadedBytes / file.size) * 100));
            const now = Date.now();
            const elapsedSeconds = (now - lastMeasuredAt) / 1000;

            if (elapsedSeconds > 0.1) {
              const speed = (uploadedBytes - lastMeasuredBytes) / elapsedSeconds;
              recentSpeeds.push(speed);
              if (recentSpeeds.length > 5) {
                recentSpeeds.shift();
              }
              lastMeasuredAt = now;
              lastMeasuredBytes = uploadedBytes;
            }

            const averageBytesPerSecond =
              recentSpeeds.length > 0
                ? recentSpeeds.reduce((sum, speed) => sum + speed, 0) / recentSpeeds.length
                : 0;
            const remainingBytes = Math.max(0, file.size - uploadedBytes);
            const estimatedSecondsRemaining =
              averageBytesPerSecond > 0
                ? Math.ceil(remainingBytes / averageBytesPerSecond)
                : null;

            setUploads((prev) =>
              prev.map((upload) =>
                upload.id === uploadId
                  ? {
                      ...upload,
                      progress,
                      bytesPerSecond: averageBytesPerSecond,
                      estimatedSecondsRemaining,
                    }
                  : upload,
              ),
            );
          };

          const setUploadedBytesForPart = (part: MultipartUploadPart, nextLoadedBytes: number) => {
            const safeLoadedBytes = Math.max(0, Math.min(part.size, nextLoadedBytes));
            const previousLoadedBytes = uploadedBytesByPart.get(part.partNumber) ?? 0;
            uploadedBytesByPart.set(part.partNumber, safeLoadedBytes);
            uploadedBytes += safeLoadedBytes - previousLoadedBytes;
            updateUploadMetrics();
          };

          const getPartUploadUrl = async (partNumber: number) => {
            const batchIndex = Math.floor((partNumber - 1) / PART_URL_BATCH_SIZE);
            let batchPromise = partUrlBatchCache.get(batchIndex);

            if (!batchPromise) {
              const batchStartPartNumber = batchIndex * PART_URL_BATCH_SIZE + 1;
              const batchPartNumbers = Array.from(
                { length: Math.min(PART_URL_BATCH_SIZE, multipartUpload.totalParts - batchStartPartNumber + 1) },
                (_, index) => batchStartPartNumber + index,
              );

              batchPromise = getMultipartUploadPartUrls({
                videoId: createdVideoId,
                key: multipartUpload.key,
                multipartUploadId: multipartUpload.multipartUploadId,
                partNumbers: batchPartNumbers,
              }).then((result) => new Map(result.parts.map((part) => [part.partNumber, part.url])));
              partUrlBatchCache.set(batchIndex, batchPromise);
            }

            const batchUrls = await batchPromise;
            const url = batchUrls.get(partNumber);
            if (!url) {
              throw new Error(`Missing upload URL for multipart upload part ${partNumber}.`);
            }
            return url;
          };

          await runWithConcurrency(parts, PART_UPLOAD_CONCURRENCY, async (part) => {
            if (abortController.signal.aborted) {
              throw new Error("Upload cancelled");
            }

            const url = await getPartUploadUrl(part.partNumber);
            const etag = await uploadBlobPartToUrl({
              url,
              blob: file.slice(part.start, part.end),
              abortSignal: abortController.signal,
              onProgress: (loadedBytes) => {
                setUploadedBytesForPart(part, loadedBytes);
              },
            });

            completedParts.push({
              partNumber: part.partNumber,
              etag,
            });
          });

          await completeMultipartUpload({
            videoId: createdVideoId,
            key: multipartUpload.key,
            multipartUploadId: multipartUpload.multipartUploadId,
            parts: completedParts.sort((a, b) => a.partNumber - b.partNumber),
          });
          hasCompletedMultipartUpload = true;

          setUploads((prev) =>
            prev.map((upload) =>
              upload.id === uploadId
                ? {
                    ...upload,
                    progress: 100,
                    status: "processing",
                    bytesPerSecond: 0,
                    estimatedSecondsRemaining: null,
                  }
                : upload,
            ),
          );

          await markUploadComplete({ videoId: createdVideoId });

          setUploads((prev) =>
            prev.map((upload) =>
              upload.id === uploadId
                ? { ...upload, status: "complete", progress: 100 }
                : upload,
            ),
          );

          setTimeout(() => {
            setUploads((prev) => prev.filter((upload) => upload.id !== uploadId));
          }, 3000);
        } catch (error) {
          if (
            createdVideoId &&
            multipartKey &&
            multipartUploadId &&
            !hasCompletedMultipartUpload
          ) {
            if (!abortController.signal.aborted) {
              abortController.abort();
            }

            abortMultipartUpload({
              videoId: createdVideoId,
              key: multipartKey,
              multipartUploadId,
            }).catch(console.error);
          }

          const errorMessage = error instanceof Error ? error.message : "Upload failed";

          setUploads((prev) =>
            prev.map((upload) =>
              upload.id === uploadId
                ? { ...upload, status: "error", error: errorMessage }
                : upload,
            ),
          );

          if (createdVideoId) {
            markUploadFailed({ videoId: createdVideoId }).catch(console.error);
          }
        }
      }
    },
    [
      abortMultipartUpload,
      completeMultipartUpload,
      createMultipartUpload,
      createVideo,
      getMultipartUploadPartUrls,
      markUploadComplete,
      markUploadFailed,
    ],
  );

  const cancelUpload = useCallback(
    (uploadId: string) => {
      const upload = uploads.find((item) => item.id === uploadId);
      if (upload?.abortController) {
        upload.abortController.abort();
      }
      if (upload?.videoId) {
        markUploadFailed({ videoId: upload.videoId }).catch(console.error);
      }
      setUploads((prev) => prev.filter((item) => item.id !== uploadId));
    },
    [uploads, markUploadFailed],
  );

  return {
    uploads,
    uploadFilesToProject,
    cancelUpload,
  };
}
