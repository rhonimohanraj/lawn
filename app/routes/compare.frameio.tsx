import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/compare\/frameio")({
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
});
