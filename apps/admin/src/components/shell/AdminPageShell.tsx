import type { ReactNode } from "react";

type AdminPageShellProps = {
  children: ReactNode;
  /** Narrower content for briefing-style pages */
  width?: "default" | "wide";
};

export function AdminPageShell({ children, width = "wide" }: AdminPageShellProps) {
  const maxWidth = width === "default" ? "max-w-5xl" : "max-w-[1360px]";
  return (
    <main className={`mx-auto w-full flex-1 px-4 py-8 sm:px-6 lg:px-8 ${maxWidth}`}>
      {children}
    </main>
  );
}
