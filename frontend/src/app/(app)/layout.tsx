import { AppShell } from "@/components/layout/app-shell";
import { AuthProvider } from "@/providers/auth-provider";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <AppShell>{children}</AppShell>
    </AuthProvider>
  );
}
