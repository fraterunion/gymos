"use client";

import { ProtectedDeskLayout } from "@/components/ProtectedDeskLayout";

export default function BuildsLayout({ children }: { children: React.ReactNode }) {
  return <ProtectedDeskLayout>{children}</ProtectedDeskLayout>;
}
