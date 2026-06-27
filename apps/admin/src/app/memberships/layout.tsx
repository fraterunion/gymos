"use client";

import { ProtectedDeskLayout } from "@/components/ProtectedDeskLayout";

export default function MembershipsLayout({ children }: { children: React.ReactNode }) {
  return <ProtectedDeskLayout>{children}</ProtectedDeskLayout>;
}
