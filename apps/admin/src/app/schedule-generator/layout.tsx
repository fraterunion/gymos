"use client";

import { ProtectedDeskLayout } from "@/components/ProtectedDeskLayout";

export default function ScheduleGeneratorLayout({ children }: { children: React.ReactNode }) {
  return <ProtectedDeskLayout>{children}</ProtectedDeskLayout>;
}
