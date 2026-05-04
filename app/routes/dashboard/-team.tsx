
import { useConvex, useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Folder,
  Plus,
  MoreVertical,
  Trash2,
  Users,
  ArrowRight,
  Settings as SettingsIcon,
  Link as LinkIcon,
  FolderInput,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MemberInvite } from "@/components/teams/MemberInvite";
import { cn } from "@/lib/utils";
import { projectPath, teamSettingsPath } from "@/lib/routes";
import { Id } from "@convex/_generated/dataModel";
import { useRoutePrewarmIntent } from "@/lib/useRoutePrewarmIntent";
import { prewarmProject } from "./-project.data";
import { useTeamData } from "./-team.data";
import { DashboardHeader } from "@/components/DashboardHeader";
import { ViewModeToggle, type ViewMode } from "@/components/ViewModeToggle";
import { SortMenu, type SortOption } from "@/components/SortMenu";
import { ProjectTable } from "@/components/projects/ProjectTable";

type ProjectSortKey = "name" | "assets" | "size" | "created" | "modified";

const PROJECT_SORT_OPTIONS: ReadonlyArray<SortOption<ProjectSortKey>> = [
  { key: "name", label: "Name (A–Z)" },
  { key: "assets", label: "Most assets" },
  { key: "size", label: "Largest size" },
  { key: "created", label: "Recently created" },
  { key: "modified", label: "Recently modified" },
];

function compareProjects(
  a: { name: string; assetCount: number; sizeBytes?: number; _creationTime: number; lastModifiedAt?: number },
  b: typeof a,
  key: ProjectSortKey,
): number {
  switch (key) {
    case "name":
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
    case "assets":
      return b.assetCount - a.assetCount;
    case "size":
      return (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);
    case "created":
      return b._creationTime - a._creationTime;
    case "modified":
      return (
        (b.lastModifiedAt ?? b._creationTime) - (a.lastModifiedAt ?? a._creationTime)
      );
  }
}

type TeamProjectCardProps = {
  teamSlug: string;
  project: {
    _id: Id<"projects">;
    name: string;
    assetCount: number;
  };
  canCreateProject: boolean;
  onOpen: () => void;
  onDelete: (projectId: Id<"projects">) => void;
  onShare: (projectId: Id<"projects">) => void;
  onRequestNest: (project: { _id: Id<"projects">; name: string }) => void;
  /** HTML5 drag/drop handlers wired by the parent so the same logic powers
   *  both grid + table views. */
  dragHandlers: React.HTMLAttributes<HTMLDivElement>;
  isDragOver: boolean;
};

function TeamProjectCard({
  teamSlug,
  project,
  canCreateProject,
  onOpen,
  onDelete,
  onShare,
  onRequestNest,
  dragHandlers,
  isDragOver,
}: TeamProjectCardProps) {
  const convex = useConvex();
  const prewarmIntentHandlers = useRoutePrewarmIntent(() =>
    prewarmProject(convex, {
      teamSlug,
      projectId: project._id,
    }),
  );

  return (
    <Card
      className={cn(
        "group cursor-pointer hover:bg-[#e8e8e0] transition-colors",
        isDragOver && "ring-2 ring-[#2d5a2d] ring-offset-2 ring-offset-[#f0f0e8]",
      )}
      onClick={onOpen}
      draggable
      {...dragHandlers}
      {...prewarmIntentHandlers}
    >
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
        <div className="flex-1 min-w-0">
          <CardTitle className="text-base truncate">{project.name}</CardTitle>
          <CardDescription className="mt-1">
            {project.assetCount} asset{project.assetCount !== 1 ? "s" : ""}
          </CardDescription>
        </div>
        {canCreateProject && (
          <DropdownMenu>
            <DropdownMenuTrigger
              asChild
              onClick={(e) => e.stopPropagation()}
            >
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onShare(project._id);
                }}
              >
                <LinkIcon className="mr-2 h-4 w-4" />
                Share project
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onRequestNest({ _id: project._id, name: project.name });
                }}
              >
                <FolderInput className="mr-2 h-4 w-4" />
                Move into another project…
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-[#dc2626] focus:text-[#dc2626]"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(project._id);
                }}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between text-sm text-[#888] group-hover:text-[#1a1a1a] transition-colors">
          <span>Open project</span>
          <ArrowRight className="h-4 w-4" />
        </div>
      </CardContent>
    </Card>
  );
}

export default function TeamPage() {
  const params = useParams({ strict: false });
  const navigate = useNavigate({});
  const pathname = useLocation().pathname;
  const teamSlug = typeof params.teamSlug === "string" ? params.teamSlug : "";

  const { context, team, projects, billing } = useTeamData({ teamSlug });
  const createProject = useMutation(api.projects.create);
  const deleteProject = useMutation(api.projects.remove);
  const createProjectShare = useMutation(api.shareLinks.createForProject);
  const nestProjectIntoProject = useMutation(api.projectActions.nestProjectIntoProject);

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [memberDialogOpen, setMemberDialogOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [projectSort, setProjectSort] = useState<ProjectSortKey>("name");

  // Drag-to-nest state. dragSourceId = the project being dragged. dragOverId
  // = the prospective drop target, used to highlight the row/card.
  const [dragSourceId, setDragSourceId] = useState<Id<"projects"> | null>(null);
  const [dragOverId, setDragOverId] = useState<Id<"projects"> | null>(null);

  // Pending nest, awaiting confirmation. We collect both names so the
  // dialog can describe the action in plain English.
  const [pendingNest, setPendingNest] = useState<{
    sourceId: Id<"projects">;
    sourceName: string;
    targetId: Id<"projects">;
    targetName: string;
  } | null>(null);
  const [isNesting, setIsNesting] = useState(false);

  // Kebab-driven nest: user picked "Move into another project" but hasn't
  // chosen the target yet. Pops a project-picker dialog.
  const [nestPickerSource, setNestPickerSource] = useState<{
    _id: Id<"projects">;
    name: string;
  } | null>(null);

  // Typed-confirmation delete. The user picks Delete from the kebab and
  // we require them to retype the project name before the mutation
  // fires — guards against accidental cascade deletes.
  const [pendingDelete, setPendingDelete] = useState<{
    _id: Id<"projects">;
    name: string;
    assetCount: number;
  } | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [shareToast, setShareToast] = useState<string | null>(null);
  const shareToastTimeoutRef = useRef<number | null>(null);

  const showShareToast = useCallback((message: string) => {
    setShareToast(message);
    if (shareToastTimeoutRef.current !== null) {
      window.clearTimeout(shareToastTimeoutRef.current);
    }
    shareToastTimeoutRef.current = window.setTimeout(() => {
      setShareToast(null);
      shareToastTimeoutRef.current = null;
    }, 2400);
  }, []);
  useEffect(
    () => () => {
      if (shareToastTimeoutRef.current !== null) {
        window.clearTimeout(shareToastTimeoutRef.current);
      }
    },
    [],
  );

  const shouldCanonicalize =
    !!context && !context.isCanonical && pathname !== context.canonicalPath;

  useEffect(() => {
    if (shouldCanonicalize && context) {
      navigate({ to: context.canonicalPath, replace: true });
    }
  }, [shouldCanonicalize, context, navigate]);

  const isLoadingData =
    context === undefined ||
    billing === undefined ||
    projects === undefined ||
    shouldCanonicalize;

  // Not found state
  if (context === null) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-[#888]">Team not found</div>
      </div>
    );
  }

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjectName.trim() || !team) return;

    setIsLoading(true);
    try {
      const projectId = await createProject({
        teamId: team._id,
        name: newProjectName.trim(),
      });
      setCreateDialogOpen(false);
      setNewProjectName("");
      navigate({ to: projectPath(team.slug, projectId) });
    } catch (error) {
      console.error("Failed to create project:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteProject = (projectId: Id<"projects">) => {
    const project = projects?.find((p) => p._id === projectId);
    if (!project) return;
    setDeleteConfirmName("");
    setDeleteError(null);
    setPendingDelete({
      _id: project._id,
      name: project.name,
      assetCount: project.assetCount,
    });
  };

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    if (deleteConfirmName.trim() !== pendingDelete.name) {
      setDeleteError(
        `Type "${pendingDelete.name}" exactly to confirm deletion.`,
      );
      return;
    }
    setIsDeleting(true);
    setDeleteError(null);
    try {
      await deleteProject({
        projectId: pendingDelete._id,
        confirmName: deleteConfirmName.trim(),
      });
      setPendingDelete(null);
      showShareToast(`Deleted ${pendingDelete.name}`);
    } catch (error) {
      setDeleteError(
        error instanceof Error ? error.message : "Failed to delete project",
      );
    } finally {
      setIsDeleting(false);
    }
  }, [deleteProject, deleteConfirmName, pendingDelete, showShareToast]);

  const handleShareProject = useCallback(
    async (projectId: Id<"projects">) => {
      try {
        const result = await createProjectShare({
          projectId,
          allowDownload: false,
        });
        const origin = typeof window !== "undefined" ? window.location.origin : "";
        const url = `${origin}/share/${result.token}`;
        if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(url);
          showShareToast("Project share link copied");
        } else {
          showShareToast(url);
        }
      } catch (error) {
        console.error("Failed to create project share:", error);
        showShareToast("Could not create share link");
      }
    },
    [createProjectShare, showShareToast],
  );

  const handleConfirmNest = useCallback(async () => {
    if (!pendingNest) return;
    setIsNesting(true);
    try {
      await nestProjectIntoProject({
        sourceProjectId: pendingNest.sourceId,
        targetProjectId: pendingNest.targetId,
      });
      showShareToast(
        `${pendingNest.sourceName} nested inside ${pendingNest.targetName}`,
      );
      setPendingNest(null);
    } catch (error) {
      console.error("Failed to nest project:", error);
      showShareToast(
        error instanceof Error ? error.message : "Failed to nest project",
      );
    } finally {
      setIsNesting(false);
    }
  }, [nestProjectIntoProject, pendingNest, showShareToast]);

  // Drag handler factory — same logic for grid + table. Each call returns
  // the four HTML5 DnD handlers wired to a specific project.
  const dragHandlersFor = useCallback(
    (project: { _id: Id<"projects">; name: string }): React.HTMLAttributes<HTMLElement> => ({
      onDragStart: (e: React.DragEvent) => {
        setDragSourceId(project._id);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", project._id);
      },
      onDragEnd: () => {
        setDragSourceId(null);
        setDragOverId(null);
      },
      onDragOver: (e: React.DragEvent) => {
        if (!dragSourceId || dragSourceId === project._id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (dragOverId !== project._id) setDragOverId(project._id);
      },
      onDragLeave: () => {
        if (dragOverId === project._id) setDragOverId(null);
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        if (!dragSourceId || dragSourceId === project._id) return;
        const sourceProject = projects?.find((p) => p._id === dragSourceId);
        if (!sourceProject) return;
        setPendingNest({
          sourceId: dragSourceId,
          sourceName: sourceProject.name,
          targetId: project._id,
          targetName: project.name,
        });
        setDragSourceId(null);
        setDragOverId(null);
      },
    }),
    [dragSourceId, dragOverId, projects],
  );

  const canManageMembers = team?.role === "owner" || team?.role === "admin";
  const hasActiveSubscription = billing?.hasActiveSubscription ?? false;
  const canCreateProject = team?.role !== "viewer" && hasActiveSubscription;
  const canAccessBilling = team?.role === "owner";
  const billingPath = team ? teamSettingsPath(team.slug) : null;

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <DashboardHeader paths={[{ label: team?.slug ?? "team" }]}>
        {canAccessBilling && team && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate({ to: billingPath ?? teamSettingsPath(team.slug) })}
            title="Settings"
          >
            <SettingsIcon className="h-4 w-4" />
          </Button>
        )}
        {canManageMembers && (
          <Button
            variant="outline"
            onClick={() => setMemberDialogOpen(true)}
          >
            <Users className="sm:mr-1.5 h-4 w-4" />
            <span className="hidden sm:inline">Members</span>
          </Button>
        )}
        {viewMode === "grid" && (
          <SortMenu<ProjectSortKey>
            options={PROJECT_SORT_OPTIONS}
            value={projectSort}
            onChange={setProjectSort}
            storageKey={`frame:teamGridSort:${teamSlug}`}
          />
        )}
        <ViewModeToggle value={viewMode} onChange={setViewMode} />
        {canCreateProject && (
          <Button onClick={() => setCreateDialogOpen(true)}>
            <Plus className="sm:mr-1.5 h-4 w-4" />
            <span className="hidden sm:inline">New project</span>
          </Button>
        )}
      </DashboardHeader>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        {!isLoadingData && !hasActiveSubscription && canAccessBilling && (
          <Card className="mb-6 border-[#1a1a1a]">
            <CardHeader>
              <CardTitle>Set up billing to create projects</CardTitle>
              <CardDescription>
                This team has no active subscription. Go to Billing to start Basic or Pro before
                creating projects.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                variant="primary"
                onClick={() => {
                  if (!billingPath) return;
                  navigate({ to: billingPath });
                }}
              >
                Go to Billing
              </Button>
            </CardContent>
          </Card>
        )}
        {!isLoadingData && projects.length === 0 ? (
          <div className="h-full flex items-center justify-center animate-in fade-in duration-300">
            <Card className="max-w-sm text-center">
              <CardHeader>
                <div className="mx-auto w-12 h-12 bg-[#e8e8e0] flex items-center justify-center mb-2">
                  <Folder className="h-6 w-6 text-[#888]" />
                </div>
                <CardTitle className="text-lg">No projects yet</CardTitle>
                <CardDescription>
                  {hasActiveSubscription
                    ? "Create your first project to start uploading videos."
                    : "Activate billing first, then create your first project."}
                </CardDescription>
              </CardHeader>
              {canCreateProject && (
                <CardContent>
                  <Button
                    className="w-full"
                    onClick={() => setCreateDialogOpen(true)}
                  >
                    <Plus className="mr-1.5 h-4 w-4" />
                    Create project
                  </Button>
                </CardContent>
              )}
              {!canCreateProject && canAccessBilling && (
                <CardContent>
                  <Button
                    variant="primary"
                    className="w-full"
                    onClick={() => {
                      if (!billingPath) return;
                      navigate({ to: billingPath });
                    }}
                  >
                    Go to Billing
                  </Button>
                </CardContent>
              )}
            </Card>
          </div>
        ) : viewMode === "grid" ? (
          <div className={cn(
            "grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 transition-opacity duration-300",
            isLoadingData ? "opacity-0" : "opacity-100"
          )}>
            {projects
              ?.slice()
              .sort((a, b) => compareProjects(a, b, projectSort))
              .map((project) => (
              <TeamProjectCard
                key={project._id}
                teamSlug={team.slug}
                project={project}
                canCreateProject={canCreateProject}
                onOpen={() =>
                  navigate({ to: projectPath(team.slug, project._id) })
                }
                onDelete={handleDeleteProject}
                onShare={handleShareProject}
                onRequestNest={(p) => setNestPickerSource(p)}
                dragHandlers={dragHandlersFor(project)}
                isDragOver={dragOverId === project._id}
              />
            ))}
          </div>
        ) : (
          <ProjectTable
            projects={projects ?? []}
            onOpen={(projectId) => navigate({ to: projectPath(team.slug, projectId) })}
            sortStorageKey={`frame:projectTableSort:${team?.slug ?? "default"}`}
            rowDragHandlers={(project) => ({
              dragOver: dragOverId === project._id,
              ...dragHandlersFor(project),
            })}
            renderActions={
              canCreateProject
                ? (project) => (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => void handleShareProject(project._id)}>
                          <LinkIcon className="mr-2 h-4 w-4" />
                          Share project
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() =>
                            setNestPickerSource({ _id: project._id, name: project.name })
                          }
                        >
                          <FolderInput className="mr-2 h-4 w-4" />
                          Move into another project…
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-[#dc2626] focus:text-[#dc2626]"
                          onClick={() => handleDeleteProject(project._id)}
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )
                : undefined
            }
            className={cn(
              "transition-opacity duration-300",
              isLoadingData ? "opacity-0" : "opacity-100",
            )}
          />
        )}
      </div>

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent>
          <form onSubmit={handleCreateProject}>
            <DialogHeader>
              <DialogTitle>Create project</DialogTitle>
              <DialogDescription>
                Projects help you organize related videos together.
              </DialogDescription>
            </DialogHeader>
            <div className="py-4">
              <Input
                placeholder="Project name"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!newProjectName.trim() || isLoading}
              >
                {isLoading ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {canManageMembers && team && (
        <MemberInvite
          teamId={team._id}
          open={memberDialogOpen}
          onOpenChange={setMemberDialogOpen}
        />
      )}

      {/* Drag-to-nest confirmation. The mutation is destructive (deletes the
          source project after moving its contents), so we explicitly confirm. */}
      <Dialog
        open={pendingNest !== null}
        onOpenChange={(open) => {
          if (!open && !isNesting) setPendingNest(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Nest {pendingNest?.sourceName} inside {pendingNest?.targetName}?
            </DialogTitle>
            <DialogDescription className="leading-relaxed">
              All assets and folders inside <strong>{pendingNest?.sourceName}</strong>{" "}
              will be moved into a new folder called{" "}
              <strong>{pendingNest?.sourceName}</strong> at the top of{" "}
              <strong>{pendingNest?.targetName}</strong>. The original project will
              be deleted once the move completes.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingNest(null)}
              disabled={isNesting}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void handleConfirmNest()}
              disabled={isNesting}
            >
              <FolderInput className="h-4 w-4" />
              {isNesting ? "Nesting…" : "Nest project"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Kebab-driven nest picker. The drag-drop confirmation dialog
          (above) handles confirming a chosen target; this one lets the
          user pick the target in the first place. */}
      <Dialog
        open={nestPickerSource !== null}
        onOpenChange={(open) => {
          if (!open) setNestPickerSource(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Move {nestPickerSource?.name} into…</DialogTitle>
            <DialogDescription>
              Pick a project to move <strong>{nestPickerSource?.name}</strong> into.
              All its assets and folders will be nested as a top-level folder
              there.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-72 overflow-y-auto rounded-md border border-[#1a1a1a]/15 divide-y divide-[#1a1a1a]/10">
            {(projects ?? [])
              .filter((p) => p._id !== nestPickerSource?._id)
              .slice()
              .sort((a, b) =>
                a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }),
              )
              .map((p) => (
                <button
                  key={p._id}
                  type="button"
                  onClick={() => {
                    if (!nestPickerSource) return;
                    setPendingNest({
                      sourceId: nestPickerSource._id,
                      sourceName: nestPickerSource.name,
                      targetId: p._id,
                      targetName: p.name,
                    });
                    setNestPickerSource(null);
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-[#e8e8e0] transition-colors"
                >
                  <span className="inline-flex items-center justify-center h-6 w-6 rounded bg-[#e8e8e0] text-[#2d5a2d] shrink-0">
                    <Folder className="h-3 w-3" />
                  </span>
                  <span className="flex-1 min-w-0 text-sm text-[#1a1a1a] truncate">
                    {p.name}
                  </span>
                  <span className="text-[11px] font-mono text-[#888] shrink-0">
                    {p.assetCount} asset{p.assetCount !== 1 ? "s" : ""}
                  </span>
                </button>
              ))}
            {(projects ?? []).filter((p) => p._id !== nestPickerSource?._id).length === 0 && (
              <div className="px-3 py-6 text-sm text-[#888] text-center">
                No other projects to move into yet.
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNestPickerSource(null)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Typed-confirmation delete. The cascade nukes every asset,
          comment, and share link in the project — way too destructive
          for a one-tap action. User must retype the project name. */}
      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !isDeleting) setPendingDelete(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {pendingDelete?.name}?</DialogTitle>
            <DialogDescription className="leading-relaxed">
              This permanently removes the project and{" "}
              <strong>
                {pendingDelete?.assetCount ?? 0} asset
                {pendingDelete?.assetCount === 1 ? "" : "s"}
              </strong>
              {" "}inside, plus every comment, share link, and grant tied to
              them. The B2 / Mux media stays in storage — recovery is
              possible but tedious. Type{" "}
              <strong className="font-mono">{pendingDelete?.name}</strong>{" "}
              below to confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label
              htmlFor="delete-confirm-name"
              className="text-xs font-mono uppercase tracking-wider text-[#888]"
            >
              Project name
            </label>
            <Input
              id="delete-confirm-name"
              value={deleteConfirmName}
              onChange={(e) => {
                setDeleteConfirmName(e.target.value);
                if (deleteError) setDeleteError(null);
              }}
              placeholder={pendingDelete?.name ?? ""}
              autoFocus
            />
          </div>
          {deleteError && <p className="text-sm text-[#dc2626]">{deleteError}</p>}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingDelete(null)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleConfirmDelete()}
              disabled={
                isDeleting ||
                deleteConfirmName.trim() !== pendingDelete?.name
              }
            >
              <Trash2 className="h-4 w-4" />
              {isDeleting ? "Deleting…" : "Delete project"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {shareToast ? (
        <div className="fixed right-4 top-4 z-50" aria-live="polite">
          <div className="border-2 border-[#1a1a1a] bg-[#f0f0e8] px-3 py-2 text-sm font-bold shadow-[4px_4px_0px_0px_var(--shadow-color)]">
            {shareToast}
          </div>
        </div>
      ) : null}
    </div>
  );
}
