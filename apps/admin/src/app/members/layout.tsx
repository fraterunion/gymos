"use client";

import { ProtectedDeskLayout } from "@/components/ProtectedDeskLayout";

export default function MembersLayout({ children }: { children: React.ReactNode }) {
  return <ProtectedDeskLayout>{children}</ProtectedDeskLayout>;
}
