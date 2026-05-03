import test from "node:test";
import assert from "node:assert/strict";
import { getFunctionName } from "convex/server";
import { Id } from "@convex/_generated/dataModel";
import { getDashboardIndexEssentialSpecs } from "./-index.data";
import { getProjectEssentialSpecs } from "./-project.data";
import { getSettingsEssentialSpecs } from "./-settings.data";
import { getTeamEssentialSpecs } from "./-team.data";
import { getVideoEssentialSpecs } from "./-video.data";

function names(specs: Array<{ query: unknown }>) {
  return specs.map((spec) => getFunctionName(spec.query as never)).sort();
}

test("dashboard route data contracts expose expected essential queries", () => {
  const teamSlug = "garden";
  const projectId = "proj_123" as Id<"projects">;
  const assetId = "vid_123" as Id<"assets">;

  assert.deepEqual(names(getDashboardIndexEssentialSpecs()), ["teams:list"]);

  assert.deepEqual(names(getTeamEssentialSpecs({ teamSlug })), [
    "workspace:resolveContext",
  ]);

  assert.deepEqual(names(getSettingsEssentialSpecs({ teamSlug })), [
    "workspace:resolveContext",
  ]);

  assert.deepEqual(
    names(getProjectEssentialSpecs({ teamSlug, projectId })),
    ["projects:get", "videos:list", "workspace:resolveContext"],
  );

  assert.deepEqual(
    names(getVideoEssentialSpecs({ teamSlug, projectId, assetId })),
    [
      "comments:getThreaded",
      "comments:list",
      "videos:get",
      "workspace:resolveContext",
    ],
  );
});
