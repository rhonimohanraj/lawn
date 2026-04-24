import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@clerk/tanstack-react-start";
import { useEffect } from "react";

export const Route = createFileRoute("/")({
  component: RootRedirect,
});

function RootRedirect() {
  const { isLoaded, isSignedIn } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isLoaded) return;
    if (isSignedIn) {
      navigate({ to: "/dashboard", replace: true });
    } else {
      navigate({
        to: "/sign-in/$",
        params: { _splat: "" } as never,
        replace: true,
      });
    }
  }, [isLoaded, isSignedIn, navigate]);

  return (
    <div className="min-h-screen bg-[#f0f0e8] flex items-center justify-center text-[#888]">
      Loading…
    </div>
  );
}
