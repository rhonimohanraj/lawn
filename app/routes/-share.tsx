import { useAction, useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Link, useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useUser } from "@clerk/tanstack-react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VideoPlayer, type VideoPlayerHandle } from "@/components/video-player/VideoPlayer";
import { AssetViewer } from "@/components/asset-viewer/AssetViewer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { triggerDownload } from "@/lib/download";
import { formatDuration, formatTimestamp, formatRelativeTime } from "@/lib/utils";
import { useVideoPresence } from "@/lib/useVideoPresence";
import { VideoWatchers } from "@/components/presence/VideoWatchers";
import { ShareBrowser } from "@/components/share/ShareBrowser";
import {
  ArrowLeft,
  Lock,
  Video,
  AlertCircle,
  MessageSquare,
  Clock,
  Download,
} from "lucide-react";
import type { Id } from "@convex/_generated/dataModel";
import { useShareData } from "./-share.data";

export default function SharePage() {
  const params = useParams({ strict: false });
  const token = params.token as string;
  const { user, isLoaded: isUserLoaded } = useUser();
  const navigate = useNavigate({});
  const pathname = useLocation().pathname;
  const searchStr = useLocation().search;

  // Folder/project shares are browseable. Track which folder + asset the
  // client is viewing via URL search params so refreshes preserve location.
  const { browseFolderId, selectedAssetId } = useMemo(() => {
    const sp = new URLSearchParams(searchStr);
    const f = sp.get("folder");
    const a = sp.get("asset");
    return {
      browseFolderId: (f ? (f as Id<"folders">) : null) as Id<"folders"> | null,
      selectedAssetId: (a ? (a as Id<"assets">) : null) as Id<"assets"> | null,
    };
  }, [searchStr]);

  const setSearchParams = useCallback(
    (next: { folder?: Id<"folders"> | null; asset?: Id<"assets"> | null }) => {
      const sp = new URLSearchParams(searchStr);
      if (next.folder === null) sp.delete("folder");
      else if (next.folder !== undefined) sp.set("folder", next.folder);
      if (next.asset === null) sp.delete("asset");
      else if (next.asset !== undefined) sp.set("asset", next.asset);
      const qs = sp.toString();
      navigate({ to: pathname + (qs ? `?${qs}` : ""), replace: false });
    },
    [navigate, pathname, searchStr],
  );

  const openFolder = useCallback(
    (folderId: Id<"folders">) =>
      setSearchParams({ folder: folderId, asset: null }),
    [setSearchParams],
  );
  const openAsset = useCallback(
    (assetId: Id<"assets">) => setSearchParams({ asset: assetId }),
    [setSearchParams],
  );
  const navigateHome = useCallback(
    () => setSearchParams({ folder: null, asset: null }),
    [setSearchParams],
  );
  const backToBrowser = useCallback(
    () => setSearchParams({ asset: null }),
    [setSearchParams],
  );

  const issueAccessGrant = useMutation(api.shareLinks.issueAccessGrant);
  const createComment = useMutation(api.comments.createForShareGrant);
  const getPlaybackSession = useAction(api.assetActions.getSharedPlaybackSession);
  const getDownloadUrl = useAction(api.assetActions.getSharedDownloadUrl);
  const getViewUrl = useAction(api.assetActions.getSharedViewUrl);

  const [grantToken, setGrantToken] = useState<string | null>(null);
  const [hasAttemptedAutoGrant, setHasAttemptedAutoGrant] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  const [passwordError, setPasswordError] = useState(false);
  const [isRequestingGrant, setIsRequestingGrant] = useState(false);
  const [playbackSession, setPlaybackSession] = useState<{
    url: string;
    posterUrl: string;
  } | null>(null);
  const [isLoadingPlayback, setIsLoadingPlayback] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [commentText, setCommentText] = useState("");
  const [isSubmittingComment, setIsSubmittingComment] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [guestName, setGuestName] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem("lawn:guestName");
    if (stored) setGuestName(stored);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (guestName.trim()) {
      window.localStorage.setItem("lawn:guestName", guestName.trim());
    }
  }, [guestName]);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const playerRef = useRef<VideoPlayerHandle | null>(null);

  useEffect(() => {
    setIsDownloading(false);
    setDownloadError(null);
  }, [token]);

  const { shareInfo, grantContext, browse, videoData, comments } = useShareData({
    token,
    grantToken,
    parentFolderId: browseFolderId,
    selectedAssetId,
  });
  const isMultiAssetShare =
    shareInfo?.scope === "folder" || shareInfo?.scope === "project";
  const isViewingAsset =
    shareInfo?.scope === "asset" || Boolean(selectedAssetId);
  const canTrackPresence = Boolean(playbackSession?.url && videoData?.asset?._id);
  const { watchers } = useVideoPresence({
    assetId: videoData?.asset?._id,
    enabled: canTrackPresence,
    shareToken: token,
  });

  const [sharedDownloadUrl, setSharedDownloadUrl] = useState<string | null>(null);
  const isNonVideoAsset = Boolean(
    videoData?.asset?.assetKind && videoData.asset.assetKind !== "video",
  );
  useEffect(() => {
    if (!isNonVideoAsset || !grantToken) {
      setSharedDownloadUrl(null);
      return;
    }
    let cancelled = false;
    void getViewUrl({
      grantToken,
      assetId: selectedAssetId ?? undefined,
    })
      .then((res) => {
        if (cancelled) return;
        setSharedDownloadUrl(res.url);
      })
      .catch(() => {
        if (cancelled) return;
        setSharedDownloadUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [getViewUrl, grantToken, isNonVideoAsset, selectedAssetId]);

  useEffect(() => {
    setGrantToken(null);
    setHasAttemptedAutoGrant(false);
  }, [token]);

  const acquireGrant = useCallback(
    async (password?: string) => {
      if (isRequestingGrant) return;
      setIsRequestingGrant(true);
      setPasswordError(false);

      try {
        const result = await issueAccessGrant({ token, password });
        if (result.ok && result.grantToken) {
          setGrantToken(result.grantToken);
          return true;
        }

        setPasswordError(Boolean(password));
        return false;
      } catch {
        setPasswordError(Boolean(password));
        return false;
      } finally {
        setIsRequestingGrant(false);
      }
    },
    [isRequestingGrant, issueAccessGrant, token],
  );

  useEffect(() => {
    if (!shareInfo || grantToken) return;
    if (shareInfo.status !== "ok" || hasAttemptedAutoGrant) return;

    setHasAttemptedAutoGrant(true);
    void acquireGrant();
  }, [acquireGrant, grantToken, hasAttemptedAutoGrant, shareInfo]);

  useEffect(() => {
    // For folder/project shares, only load playback once the client has
    // drilled into a specific asset. Without this gate, the action call
    // would 4xx on the browser screen.
    if (!grantToken || !isViewingAsset) {
      setPlaybackSession(null);
      setPlaybackError(null);
      return;
    }

    let cancelled = false;
    setIsLoadingPlayback(true);
    setPlaybackError(null);

    void getPlaybackSession({
      grantToken,
      assetId: selectedAssetId ?? undefined,
    })
      .then((session) => {
        if (cancelled) return;
        setPlaybackSession(session);
      })
      .catch(() => {
        if (cancelled) return;
        setPlaybackError("Unable to load playback session.");
      })
      .finally(() => {
        if (cancelled) return;
        setIsLoadingPlayback(false);
      });

    return () => {
      cancelled = true;
    };
  }, [getPlaybackSession, grantToken, selectedAssetId, isViewingAsset]);

  const flattenedComments = useMemo(() => {
    if (!comments) return [] as Array<{ _id: string; timestampSeconds: number; resolved: boolean }>;

    const markers: Array<{ _id: string; timestampSeconds: number; resolved: boolean }> = [];
    for (const comment of comments) {
      markers.push({
        _id: comment._id,
        timestampSeconds: comment.timestampSeconds,
        resolved: comment.resolved,
      });
      for (const reply of comment.replies) {
        markers.push({
          _id: reply._id,
          timestampSeconds: reply.timestampSeconds,
          resolved: reply.resolved,
        });
      }
    }
    return markers;
  }, [comments]);

  const handleSubmitComment = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!grantToken || !commentText.trim() || isSubmittingComment) return;

    const trimmedGuestName = guestName.trim();
    if (!user && !trimmedGuestName) {
      setCommentError("Enter your name so your comment is attributed.");
      return;
    }

    setIsSubmittingComment(true);
    setCommentError(null);
    try {
      await createComment({
        grantToken,
        text: commentText.trim(),
        timestampSeconds: currentTime,
        guestName: user ? undefined : trimmedGuestName,
        assetId: selectedAssetId ?? undefined,
      });
      setCommentText("");
    } catch {
      setCommentError("Failed to post comment.");
    } finally {
      setIsSubmittingComment(false);
    }
  };

  const handleDownload = useCallback(async () => {
    if (!grantToken || isDownloading) return;

    setDownloadError(null);
    setIsDownloading(true);
    try {
      const result = await getDownloadUrl({
        grantToken,
        assetId: selectedAssetId ?? undefined,
      });
      triggerDownload(result.url, result.filename);
    } catch (error) {
      console.error("Failed to prepare shared download:", error);
      setDownloadError(
        error instanceof Error
          ? error.message
          : "Unable to prepare this download right now.",
      );
    } finally {
      setIsDownloading(false);
    }
  }, [getDownloadUrl, grantToken, isDownloading, selectedAssetId]);

  const isBootstrappingShare =
    shareInfo === undefined ||
    (shareInfo?.status === "ok" &&
      ((!grantToken && (!hasAttemptedAutoGrant || isRequestingGrant)) ||
        // Only wait on videoData when we're actually viewing an asset.
        // Folder/project shares legitimately leave videoData undefined while
        // the client is on the browser screen.
        (Boolean(grantToken) && isViewingAsset && videoData === undefined)));

  if (isBootstrappingShare) {
    return (
      <div className="min-h-screen bg-[#f0f0e8] flex items-center justify-center">
        <div className="text-[#888]">Opening shared video...</div>
      </div>
    );
  }

  if (shareInfo.status === "missing" || shareInfo.status === "expired") {
    return (
      <div className="min-h-screen bg-[#f0f0e8] flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardHeader className="text-center">
            <div className="mx-auto w-12 h-12 bg-[#dc2626]/10 flex items-center justify-center mb-4 border-2 border-[#dc2626]">
              <AlertCircle className="h-6 w-6 text-[#dc2626]" />
            </div>
            <CardTitle>Link expired or invalid</CardTitle>
            <CardDescription>
              This share link is no longer valid. Please ask the video owner for a new link.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link to="/" preload="intent" className="block">
              <Button variant="outline" className="w-full">
                Go to Frame
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (shareInfo.status === "requiresPassword" && !grantToken) {
    return (
      <div className="min-h-screen bg-[#f0f0e8] flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardHeader className="text-center">
            <div className="mx-auto w-12 h-12 bg-[#e8e8e0] flex items-center justify-center mb-4 border-2 border-[#1a1a1a]">
              <Lock className="h-6 w-6 text-[#888]" />
            </div>
            <CardTitle>Password required</CardTitle>
            <CardDescription>
              This video is password protected. Enter the password to view.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                await acquireGrant(passwordInput);
              }}
              className="space-y-4"
            >
              <Input
                type="password"
                placeholder="Enter password"
                value={passwordInput}
                onChange={(event) => setPasswordInput(event.target.value)}
                autoFocus
              />
              {passwordError && (
                <p className="text-sm text-[#dc2626]">Incorrect password</p>
              )}
              <Button type="submit" className="w-full" disabled={!passwordInput || isRequestingGrant}>
                {isRequestingGrant ? "Verifying..." : "View video"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Folder/project share — render the browser when no asset is selected.
  // Asset-scoped shares fall through to the single-asset rendering below.
  if (isMultiAssetShare && !selectedAssetId) {
    return (
      <div className="min-h-screen bg-[#f0f0e8]">
        <header className="bg-[#f0f0e8] border-b-2 border-[#1a1a1a] px-6 py-4">
          <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
            <Link
              preload="intent"
              to="/"
              className="text-[#888] hover:text-[#1a1a1a] text-sm flex items-center gap-2 font-bold"
            >
              Frame
            </Link>
            {grantContext?.projectName && (
              <span className="text-xs font-mono text-[#888] truncate">
                {grantContext.projectName}
              </span>
            )}
          </div>
        </header>
        <main className="max-w-6xl mx-auto p-6">
          <ShareBrowser
            title={grantContext?.title ?? "Shared"}
            data={browse}
            onOpenFolder={openFolder}
            onOpenAsset={openAsset}
            onNavigateHome={navigateHome}
          />
        </main>
        <footer className="border-t-2 border-[#1a1a1a] px-6 py-4 mt-8">
          <div className="max-w-6xl mx-auto text-center text-sm text-[#888]">
            Shared via{" "}
            <Link to="/" preload="intent" className="text-[#1a1a1a] hover:text-[#2d5a2d] font-bold">
              Frame
            </Link>
          </div>
        </footer>
      </div>
    );
  }

  if (!videoData?.asset) {
    return (
      <div className="min-h-screen bg-[#f0f0e8] flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardHeader className="text-center">
            <div className="mx-auto w-12 h-12 bg-[#e8e8e0] flex items-center justify-center mb-4 border-2 border-[#1a1a1a]">
              <Video className="h-6 w-6 text-[#888]" />
            </div>
            <CardTitle>Video not available</CardTitle>
            <CardDescription>
              This video is not available or is still processing.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const video = videoData.asset;

  return (
    <div className="min-h-screen bg-[#f0f0e8]">
      <header className="bg-[#f0f0e8] border-b-2 border-[#1a1a1a] px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {isMultiAssetShare ? (
              <button
                type="button"
                onClick={backToBrowser}
                className="text-[#888] hover:text-[#1a1a1a] text-sm flex items-center gap-1.5 font-bold"
              >
                <ArrowLeft className="h-4 w-4" />
                {grantContext?.title ?? "Back"}
              </button>
            ) : (
              <Link
                preload="intent"
                to="/"
                className="text-[#888] hover:text-[#1a1a1a] text-sm flex items-center gap-2 font-bold"
              >
                Frame
              </Link>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleDownload()}
            disabled={!grantToken || isDownloading}
          >
            <Download className="h-4 w-4" />
            {isDownloading ? "Preparing..." : "Download"}
          </Button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-6 space-y-6">
        {downloadError ? (
          <div
            role="alert"
            className="border-2 border-[#dc2626] bg-[#dc2626]/10 px-4 py-3 text-sm text-[#7f1d1d]"
          >
            {downloadError}
          </div>
        ) : null}

        <div>
          <h1 className="text-2xl font-black text-[#1a1a1a]">{video.title}</h1>
          {video.description && (
            <p className="text-[#888] mt-1">{video.description}</p>
          )}
          <div className="flex items-center gap-4 mt-2 text-sm text-[#888]">
            {video.duration && <span className="font-mono">{formatDuration(video.duration)}</span>}
            {comments && <span>{comments.length} threads</span>}
            <VideoWatchers watchers={watchers} className="ml-auto" />
          </div>
        </div>

        <div className="border-2 border-[#1a1a1a] overflow-hidden">
          {video.assetKind && video.assetKind !== "video" ? (
            <AssetViewer
              assetKind={video.assetKind}
              title={video.title}
              contentType={video.contentType}
              downloadUrl={sharedDownloadUrl ?? undefined}
              disallowDownload
            />
          ) : playbackSession?.url ? (
            <VideoPlayer
              ref={playerRef}
              src={playbackSession.url}
              poster={playbackSession.posterUrl}
              comments={flattenedComments}
              onTimeUpdate={setCurrentTime}
              allowDownload={false}
            />
          ) : (
            <div className="relative aspect-video overflow-hidden rounded-xl border border-zinc-800/80 bg-black shadow-[0_10px_40px_rgba(0,0,0,0.45)]">
              {(playbackSession?.posterUrl || video.thumbnailUrl?.startsWith("http")) ? (
                <img
                  src={playbackSession?.posterUrl ?? video.thumbnailUrl}
                  alt={`${video.title} thumbnail`}
                  className="h-full w-full object-cover blur-[4px]"
                />
              ) : null}
              <div className="absolute inset-0 bg-black/45" />
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
                <p className="text-sm font-medium text-white/85">
                  {playbackError ?? (isLoadingPlayback ? "Loading stream..." : "Preparing stream...")}
                </p>
              </div>
            </div>
          )}
        </div>

        <section className="border-2 border-[#1a1a1a] bg-[#e8e8e0] p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-black text-[#1a1a1a]">Comments</h2>
            <span className="text-xs text-[#888] font-mono">{formatTimestamp(currentTime)}</span>
          </div>

          {isUserLoaded ? (
            <form onSubmit={handleSubmitComment} className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-[#666]">
                <Clock className="h-3.5 w-3.5" />
                Comment at {formatTimestamp(currentTime)}
              </div>
              {!user ? (
                <Input
                  value={guestName}
                  onChange={(event) => setGuestName(event.target.value)}
                  placeholder="Your name"
                  maxLength={80}
                  required
                />
              ) : null}
              <Textarea
                value={commentText}
                onChange={(event) => setCommentText(event.target.value)}
                placeholder="Leave a comment..."
                className="min-h-[90px]"
              />
              {commentError ? <p className="text-xs text-[#dc2626]">{commentError}</p> : null}
              <Button
                type="submit"
                disabled={
                  !commentText.trim() ||
                  isSubmittingComment ||
                  (!user && !guestName.trim())
                }
              >
                <MessageSquare className="mr-1.5 h-4 w-4" />
                {isSubmittingComment ? "Posting..." : "Post comment"}
              </Button>
            </form>
          ) : null}

          {comments === undefined ? (
            <p className="text-sm text-[#888]">Loading comments...</p>
          ) : comments.length === 0 ? (
            <p className="text-sm text-[#888]">No comments yet.</p>
          ) : (
            <div className="space-y-3">
              {comments.map((comment) => (
                <article key={comment._id} className="border-2 border-[#1a1a1a] bg-[#f0f0e8] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-bold text-[#1a1a1a]">{comment.userName}</div>
                    <button
                      type="button"
                      className="font-mono text-xs text-[#2d5a2d] hover:text-[#1a1a1a]"
                      onClick={() => playerRef.current?.seekTo(comment.timestampSeconds, { play: true })}
                    >
                      {formatTimestamp(comment.timestampSeconds)}
                    </button>
                  </div>
                  <p className="text-sm text-[#1a1a1a] mt-1 whitespace-pre-wrap">{comment.text}</p>
                  <p className="text-[11px] text-[#888] mt-1">{formatRelativeTime(comment._creationTime)}</p>

                  {comment.replies.length > 0 ? (
                    <div className="mt-3 ml-4 border-l-2 border-[#1a1a1a] pl-3 space-y-2">
                      {comment.replies.map((reply) => (
                        <div key={reply._id} className="text-sm">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-bold text-[#1a1a1a]">{reply.userName}</span>
                            <button
                              type="button"
                              className="font-mono text-xs text-[#2d5a2d] hover:text-[#1a1a1a]"
                              onClick={() => playerRef.current?.seekTo(reply.timestampSeconds, { play: true })}
                            >
                              {formatTimestamp(reply.timestampSeconds)}
                            </button>
                          </div>
                          <p className="text-[#1a1a1a] whitespace-pre-wrap">{reply.text}</p>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </section>
      </main>

      <footer className="border-t-2 border-[#1a1a1a] px-6 py-4 mt-8">
        <div className="max-w-6xl mx-auto text-center text-sm text-[#888]">
          Shared via{" "}
          <Link to="/" preload="intent" className="text-[#1a1a1a] hover:text-[#2d5a2d] font-bold">
            Frame
          </Link>
        </div>
      </footer>
    </div>
  );
}
