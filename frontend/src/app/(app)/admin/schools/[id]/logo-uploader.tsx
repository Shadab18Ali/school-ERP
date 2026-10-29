"use client";

import { ImagePlus, Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import type { School } from "@/lib/types";

const MAX_BYTES = 2 * 1024 * 1024;
const TYPES = ["image/png", "image/jpeg", "image/webp"];

export function LogoUploader({ school, onChange }: { school: School; onChange: (s: School) => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    if (!TYPES.includes(file.type)) return toast.error("Use a PNG, JPEG or WebP image.");
    if (file.size > MAX_BYTES) return toast.error("The logo must be 2 MB or smaller.");
    const body = new FormData();
    body.append("file", file);
    setBusy(true);
    try {
      onChange(await apiFetch<School>(`/admin/schools/${school.id}/logo`, { method: "POST", body }));
      toast.success("Logo updated.");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function remove() {
    setBusy(true);
    try {
      onChange(await apiFetch<School>(`/admin/schools/${school.id}/logo`, { method: "DELETE" }));
      toast.success("Logo removed.");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-center gap-1.5">
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={busy}
        className="group relative grid size-20 place-items-center overflow-hidden rounded-xl border border-line bg-paper text-muted hover:border-leaf-600"
        aria-label={school.logo_url ? "Change logo" : "Upload logo"}
      >
        {school.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={school.logo_url} alt={`${school.name} logo`} className="size-full object-contain p-1.5" data-testid="school-logo" />
        ) : (
          <ImagePlus className="size-7" aria-hidden />
        )}
        {busy && <span className="absolute inset-0 grid place-items-center bg-white/70"><Loader2 className="size-5 animate-spin" /></span>}
      </button>
      <input
        ref={input}
        type="file"
        aria-label="School logo"
        accept={TYPES.join(",")}
        className="sr-only"
        data-testid="logo-input"
        onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
      />
      {school.logo_url ? (
        <button type="button" onClick={remove} disabled={busy} className="text-xs text-muted hover:text-danger-600">Remove</button>
      ) : (
        <span className="text-xs text-muted">Add logo</span>
      )}
    </div>
  );
}
