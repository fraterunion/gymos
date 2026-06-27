"use client";

import { ProtectedDeskLayout } from "@/components/ProtectedDeskLayout";

export default function CheckInLayout({ children }: { children: React.ReactNode }) {
  return <ProtectedDeskLayout>{children}</ProtectedDeskLayout>;
}
