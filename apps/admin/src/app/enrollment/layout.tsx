"use client";

import { ProtectedDeskLayout } from "@/components/ProtectedDeskLayout";

export default function EnrollmentLayout({ children }: { children: React.ReactNode }) {
  return <ProtectedDeskLayout>{children}</ProtectedDeskLayout>;
}
