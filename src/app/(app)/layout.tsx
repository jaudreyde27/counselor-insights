import type { ReactNode } from "react";
import { AppShell } from "@/components/AppShell";
import { requireCounselor } from "@/lib/auth";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const counselor = await requireCounselor();
  return <AppShell counselor={counselor}>{children}</AppShell>;
}
