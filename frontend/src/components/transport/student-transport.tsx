"use client";

import { Bus, Phone, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDate, formatPhone } from "@/lib/format";
import { formatINR } from "@/lib/money";
import { clock, FREQUENCY_LABEL, showReg, TRIP_LABEL, VEHICLE_TYPE_LABEL, type Assignment, type FamilyTransport, type FamilyTrip } from "@/lib/transport";
import { useAuth } from "@/providers/auth-provider";
import { AssignModal, Section } from "./shared";
import { AssignmentRow } from "./students";

/** The Transport tab on a student's page (admins and accountants). */
export function StudentTransportPanel({ studentId, studentName, schoolId, active }: { studentId: string; studentName: string; schoolId: string; active: boolean }) {
  const { can } = useAuth();
  const toast = useToast();
  const [d, setD] = useState<{ items: Assignment[]; current: Assignment | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);
  const load = useCallback(async () => {
    setError(null);
    try { setD(await apiFetch(`/transport/student/${studentId}`, { schoolId })); } catch (e) { setError(errorMessage(e)); }
  }, [studentId, schoolId]);
  useEffect(() => { void load(); }, [load]);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!d) return <LoadingState />;
  const manage = can("transport:manage") && active;
  return (
    <div role="tabpanel" data-testid="student-transport">
      <Section title="School transport"
        action={manage ? <Button size="sm" onClick={() => setAssigning(true)} data-testid="student-assign"><Plus className="size-4" /> {d.current ? "Move to another stop" : "Assign transport"}</Button> : undefined}>
        {d.items.length === 0 ? (
          <EmptyState icon={Bus} title="Doesn't use school transport" message={manage ? "Assign a route and stop to add transport. The fee is added to the student's dues automatically." : "No transport on record."} />
        ) : (
          <ul className="divide-y divide-line">
            {d.items.map((a) => <AssignmentRow key={a.id} schoolId={schoolId} a={a} showStudent={false} onChange={() => void load()} />)}
          </ul>
        )}
        <p className="border-t border-line px-5 py-3 text-xs text-muted">Transport dues appear with the student&apos;s other fees, only for the months they ride.</p>
      </Section>
      <AssignModal schoolId={schoolId} open={assigning} student={{ id: studentId, name: studentName }} onClose={() => setAssigning(false)}
        onDone={(a) => { setAssigning(false); toast.success(`Assigned to ${a.route_name} · ${a.stop_name}.`); void load(); }} />
    </div>
  );
}

function Contact({ label, name, phone }: { label: string; name: string | null; phone: string | null }) {
  if (!name) return null;
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="font-medium">{name}</dd>
      {phone && <dd><a href={`tel:${phone}`} className="inline-flex items-center gap-1 text-leaf-700 hover:underline"><Phone className="size-3.5" aria-hidden /> {formatPhone(phone)}</a></dd>}
    </div>
  );
}

function TripCard({ t, heading }: { t: FamilyTrip; heading: string }) {
  return (
    <Section title={heading} testId="family-trip">
      <dl className="grid gap-4 p-5 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <div><dt className="text-muted">Route</dt><dd className="font-medium" data-testid="family-route">{t.route_name}{t.route_code ? ` (${t.route_code})` : ""}</dd></div>
        <div><dt className="text-muted">Stop</dt><dd className="font-medium" data-testid="family-stop">{t.stop_name}</dd>{t.landmark && <dd className="text-muted">{t.landmark}</dd>}</div>
        <div><dt className="text-muted">Uses</dt><dd className="font-medium">{TRIP_LABEL[t.trip]}</dd></div>
        {t.trip !== "drop" && <div><dt className="text-muted">Morning pickup</dt><dd className="font-medium" data-testid="family-pickup">{clock(t.pickup_time)}</dd></div>}
        {t.trip !== "pickup" && <div><dt className="text-muted">Afternoon drop</dt><dd className="font-medium">{clock(t.drop_time)}</dd></div>}
        <div><dt className="text-muted">Vehicle</dt><dd className="font-medium">{t.registration_number ? `${showReg(t.registration_number)}${t.vehicle_type ? ` · ${VEHICLE_TYPE_LABEL[t.vehicle_type]}` : ""}` : "To be assigned"}</dd></div>
        <Contact label="Driver" name={t.driver_name} phone={t.driver_phone} />
        <Contact label="Attendant" name={t.attendant_name} phone={t.attendant_phone} />
        <div><dt className="text-muted">Transport fee</dt><dd className="font-medium" data-testid="family-fare">{t.charge_fee && t.fare ? `${formatINR(t.fare)} ${FREQUENCY_LABEL[t.fare_frequency]}` : "No charge"}</dd></div>
        <div><dt className="text-muted">Period</dt><dd className="font-medium">{t.end_date ? `${formatDate(t.start_date)} – ${formatDate(t.end_date)}` : `From ${formatDate(t.start_date)}`}</dd></div>
      </dl>
    </Section>
  );
}

/** Parents and students: the child's route, stop, times, vehicle and the crew's phone numbers. Read only. */
export function FamilyTransportTab({ base, schoolId }: { base: string; schoolId: string }) {
  const [d, setD] = useState<FamilyTransport | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { apiFetch<FamilyTransport>(`${base}/transport`, { schoolId }).then(setD).catch((e) => setError(errorMessage(e))); }, [base, schoolId]);
  if (error) return <ErrorState message={error} />;
  if (!d) return <LoadingState />;
  if (!d.current && d.upcoming.length === 0 && d.history.length === 0) {
    return <div data-testid="family-transport"><EmptyState icon={Bus} title="No school transport" message="This student doesn't use school transport. Contact the school office to arrange it." /></div>;
  }
  return (
    <div className="space-y-6" data-testid="family-transport">
      {d.current ? <TripCard t={d.current} heading="School transport" /> : <p className="rounded-lg border border-line bg-white p-5 text-sm text-muted">Not using school transport at the moment.</p>}
      {d.upcoming.map((t) => <TripCard key={t.id} t={t} heading={`From ${formatDate(t.start_date)}`} />)}
      {d.history.length > 0 && (
        <Section title="Earlier">
          <ul className="divide-y divide-line text-sm">
            {d.history.map((t) => (
              <li key={t.id} className="px-5 py-2.5">{t.route_name} · {t.stop_name} <span className="text-muted">· {formatDate(t.start_date)} – {t.end_date ? formatDate(t.end_date) : "…"}</span></li>
            ))}
          </ul>
        </Section>
      )}
      <p className="text-xs text-muted">Transport fees are shown with your other fees. Live bus tracking isn&apos;t available.</p>
    </div>
  );
}
