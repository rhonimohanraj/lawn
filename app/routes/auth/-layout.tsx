import { Link } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

export function AuthShell({ children }: { children: ReactNode }) {
  // Force light theme on auth pages — Clerk's appearance is hardcoded to
  // light colors; rendering inside a dark parent turns the inputs invisible.
  useEffect(() => {
    const prev = document.documentElement.getAttribute("data-theme");
    document.documentElement.setAttribute("data-theme", "light");
    return () => {
      if (prev) document.documentElement.setAttribute("data-theme", prev);
      else document.documentElement.removeAttribute("data-theme");
    };
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f0f0e8] relative">
      <div
        className="absolute inset-0 opacity-[0.03] pointer-events-none"
        style={{
          backgroundImage: `
            linear-gradient(#1a1a1a 1px, transparent 1px),
            linear-gradient(90deg, #1a1a1a 1px, transparent 1px)
          `,
          backgroundSize: "60px 60px",
        }}
      />

      <div className="relative z-10 w-full max-w-md px-4">
        <div className="text-center mb-8">
          <Link to="/" className="inline-block">
            <span className="text-4xl font-black text-[#1a1a1a]">Frame</span>
          </Link>
          <p className="mt-3 text-sm text-[#888]">
            Trident Event Group · Video review for the team
          </p>
        </div>
        {children}
      </div>
    </div>
  );
}

export default AuthShell;
