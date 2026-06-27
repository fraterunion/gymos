"use client";

import { ProtectedDeskLayout } from "@/components/ProtectedDeskLayout";

export default function ClassesLayout({ children }: { children: React.ReactNode }) {
  return <ProtectedDeskLayout>{children}</ProtectedDeskLayout>;
}
