import type { Me, Membership, Permission } from "./types";

/** Effective permissions = platform permissions + permissions in the active school. */
export function effectivePermissions(me: Me | null, school: Membership | null): Set<Permission> {
  const perms = new Set<Permission>(me?.platform_permissions ?? []);
  for (const p of school?.permissions ?? []) perms.add(p);
  return perms;
}

export function isSchoolPermission(p: Permission): boolean {
  return !p.startsWith("platform:");
}
