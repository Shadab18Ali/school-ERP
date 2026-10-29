"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { AdmissionStepper } from "@/components/admissions/stepper";
import { SchoolHeader } from "@/components/admissions/school-header";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { formatDate, formatDateTime } from "@/lib/format";
import { type AdmissionForm, type ApplicantStatus, inr, publicFetch, STATUS_LABEL } from "@/lib/public-api";

const NEXT_STEP: Record<ApplicantStatus["status"], string> = {
  submitted: "The school has received your application and will review it soon.",
  under_review: "The school is reviewing your application.",
  verified: "Your documents have been verified. The school will announce its decision soon.",
  approved: "Your application has been approved. Please pay the admission fee at the school office to confirm the seat.",
  rejected: "The school could not approve this application.",
  fee_paid: "The admission fee has been received. The school will complete the admission shortly.",
  enrolled: "The admission is complete. Welcome to the school!",
};

export default function TrackPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const [school, setSchool] = useState<AdmissionForm["school"] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [number, setNumber] = useState("");
  const [phone, setPhone] = useState("");
  const [result, setResult] = useState<ApplicantStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const n = new URLSearchParams(window.location.search).get("number");
    if (n) setNumber(n);
    publicFetch<AdmissionForm>(`/public/admissions/${encodeURIComponent(code)}`).then((f) => setSchool(f.school)).catch((e) => setLoadError(e.message));
  }, [code]);

  async function check() {
    setError(null);
    if (number.trim().length < 5) { setError("Enter the application number."); return; }
    if (phone.replace(/\D/g, "").length < 10) { setError("Enter the mobile number given in the application."); return; }
    setBusy(true);
    try {
      setResult(await publicFetch<ApplicantStatus>(`/public/admissions/${encodeURIComponent(code)}/status`, {
        method: "POST", body: { application_number: number.trim(), phone: phone.trim() },
      }));
    } catch (e) { setResult(null); setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <main className="min-h-screen bg-paper px-4 py-8 sm:py-12">
      <div className="mx-auto max-w-3xl">
        {loadError ? (
          <p className="rounded-lg border border-line bg-white p-6 text-sm" role="alert">{loadError === "School not found." ? "We couldn't find this school's admission page. Check the link." : loadError}</p>
        ) : !school ? <p className="text-sm text-muted">Loading…</p> : (
          <>
            <SchoolHeader school={school} />
            <section className="rounded-lg border border-line bg-white p-5 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-semibold">Check application status</h2>
                <Link href={`/apply/${code}`} className="text-sm font-medium text-leaf-700 hover:underline">New application</Link>
              </div>
              <form className="mt-4 grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); void check(); }} noValidate>
                <TextField label="Application number" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="ADM2026-00001" maxLength={30} />
                <TextField label="Mobile number" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} hint="The contact mobile given in the application" maxLength={20} />
                <Button type="submit" loading={busy} data-testid="check-status" className="sm:mb-5">Check status</Button>
              </form>
              {error && <p className="mt-3 rounded-md bg-danger-50 p-3 text-sm text-danger-600" role="alert" data-testid="track-error">{error}</p>}
            </section>

            {result && (
              <section className="mt-5 space-y-5 rounded-lg border border-line bg-white p-5 sm:p-6" data-testid="track-result">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm text-muted">Application {result.application_number}</p>
                    <h2 className="text-lg font-semibold">{result.student_name}</h2>
                    <p className="text-sm text-muted">{result.class_name} · {result.session_name} · submitted {formatDate(result.submitted_at)}</p>
                  </div>
                  <span className={result.status === "rejected" ? "rounded-full bg-danger-50 px-3 py-1 text-sm font-medium text-danger-600" : "rounded-full bg-leaf-50 px-3 py-1 text-sm font-medium text-leaf-700"}
                    data-testid="track-status">{STATUS_LABEL[result.status]}</span>
                </div>
                <AdmissionStepper status={result.status} history={(result.timeline ?? []).map((t) => t.status)} />
                <p className="rounded-md bg-pencil-100/60 p-3 text-sm">{NEXT_STEP[result.status]}</p>
                {result.status === "rejected" && result.rejection_reason && (
                  <p className="text-sm" data-testid="track-reason"><span className="font-medium">Reason: </span>{result.rejection_reason}</p>
                )}
                {result.status === "approved" && (
                  <div className="rounded-md border border-line p-4 text-sm" data-testid="track-fee">
                    <p><span className="font-medium">Admission fee: </span>{inr(result.fee_amount)}</p>
                    <p className="mt-1 text-muted">Pay at the school office{result.school_phone ? ` (call ${result.school_phone} for timings)` : ""}. You will get a receipt.</p>
                    {result.instructions && <p className="mt-2">{result.instructions}</p>}
                  </div>
                )}
                {result.fee_receipt_number && (
                  <p className="text-sm">Fee of {inr(result.fee_amount)} paid on {formatDate(result.fee_paid_on)} · receipt <span className="font-medium">{result.fee_receipt_number}</span></p>
                )}
                <div>
                  <h3 className="text-sm font-semibold">History</h3>
                  <ul className="mt-2 space-y-2 border-l-2 border-line pl-4 text-sm" data-testid="track-timeline">
                    {(result.timeline ?? []).map((t, i) => (
                      <li key={i}>
                        <span className="font-medium">{STATUS_LABEL[t.status]}</span> <span className="text-muted">· {formatDateTime(t.at)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
