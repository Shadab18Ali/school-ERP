"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiFetch, ApiError, errorMessage } from "@/lib/api";
import { effectivePermissions } from "@/lib/permissions";
import { forgetDeviceOnSignOut, syncPush } from "@/lib/push-client";
import { createClient } from "@/lib/supabase/client";
import type { Me, Membership, Permission, PlanFeatureKey } from "@/lib/types";
import { reportSessionEvent } from "@/lib/session-events";

const SCHOOL_KEY = "erp.currentSchoolId";

/**
 * Full page load (not client-side routing) when the signed-in user changes:
 * it guarantees no previous user's data survives in React state or the router cache.
 */
function hardNavigate(url: string) {
  window.location.assign(url);
}

interface AuthContextValue {
  me: Me | null;
  loading: boolean;
  error: string | null;
  currentSchool: Membership | null;
  activeSchools: Membership[];
  permissions: Set<Permission>;
  can: (permission: Permission) => boolean;
  /** whether the current school's plan includes a feature (the API enforces the same) */
  hasFeature: (key: PlanFeatureKey) => boolean;
  /** the current school's subscription has ended: records can be read, not changed */
  readOnly: boolean;
  setCurrentSchoolId: (id: string) => void;
  refresh: () => Promise<void>;
  setMe: (me: Me) => void;
  signOut: (opts?: { everywhere?: boolean }) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMeState] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [schoolId, setSchoolId] = useState<string | null>(null);

  const signOut = useCallback(async (opts?: { everywhere?: boolean }) => {
    // this device stops getting the person's notifications (the next user must not see them);
    // at most 3 seconds, so a bad connection never blocks signing out
    await Promise.race([forgetDeviceOnSignOut(), new Promise((r) => setTimeout(r, 3000))]);
    // the sign-out goes in the audit log while the session is still valid (Supabase records it too)
    await reportSessionEvent("logout");
    try {
      await createClient().auth.signOut({ scope: opts?.everywhere ? "global" : "local" });
    } finally {
      // Even if the network call fails, the local session is cleared; always leave.
      localStorage.removeItem(SCHOOL_KEY);
      hardNavigate("/login?reason=signed_out");
    }
  }, []);

  const applyMe = useCallback((data: Me) => {
    setMeState(data);
    const stored = localStorage.getItem(SCHOOL_KEY);
    const active = data.memberships.filter((m) => m.school_status === "active");
    setSchoolId(active.find((m) => m.school_id === stored)?.school_id ?? active[0]?.school_id ?? null);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      applyMe(await apiFetch<Me>("/me"));
      void syncPush(); // keep this device's notifications registered (if the person turned them on here)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return; // apiFetch already redirected
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [applyMe]);

  useEffect(() => {
    void refresh();
    const { data } = createClient().auth.onAuthStateChange((event) => {
      // Signed out elsewhere in this browser, or the refresh token was revoked: leave protected pages.
      if (event === "SIGNED_OUT" && !window.location.pathname.startsWith("/login")) {
        hardNavigate("/login?reason=signed_out");
      }
    });
    // Back/forward cache can restore a protected page after sign-out; reload so the
    // server checks the session again.
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) window.location.reload();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => {
      data.subscription.unsubscribe();
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [refresh]);

  const value = useMemo<AuthContextValue>(() => {
    const activeSchools = me?.memberships.filter((m) => m.school_status === "active") ?? [];
    const currentSchool = activeSchools.find((m) => m.school_id === schoolId) ?? null;
    const permissions = effectivePermissions(me, currentSchool);
    return {
      me,
      loading,
      error,
      activeSchools,
      currentSchool,
      permissions,
      can: (p: Permission) => permissions.has(p),
      hasFeature: (k: PlanFeatureKey) => !!me?.is_super_admin || !currentSchool?.features || currentSchool.features.includes(k),
      readOnly: !me?.is_super_admin && currentSchool?.access === "read_only",
      setCurrentSchoolId: (id: string) => {
        localStorage.setItem(SCHOOL_KEY, id);
        setSchoolId(id);
      },
      refresh,
      setMe: applyMe,
      signOut,
    };
  }, [me, loading, error, schoolId, refresh, applyMe, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
