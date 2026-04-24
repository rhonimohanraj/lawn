import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/for\/agencies")({
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
});
