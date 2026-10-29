"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import type { School } from "@/lib/types";

interface Props { school: School | null; onClose: () => void; onInvited: () => void }

export function InviteAdminModal({ school, onClose, onInvited }: Props) {
  const toast = useToast();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setFullName(""); setEmail(""); setError(null); }, [school]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!school) return;
    if (fullName.trim().length < 2) return setError("Enter the administrator's name.");
    if (!/^\S+@\S+\.\S+$/.test(email)) return setError("Enter a valid email.");
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch<{ invited: boolean }>(`/admin/schools/${school.id}/admins`, {
        method: "POST", body: { email: email.trim(), full_name: fullName.trim() },
      });
      toast.success(res.invited ? `Invite sent to ${email.trim()}.` : `${email.trim()} already had an account and is now an admin.`);
      onInvited();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={school !== null}
      onClose={saving ? () => {} : onClose}
      size="sm"
      title="Invite school admin"
      description={school ? `They'll manage ${school.name}.` : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" form="invite-form" loading={saving}>Send invite</Button>
        </>
      }
    >
      <form id="invite-form" onSubmit={onSubmit} className="space-y-4" noValidate>
        {error && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600" role="alert">{error}</p>}
        <TextField label="Full name" required value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={150} />
        <TextField label="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} hint="They'll get an email to set their password." />
      </form>
    </Modal>
  );
}
