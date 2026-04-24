import { createFileRoute } from "@tanstack/react-router";
import { seoHead } from "@/lib/seo";
import DashboardLayout from "./-layout";

export const Route = createFileRoute("/dashboard")({
  head: () =>
    seoHead({
      title: "Dashboard",
      description: "Manage your video projects on Frame.",
      path: "/dashboard",
      noIndex: true,
    }),
  component: DashboardLayout,
});
