"use client";

import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatINR, MONTH_NAMES } from "@/lib/money";

const INK = "#5d6b67";
const LEAF = "#2f6b57";
const PENCIL = "#f2c230";
const LINE = "#dfe4e1";

function Figure({ title, summary, children, table }: { title: string; summary: string; children: React.ReactNode; table: React.ReactNode }) {
  return (
    <figure className="rounded-lg border border-line bg-white p-5" aria-label={title}>
      <figcaption className="mb-1 font-semibold">{title}</figcaption>
      <p className="mb-3 text-xs text-muted">{summary}</p>
      <div className="h-56" aria-hidden>{children}</div>
      <div className="sr-only">{table}</div>
    </figure>
  );
}

const monthTick = (iso: string) => `${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]} ${iso.slice(2, 4)}`;

export function MonthlyCollectionChart({ data }: { data: { month: string; amount: string }[] }) {
  const points = data.map((d) => ({ month: d.month, label: monthTick(d.month), amount: Number(d.amount) })); // display only
  return (
    <Figure title="Monthly fee collection" summary="Receipts per month in this session."
      table={<table><thead><tr><th>Month</th><th>Collected</th></tr></thead><tbody>{data.map((d) => <tr key={d.month}><td>{monthTick(d.month)}</td><td>{formatINR(d.amount)}</td></tr>)}</tbody></table>}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={points} margin={{ left: 0, right: 8, top: 4 }}>
          <CartesianGrid vertical={false} stroke={LINE} />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: INK }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 11, fill: INK }} tickLine={false} axisLine={false} width={56}
            tickFormatter={(v: number) => (v >= 100000 ? `${(v / 100000).toFixed(1)}L` : v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} />
          <Tooltip formatter={(v: number) => [formatINR(String(v)), "Collected"]} cursor={{ fill: "#eef5f1" }} />
          <Bar dataKey="amount" fill={LEAF} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </Figure>
  );
}

export function AttendanceTrendChart({ data }: { data: { date: string; percentage: string; marked: number }[] }) {
  const points = data.map((d) => ({ label: `${Number(d.date.slice(8))} ${MONTH_NAMES[Number(d.date.slice(5, 7)) - 1]}`, pct: Number(d.percentage), marked: d.marked }));
  return (
    <Figure title="Attendance trend" summary="School-wide % present on each day marked, last 30 days."
      table={<table><thead><tr><th>Day</th><th>% present</th></tr></thead><tbody>{points.map((p) => <tr key={p.label}><td>{p.label}</td><td>{p.pct}%</td></tr>)}</tbody></table>}>
      {points.length === 0 ? <p className="grid h-full place-items-center text-sm text-muted">No attendance marked in the last 30 days.</p> : (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ left: 0, right: 8, top: 4 }}>
            <CartesianGrid vertical={false} stroke={LINE} />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: INK }} tickLine={false} axisLine={false} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: INK }} tickLine={false} axisLine={false} width={36} tickFormatter={(v: number) => `${v}%`} />
            <Tooltip formatter={(v: number) => [`${v}%`, "Present"]} />
            <Line type="monotone" dataKey="pct" stroke={LEAF} strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </Figure>
  );
}

export function EnrollmentChart({ data }: { data: { class_name: string; students: number; boys: number; girls: number }[] }) {
  const points = data.map((d) => ({ ...d, other: d.students - d.boys - d.girls }));
  return (
    <Figure title="Student enrollment" summary="Active students in each class this session."
      table={<table><thead><tr><th>Class</th><th>Students</th><th>Boys</th><th>Girls</th></tr></thead><tbody>{data.map((d) => <tr key={d.class_name}><td>{d.class_name}</td><td>{d.students}</td><td>{d.boys}</td><td>{d.girls}</td></tr>)}</tbody></table>}>
      {points.length === 0 ? <p className="grid h-full place-items-center text-sm text-muted">No students enrolled yet.</p> : (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={points} margin={{ left: 0, right: 8, top: 4 }}>
            <CartesianGrid vertical={false} stroke={LINE} />
            <XAxis dataKey="class_name" tick={{ fontSize: 11, fill: INK }} tickLine={false} axisLine={false} interval={0} />
            <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: INK }} tickLine={false} axisLine={false} width={32} />
            <Tooltip />
            <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="girls" name="Girls" stackId="a" fill={LEAF} />
            <Bar dataKey="boys" name="Boys" stackId="a" fill={PENCIL} />
            {points.some((p) => p.other > 0) && <Bar dataKey="other" name="Other" stackId="a" fill={INK} />}
          </BarChart>
        </ResponsiveContainer>
      )}
    </Figure>
  );
}
