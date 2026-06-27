"use client";

import { ProtectedDeskLayout } from "@/components/ProtectedDeskLayout";

export default function ScanLayout({ children }: { children: React.ReactNode }) {
  return <ProtectedDeskLayout>{children}</ProtectedDeskLayout>;
}
