"use client";

import { useEffect, useState, type FormEvent } from "react";
import { MyItemsCard } from "@/components/inventory/my-items";
import { DeviceSettings } from "@/components/pwa/device-settings";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TextField } from "@/components/ui/field";
import { LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { authErrorMessage } from "@/lib/auth-errors";
import type { Preferences } from "@/lib/notifications";
import { createClient } from "@/lib/supabase/client";
import { ROLE_LABELS, type Me } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

function Card({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-white">
      <div className="border-b border-line px-5 py-4">
        <h2 className="font-semibold">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function DetailsForm({ me }: { me: Me }) {
  const { setMe } = useAuth();
  const toast = useToast();
  const [fullName, setFullName] = useState(me.full_name);
  const [phone, setPhone] = useState(me.phone ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setFullName(me.full_name); setPhone(me.phone ?? ""); }, [me]);
  const dirty = fullName.trim() !== me.full_name || (phone.trim() || null) !== me.phone;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (fullName.trim().length < 2) return setError("Enter your full name.");
    if (phone && !/^[0-9+\-\s()]{6,20}$/.test(phone.trim())) return setError("Enter a valid phone number.");
    setSaving(true);
    setError(null);
    try {
      setMe(await apiFetch<Me>("/me", { method: "PATCH", body: { full_name: fullName.trim(), phone: phone.trim() } }));
      toast.success("Profile saved.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
      {error && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600 sm:col-span-2" role="alert">{error}</p>}
      <TextField label="Full name" required value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={150} />
      <TextField label="Phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={20} />
      <TextField className="sm:col-span-2" label="Email" value={me.email} disabled hint="Your sign-in email. Ask your administrator if it needs to change." />
      <div className="sm:col-span-2">
        <Button type="submit" loading={saving} disabled={!dirty}>Save changes</Button>
      </div>
    </form>
  );
}

function PasswordForm({ email }: { email: string }) {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (next.length < 8) return setError("The new password needs at least 8 characters.");
    if (next !== confirm) return setError("The new passwords don't match.");
    setSaving(true);
    setError(null);
    const supabase = createClient();
    // Re-check the current password so an unattended, signed-in device can't be used to take over the account.
    const check = await supabase.auth.signInWithPassword({ email, password: current });
    if (check.error) {
      setSaving(false);
      return setError(check.error.code === "invalid_credentials" ? "Your current password is incorrect." : authErrorMessage(check.error));
    }
    const { error } = await supabase.auth.updateUser({ password: next });
    setSaving(false);
    if (error) return setError(authErrorMessage(error));
    setCurrent(""); setNext(""); setConfirm("");
    toast.success("Password changed.");
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4 sm:max-w-md" noValidate>
      {error && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600" role="alert" data-testid="password-error">{error}</p>}
      <TextField label="Current password" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
      <TextField label="New password" type="password" autoComplete="new-password" hint="At least 8 characters" required value={next} onChange={(e) => setNext(e.target.value)} />
      <TextField label="Confirm new password" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      <div><Button type="submit" loading={saving} disabled={!current || !next || !confirm}>Change password</Button></div>
    </form>
  );
}

function NotificationPrefs() {
  const toast = useToast();
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { apiFetch<Preferences>("/notifications/preferences").then(setPrefs).catch((e) => setError(errorMessage(e))); }, []);

  async function toggle(ch: keyof Preferences, on: boolean) {
    if (!prefs) return;
    const next = { ...prefs, [ch]: on };
    setPrefs(next);
    try {
      setPrefs(await apiFetch<Preferences>("/notifications/preferences", { method: "PUT", body: next }));
      toast.success("Saved.");
    } catch (e) { setPrefs(prefs); toast.error(errorMessage(e)); }
  }

  if (error) return <p className="text-sm text-danger-600" role="alert">{error}</p>;
  if (!prefs) return <p className="text-sm text-muted">Loading…</p>;
  const rows: { ch: keyof Preferences; label: string; hint: string }[] = [
    { ch: "email", label: "Email", hint: "To your sign-in email." },
    { ch: "sms", label: "SMS", hint: "To your mobile number, when the school sends SMS." },
    { ch: "whatsapp", label: "WhatsApp", hint: "To your mobile number, when the school uses WhatsApp." },
  ];
  return (
    <div className="space-y-3" data-testid="notification-prefs">
      {rows.map((r) => (
        <label key={r.ch} className="flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-0.5 size-4 accent-leaf-600" checked={prefs[r.ch]} onChange={(e) => void toggle(r.ch, e.target.checked)}
            data-testid={`pref-${r.ch}`} />
          <span><span className="font-medium">{r.label}</span><span className="block text-xs text-muted">{r.hint}</span></span>
        </label>
      ))}
      <p className="text-xs text-muted">Notifications inside the app are always on. Messages are only sent for things the school has switched on.</p>
    </div>
  );
}

export default function ProfilePage() {
  const { me, signOut, currentSchool } = useAuth();
  const [confirmAll, setConfirmAll] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  if (!me) return <LoadingState />;

  return (
    <>
      <PageHeader title="My profile" description="Your details, school access and sign-in security." />
      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-6">
          <Card title="Your details"><DetailsForm me={me} /></Card>
          <Card title="Password"><PasswordForm email={me.email} /></Card>
          {currentSchool && <MyItemsCard schoolId={currentSchool.school_id} />}
        </div>
        <div className="space-y-6">
          <Card title="Access" description="Your schools and roles. Only administrators can change these.">
            {me.is_super_admin && (
              <p className="mb-3 rounded-md bg-pencil-100 px-3 py-2 text-sm font-medium">Platform administrator</p>
            )}
            {me.memberships.length === 0 ? (
              <p className="text-sm text-muted">{me.is_super_admin ? "Not a member of any school." : "You're not linked to a school yet."}</p>
            ) : (
              <ul className="divide-y divide-line" data-testid="memberships">
                {me.memberships.map((m) => (
                  <li key={m.school_id} className="py-3 first:pt-0 last:pb-0">
                    <p className="font-medium">{m.school_name}</p>
                    <p className="text-sm text-muted">
                      {m.roles.map((r) => ROLE_LABELS[r]).join(", ")}
                      {m.school_status === "suspended" && " · school suspended"}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <div id="device">
            <Card title="This device" description="The app on your phone, and notifications even when it's closed.">
              <DeviceSettings />
            </Card>
          </div>
          <div id="notifications">
            <Card title="Notifications" description="How the school may contact you, besides notifications in the app.">
              <NotificationPrefs />
            </Card>
          </div>
          <Card title="Sessions" description="Lost a phone or used a shared computer? Sign out everywhere, including this device.">
            <Button variant="secondary" onClick={() => setConfirmAll(true)}>Sign out of all devices</Button>
          </Card>
        </div>
      </div>
      <ConfirmDialog
        open={confirmAll}
        title="Sign out of all devices?"
        message="Every device signed in to your account, including this one, will need to sign in again."
        confirmLabel="Sign out everywhere"
        loading={signingOut}
        onCancel={() => setConfirmAll(false)}
        onConfirm={async () => { setSigningOut(true); await signOut({ everywhere: true }); }}
      />
    </>
  );
}
