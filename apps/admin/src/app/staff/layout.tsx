"use client";

import { ProtectedDeskLayout } from "@/components/ProtectedDeskLayout";

export default function StaffLayout({ children }: { children: React.ReactNode }) {
  return <ProtectedDeskLayout>{children}</ProtectedDeskLayout>;
}
