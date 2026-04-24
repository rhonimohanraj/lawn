import { createFileRoute } from "@tanstack/react-router";
import { seoHead } from "@/lib/seo";
import { AuthShell } from "./auth/-layout";
import SignUpPage from "./auth/-sign-up";

export const Route = createFileRoute("/sign-up")({
  head: () =>
    seoHead({
      title: "Create your Frame account",
      description:
        "Private video review for Trident Event Group.",
      path: "/sign-up",
    }),
  validateSearch: (search: Record<string, unknown>) => ({
    redirect_url:
      typeof search.redirect_url === "string" ? search.redirect_url : undefined,
  }),
  component: SignUpRoute,
});

function SignUpRoute() {
  return (
    <AuthShell>
      <SignUpPage />
    </AuthShell>
  );
}
