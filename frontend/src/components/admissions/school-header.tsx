import type { AdmissionForm } from "@/lib/public-api";

export function SchoolHeader({ school }: { school: AdmissionForm["school"] }) {
  return (
    <header className="mb-6 flex items-center gap-4">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {school.logo_url ? <img src={school.logo_url} alt="" className="size-14 rounded-md object-contain" />
        : <div className="grid size-14 place-items-center rounded-md bg-leaf-600 text-xl font-bold text-white">{school.name[0]}</div>}
      <div>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{school.name}</h1>
        <p className="text-sm text-muted">{[school.address, school.city, school.state].filter(Boolean).join(", ") || "Online admission"}</p>
      </div>
    </header>
  );
}
