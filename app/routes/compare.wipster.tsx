import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/compare\/wipster")({
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
});
