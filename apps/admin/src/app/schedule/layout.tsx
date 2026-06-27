"use client";

import { ProtectedDeskLayout } from "@/components/ProtectedDeskLayout";

export default function ScheduleLayout({ children }: { children: React.ReactNode }) {
  return <ProtectedDeskLayout>{children}</ProtectedDeskLayout>;
}
