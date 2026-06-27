"use client";

import { ProtectedDeskLayout } from "@/components/ProtectedDeskLayout";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return <ProtectedDeskLayout>{children}</ProtectedDeskLayout>;
}
