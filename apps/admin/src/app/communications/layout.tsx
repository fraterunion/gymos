"use client";

import { ProtectedDeskLayout } from "@/components/ProtectedDeskLayout";

export default function CommunicationsLayout({ children }: { children: React.ReactNode }) {
  return <ProtectedDeskLayout>{children}</ProtectedDeskLayout>;
}
