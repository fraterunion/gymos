import type { ReactNode } from "react";

type SurfaceCardProps = {
  children: ReactNode;
  className?: string;
  padding?: "sm" | "md" | "lg";
};

const paddingClass = {
  sm: "p-4",
  md: "p-5",
  lg: "p-6",
};

export function SurfaceCard({ children, className = "", padding = "md" }: SurfaceCardProps) {
  return (
    <div
      className={`rounded-2xl border border-zinc-200/90 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)] ${paddingClass[padding]} ${className}`}
    >
      {children}
    </div>
  );
}
