"use client";

import { Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  activeDot, axis, barEnd, barTop, ChartCard, Grid2, grid, gridH, Kpi, KpiRow, lineCursor, lineDot, Section, Tip, tipCursor,
} from "@/components/analytics/chart-kit";
import { dayShort, fmtInt, fmtPct, INK, plural, monthShort, RAMP, SERIES, type StudentAnalytics } from "@/lib/analytics";
import { formatDate } from "@/lib/format";

const pctAxis = { ...axis, domain: [0, 100] as [number, number], ticks: [0, 25, 50, 75, 100], tickFormatter: (v: number) => `${v}%` };
const n = (v: number | null) => fmtInt(v);
const p = (v: number | null) => fmtPct(v);
const rowsH = (count: number) => Math.max(160, count * 32 + 36);

export function StudentsTab({ data }: { data: StudentAnalytics }) {
  const { enrollment: en, strength: st, attendance: at, performance: pf } = data;
  const k = en.kpis;
  const continuing = k.enrolled_all - k.new_students;
  const below75 = at.bands.find((b) => b.band.startsWith("Below"))?.students ?? 0;
  const anyOther = st.classes.some((c) => c.other > 0);
  const strengthSeries = [
    { key: "girls", name: "Girls", color: SERIES[0] },
    { key: "boys", name: "Boys", color: SERIES[1] },
    ...(anyOther ? [{ key: "other", name: "Other", color: SERIES[2] }] : []),
  ];
  const range = `${formatDate(at.from)} – ${formatDate(at.to)}`;

  return (
    <>
      <Section title="Enrollment">
        <KpiRow>
          <Kpi label="Active students" value={n(k.students)} testId="kpi-students"
            hint={`${plural(k.girls, "girl")} · ${plural(k.boys, "boy")}${k.other ? ` · ${n(k.other)} other` : ""}`} />
          <Kpi label="New this session" value={n(k.new_students)} hint={`${n(continuing)} continuing from earlier sessions`} testId="kpi-new" />
          <Kpi label="Enrolled this session" value={n(k.enrolled_all)} hint="Everyone placed in a class, including those who left" />
          <Kpi label="Left during the session" value={n(k.left)} hint="Enrolled, now inactive" testId="kpi-left" />
        </KpiRow>
        <Grid2>
          <ChartCard title="Enrollment by session" testId="chart-enrollment-trend"
            summary="Students enrolled in each session: new to the school, and continuing from an earlier session."
            legend={[{ name: "Continuing", color: SERIES[1] }, { name: "New", color: SERIES[0] }]}
            columns={[{ label: "Session" }, { label: "Enrolled", numeric: true }, { label: "New", numeric: true }, { label: "Continuing", numeric: true }]}
            rows={en.trend.map((t) => [t.session, t.enrolled, t.new_students, t.continuing])}
            empty={en.trend.length ? null : "No enrollments yet."}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={en.trend} margin={{ top: 16, right: 8, left: -8 }} barCategoryGap="30%">
                <CartesianGrid {...grid} />
                <XAxis dataKey="session" {...axis} interval={0} />
                <YAxis {...axis} allowDecimals={false} width={44} />
                <Tooltip cursor={tipCursor} content={<Tip format={n} />} />
                <Bar isAnimationActive={false} dataKey="continuing" name="Continuing" stackId="e" fill={SERIES[1]} stroke="#fff" strokeWidth={1} maxBarSize={56} />
                <Bar isAnimationActive={false} dataKey="new_students" name="New" stackId="e" fill={SERIES[0]} stroke="#fff" strokeWidth={1} radius={barTop} maxBarSize={56}>
                  <LabelList dataKey="enrolled" position="top" fontSize={11} fill={INK} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
          <ChartCard title="New admissions by month" testId="chart-admissions-month"
            summary="New students by admission month (those admitted before the session count in its first month)."
            columns={[{ label: "Month" }, { label: "New students", numeric: true }]}
            rows={en.admissions_by_month.map((m) => [monthShort(m.month), m.new_students])}
            empty={en.admissions_by_month.some((m) => m.new_students > 0) ? null : "No new students this session."}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={en.admissions_by_month} margin={{ top: 8, right: 8, left: -8 }}>
                <CartesianGrid {...grid} />
                <XAxis dataKey="month" tickFormatter={monthShort} {...axis} />
                <YAxis {...axis} allowDecimals={false} width={44} />
                <Tooltip cursor={tipCursor} content={<Tip format={n} title={(l) => monthShort(String(l))} />} />
                <Bar isAnimationActive={false} dataKey="new_students" name="New students" fill={SERIES[0]} radius={barTop} maxBarSize={28} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </Grid2>
      </Section>

      <Section title="Class strength">
        <KpiRow>
          <Kpi label="Sections" value={n(st.sections)} />
          <Kpi label="Average per section" value={st.average_section === null ? "—" : String(st.average_section)} hint="Active students" />
          <Kpi label="Seats" value={n(st.capacity)} hint={st.capacity ? "In sections with a capacity set" : "No section has a capacity set"} />
          <Kpi label="Seats filled" value={p(st.fill_percent)} hint="Students in those sections ÷ their seats" testId="kpi-fill" />
        </KpiRow>
        <ChartCard title="Students in each class" testId="chart-strength"
          summary="Active students by class. Hover a class for its sections and seats."
          legend={strengthSeries.map((s) => ({ name: s.name, color: s.color }))}
          columns={[{ label: "Class" }, { label: "Students", numeric: true }, { label: "Girls", numeric: true }, { label: "Boys", numeric: true },
            { label: "Other", numeric: true }, { label: "Sections", numeric: true }, { label: "Seats", numeric: true }, { label: "Filled", numeric: true, format: (v) => p(v as number | null) }]}
          rows={st.classes.map((c) => [c.class, c.students, c.girls, c.boys, c.other, c.sections, c.capacity, c.fill_percent])}
          empty={st.classes.length ? null : "No classes with sections in this session."} px={rowsH(st.classes.length)}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={st.classes} layout="vertical" margin={{ top: 0, right: 40, left: 8 }} barCategoryGap="25%">
              <CartesianGrid {...gridH} />
              <XAxis type="number" {...axis} allowDecimals={false} />
              <YAxis type="category" dataKey="class" {...axis} width={88} interval={0} />
              <Tooltip cursor={tipCursor} content={<Tip format={n} extra={(r) => {
                const c = r as unknown as StudentAnalytics["strength"]["classes"][number];
                return <>
                  {c.detail.map((s) => <div key={s.section_id}>Section {s.section}: {s.students}{s.capacity ? ` of ${s.capacity} seats` : ""}</div>)}
                  {c.fill_percent !== null && <div className="font-medium text-ink">{c.fill_percent}% of seats filled</div>}
                </>;
              }} />} />
              {strengthSeries.map((s, i) => (
                <Bar isAnimationActive={false} key={s.key} dataKey={s.key} name={s.name} stackId="s" fill={s.color} stroke="#fff" strokeWidth={1} maxBarSize={22}
                  radius={i === strengthSeries.length - 1 ? barEnd : undefined}>
                  {i === strengthSeries.length - 1 && <LabelList dataKey="students" position="right" fontSize={11} fill={INK} />}
                </Bar>
              ))}
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </Section>

      <Section title="Attendance">
        <KpiRow>
          <Kpi label="Attendance" value={p(at.percent)} hint={range} testId="kpi-attendance" />
          <Kpi label="Days marked" value={n(at.days_marked)} hint={`${n(at.present)} present · ${n(at.absent)} absent · ${n(at.leave)} leave`} />
          <Kpi label="Students counted" value={n(at.students_counted)} hint="Active students with attendance marked" />
          <Kpi label="Below 75%" value={n(below75)} hint="Active students" tone={below75 ? "warn" : undefined} testId="kpi-below75" />
        </KpiRow>
        <Grid2>
          <ChartCard title="Attendance by month" testId="chart-attendance-month"
            summary="% present each month: present ÷ (present + absent + leave) on the days marked."
            columns={[{ label: "Month" }, { label: "Present", numeric: true }, { label: "Absent", numeric: true }, { label: "Leave", numeric: true },
              { label: "% present", numeric: true, format: (v) => p(v as number | null) }]}
            rows={at.monthly.map((m) => [monthShort(m.month), m.present, m.absent, m.leave, m.percent])}
            empty={at.days_marked ? null : "No attendance marked in this period."}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={at.monthly} margin={{ top: 8, right: 12, left: -8 }}>
                <CartesianGrid {...grid} />
                <XAxis dataKey="month" tickFormatter={monthShort} {...axis} />
                <YAxis {...pctAxis} width={44} />
                <Tooltip cursor={lineCursor} content={<Tip format={p} title={(l) => monthShort(String(l))}
                  extra={(r) => `${fmtInt(r.present as number)} present of ${fmtInt((r.present as number) + (r.absent as number) + (r.leave as number))}`} />} />
                <Line dataKey="percent" name="% present" stroke={SERIES[0]} strokeWidth={2} dot={lineDot(SERIES[0])} activeDot={activeDot(SERIES[0])} connectNulls={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
          <ChartCard title="Daily attendance" testId="chart-attendance-daily"
            summary={`School-wide % present on each day marked (last ${at.daily.length} in the period).`}
            columns={[{ label: "Day" }, { label: "Students marked", numeric: true }, { label: "% present", numeric: true, format: (v) => p(v as number | null) }]}
            rows={at.daily.map((d) => [formatDate(d.date), d.marked, d.percent])}
            empty={at.daily.length ? null : "No attendance marked in this period."}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={at.daily} margin={{ top: 8, right: 12, left: -8 }}>
                <CartesianGrid {...grid} />
                <XAxis dataKey="date" tickFormatter={dayShort} {...axis} minTickGap={24} />
                <YAxis {...pctAxis} width={44} />
                <Tooltip cursor={lineCursor} content={<Tip format={p} title={(l) => formatDate(String(l))} extra={(r) => `${fmtInt(r.marked as number)} students marked`} />} />
                <Line dataKey="percent" name="% present" stroke={SERIES[0]} strokeWidth={2}
                  dot={at.daily.length <= 31 ? lineDot(SERIES[0]) : false} activeDot={activeDot(SERIES[0])} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
          <ChartCard title="Attendance by class" testId="chart-attendance-class"
            summary="% present in each class over the period."
            columns={[{ label: "Class" }, { label: "Marks", numeric: true }, { label: "% present", numeric: true, format: (v) => p(v as number | null) }]}
            rows={at.by_class.map((c) => [c.class, c.marked, c.percent])}
            empty={at.by_class.length ? null : "No attendance marked in this period."} px={rowsH(at.by_class.length)}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={at.by_class} layout="vertical" margin={{ top: 0, right: 48, left: 8 }}>
                <CartesianGrid {...gridH} />
                <XAxis type="number" {...pctAxis} />
                <YAxis type="category" dataKey="class" {...axis} width={88} interval={0} />
                <Tooltip cursor={tipCursor} content={<Tip format={p} extra={(r) => `${fmtInt(r.marked as number)} attendance marks`} />} />
                <Bar isAnimationActive={false} dataKey="percent" name="% present" fill={SERIES[0]} radius={barEnd} maxBarSize={20}>
                  <LabelList dataKey="percent" position="right" fontSize={11} fill={INK} formatter={(v: number) => `${v}%`} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
          <ChartCard title="Students by attendance" testId="chart-attendance-bands"
            summary="Active students grouped by their own attendance % in the period."
            columns={[{ label: "Attendance" }, { label: "Students", numeric: true }]}
            rows={at.bands.map((b) => [b.band, b.students])}
            empty={at.students_counted ? null : "No attendance marked in this period."}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={at.bands} margin={{ top: 16, right: 8, left: -8 }}>
                <CartesianGrid {...grid} />
                <XAxis dataKey="band" {...axis} interval={0} />
                <YAxis {...axis} allowDecimals={false} width={44} />
                <Tooltip cursor={tipCursor} content={<Tip format={n} />} />
                <Bar isAnimationActive={false} dataKey="students" name="Students" radius={barTop} maxBarSize={56}>
                  {at.bands.map((b, i) => <Cell key={b.band} fill={RAMP[3 - i] ?? RAMP[0]} />)}
                  <LabelList dataKey="students" position="top" fontSize={11} fill={INK} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </Grid2>
      </Section>

      <Section title={`Performance${pf.exam_name ? `: ${pf.exam_name}` : ""}`}>
        {pf.exam_id === null ? (
          <p className="rounded-lg border border-line bg-white p-6 text-center text-sm text-muted" data-testid="no-exam-marks">
            No exam in this session has marks yet. Results appear here once teachers enter marks.
          </p>
        ) : <>
          <KpiRow>
            <Kpi label="Average score" value={p(pf.average_percent)} hint="Students with every paper marked" testId="kpi-average" />
            <Kpi label="Pass rate" value={p(pf.pass_rate)} hint={`${n(pf.passed)} passed · ${n(pf.failed)} failed or absent`} testId="kpi-pass" />
            <Kpi label="Complete results" value={n(pf.complete)} hint={`of ${n(pf.students)} students with marks`} />
            <Kpi label="Incomplete" value={n(pf.incomplete)} hint="Some papers still without marks; left out of averages" />
          </KpiRow>
          <Grid2>
            <ChartCard title="Average by subject" testId="chart-subjects"
              summary="Average % per paper. Absent students count as 0 here and as failed in the pass rate."
              columns={[{ label: "Subject" }, { label: "Sat", numeric: true }, { label: "Absent", numeric: true },
                { label: "Average %", numeric: true, format: (v) => p(v as number | null) }, { label: "Pass rate", numeric: true, format: (v) => p(v as number | null) }]}
              rows={pf.by_subject.map((s) => [s.subject, s.sat, s.absent, s.average_percent, s.pass_rate])}
              empty={pf.by_subject.length ? null : "No marks entered."} px={rowsH(pf.by_subject.length)}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={pf.by_subject} layout="vertical" margin={{ top: 0, right: 48, left: 8 }}>
                  <CartesianGrid {...gridH} />
                  <XAxis type="number" {...pctAxis} />
                  <YAxis type="category" dataKey="subject" {...axis} width={96} interval={0} />
                  <Tooltip cursor={tipCursor} content={<Tip format={p} extra={(r) => `Pass rate ${fmtPct(r.pass_rate as number | null)} · ${fmtInt(r.sat as number)} sat, ${fmtInt(r.absent as number)} absent`} />} />
                  <Bar isAnimationActive={false} dataKey="average_percent" name="Average" fill={SERIES[0]} radius={barEnd} maxBarSize={20}>
                    <LabelList dataKey="average_percent" position="right" fontSize={11} fill={INK} formatter={(v: number) => `${v}%`} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
            <ChartCard title="Results by class" testId="chart-results-class"
              summary="Average % and pass rate of each class's complete results."
              legend={[{ name: "Average", color: SERIES[0] }, { name: "Pass rate", color: SERIES[1] }]}
              columns={[{ label: "Class" }, { label: "Students", numeric: true }, { label: "Average %", numeric: true, format: (v) => p(v as number | null) },
                { label: "Pass rate", numeric: true, format: (v) => p(v as number | null) }]}
              rows={pf.by_class.map((c) => [c.class, c.students, c.average_percent, c.pass_rate])}
              empty={pf.by_class.length ? null : "No complete results yet."}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={pf.by_class} margin={{ top: 8, right: 8, left: -8 }} barGap={2}>
                  <CartesianGrid {...grid} />
                  <XAxis dataKey="class" {...axis} interval={0} />
                  <YAxis {...pctAxis} width={44} />
                  <Tooltip cursor={tipCursor} content={<Tip format={p} extra={(r) => `${fmtInt(r.students as number)} students`} />} />
                  <Bar isAnimationActive={false} dataKey="average_percent" name="Average" fill={SERIES[0]} radius={barTop} barSize={24} />
                  <Bar isAnimationActive={false} dataKey="pass_rate" name="Pass rate" fill={SERIES[1]} radius={barTop} barSize={24} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
            <ChartCard title="Grades" testId="chart-grades"
              summary="Students by overall grade, from the school's grade bands."
              columns={[{ label: "Grade" }, { label: "From %", numeric: true }, { label: "Students", numeric: true }]}
              rows={pf.grades.map((g) => [g.grade, g.min_percent, g.students])}
              empty={pf.grades.length ? null : "No grade bands set up (Exams → Grades)."}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={pf.grades} margin={{ top: 16, right: 8, left: -8 }}>
                  <CartesianGrid {...grid} />
                  <XAxis dataKey="grade" {...axis} interval={0} />
                  <YAxis {...axis} allowDecimals={false} width={44} />
                  <Tooltip cursor={tipCursor} content={<Tip format={n} title={(l, r) => `Grade ${l} (${r?.min_percent}% and above)`} />} />
                  <Bar isAnimationActive={false} dataKey="students" name="Students" fill={SERIES[0]} radius={barTop} maxBarSize={40}>
                    <LabelList dataKey="students" position="top" fontSize={11} fill={INK} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
            <ChartCard title="Across exams" testId="chart-exam-trend"
              summary="Average % and pass rate in each exam of the session that has marks."
              legend={[{ name: "Average", color: SERIES[0] }, { name: "Pass rate", color: SERIES[1] }]}
              columns={[{ label: "Exam" }, { label: "Students", numeric: true }, { label: "Average %", numeric: true, format: (v) => p(v as number | null) },
                { label: "Pass rate", numeric: true, format: (v) => p(v as number | null) }]}
              rows={pf.trend.map((t) => [t.exam, t.students, t.average_percent, t.pass_rate])}
              empty={pf.trend.length ? null : "No exams with marks."}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={pf.trend} margin={{ top: 8, right: 16, left: -8 }}>
                  <CartesianGrid {...grid} />
                  <XAxis dataKey="exam" {...axis} interval={0} padding={{ left: 24, right: 24 }} />
                  <YAxis {...pctAxis} width={44} />
                  <Tooltip cursor={lineCursor} content={<Tip format={p} />} />
                  <Line dataKey="average_percent" name="Average" stroke={SERIES[0]} strokeWidth={2} dot={lineDot(SERIES[0])} activeDot={activeDot(SERIES[0])} isAnimationActive={false} />
                  <Line dataKey="pass_rate" name="Pass rate" stroke={SERIES[1]} strokeWidth={2} dot={lineDot(SERIES[1])} activeDot={activeDot(SERIES[1])} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>
          </Grid2>
        </>}
      </Section>
    </>
  );
}
