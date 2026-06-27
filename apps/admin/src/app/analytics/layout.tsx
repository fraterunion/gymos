"use client";

import { ProtectedDeskLayout } from "@/components/ProtectedDeskLayout";

export default function AnalyticsLayout({ children }: { children: React.ReactNode }) {
  return <ProtectedDeskLayout>{children}</ProtectedDeskLayout>;
}
