"use client";

import { AuthProvider } from "@/contexts/AuthContext";
import { DeskStudioProvider } from "@/contexts/DeskStudioContext";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DeskStudioProvider>{children}</DeskStudioProvider>
    </AuthProvider>
  );
}
