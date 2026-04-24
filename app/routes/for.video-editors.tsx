import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/for\/video-editors")({
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
});
