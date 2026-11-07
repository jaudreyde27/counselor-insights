import Link from "next/link";
import { EmptyState, FunnelIcon, SmallCaps, SortIcon, primaryButton, secondaryButton } from "@/components/ui";
import { requireCounselor } from "@/lib/auth";
import { withCounselor } from "@/lib/db";
import { formatDate } from "@/lib/data/format";
import { listStudents } from "@/lib/data/students";
import { DEGREE_TYPES, SCHOOLS, SESSION_COUNT_FILTERS, degreeLabel, isDegreeType, isSchool } from "@/lib/student-options";

type Search = { school?: string; degree?: string; sessions?: string; sort?: string };
type FilterField = "school" | "degree" | "sessions";
const FILTER_FIELDS: FilterField[] = ["school", "degree", "sessions"];

// Seven columns, spread left to right across the available width. The header and every row use
// the same fixed column widths (minmax(0, …)) so a long value can never push a column out of line
// with its title, and each title is centered over its column. They follow the width of the
// list's own container (not the window), so they also spread in a narrow side pane.
const COLS =
  "@xl:grid @xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1.35fr)_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.15fr)_minmax(0,1.1fr)_minmax(0,1.2fr)] @xl:gap-2 @3xl:gap-3 @xl:text-center";

/** A funnel icon that opens a small native dropdown filter (no JavaScript needed). */
function Filter({
  field,
  label,
  options,
  current,
  search,
}: {
  field: FilterField;
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  current?: string;
  search: Search;
}) {
  const others = FILTER_FIELDS.filter((f) => f !== field);
  return (
    <details className="relative">
      <summary className="flex cursor-pointer list-none items-center gap-1 hover:text-ink @xl:justify-center" aria-label={`Filter by ${label}`}>
        {label}
        <span className={current ? "text-accent-dark" : ""}>
          <FunnelIcon />
        </span>
      </summary>
      <form className="absolute left-0 top-6 z-10 w-60 @xl:left-1/2 @xl:-translate-x-1/2 space-y-2 rounded-lg border border-line bg-surface p-3 text-sm font-normal normal-case tracking-normal text-ink shadow-sm">
        {search.sort && <input type="hidden" name="sort" value={search.sort} />}
        {others.map((o) => search[o] && <input key={o} type="hidden" name={o} value={search[o]} />)}
        <select name={field} defaultValue={current ?? ""} className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm">
          <option value="">All</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button className={`${secondaryButton} w-full`}>Apply</button>
      </form>
    </details>
  );
}

export default async function StudentsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const counselor = await requireCounselor();
  const raw = await searchParams;
  // Only known filter values are used; anything else is ignored.
  const search: Search = {
    school: raw.school && isSchool(raw.school) ? raw.school : undefined,
    degree: raw.degree && isDegreeType(raw.degree) ? raw.degree : undefined,
    sessions: SESSION_COUNT_FILTERS.some((o) => o.value === raw.sessions) ? raw.sessions : undefined,
    sort: raw.sort === "asc" ? "asc" : raw.sort === "desc" ? "desc" : undefined,
  };
  const sort = search.sort === "asc" ? "asc" : "desc";
  const { students, anyStudents } = await withCounselor(counselor.id, async (c) => ({
    students: await listStudents(c, { school: search.school, degree: search.degree, sessions: search.sessions, sort }),
    anyStudents: ((await c.query("SELECT 1 FROM students LIMIT 1")).rowCount ?? 0) > 0,
  }));

  const schoolOptions = SCHOOLS.map((s) => ({ value: s, label: s }));
  const degreeOptions = DEGREE_TYPES.map((d) => ({ value: d.value, label: d.label }));
  const sessionOptions = SESSION_COUNT_FILTERS.map((o) => ({ value: o.value, label: o.label }));
  const sortHref = `/students?${new URLSearchParams({
    ...(search.school ? { school: search.school } : {}),
    ...(search.degree ? { degree: search.degree } : {}),
    ...(search.sessions ? { sessions: search.sessions } : {}),
    sort: sort === "desc" ? "asc" : "desc",
  })}`;
  const filtered = Boolean(search.school || search.degree || search.sessions);

  const filters = (
    <>
      <Filter field="school" label="School" options={schoolOptions} current={search.school} search={search} />
      <Filter field="degree" label="Degree" options={degreeOptions} current={search.degree} search={search} />
      <Filter field="sessions" label="Sessions" options={sessionOptions} current={search.sessions} search={search} />
    </>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <SmallCaps accent>Counselor account</SmallCaps>
          <h1 className="mt-1 text-2xl font-semibold">{counselor.displayName}&apos;s students</h1>
          <p className="text-sm text-muted">{counselor.email}</p>
        </div>
        <Link href="/students/new" className={primaryButton}>
          New Student
        </Link>
      </div>

      {!anyStudents ? (
        <EmptyState
          action={
            <Link href="/students/new" className={primaryButton}>
              New Student
            </Link>
          }
        >
          No students yet. Add your first student to get started.
        </EmptyState>
      ) : (
        <div className="@container">
          <div className={`hidden px-[13px] pb-2 text-[11px] font-semibold uppercase tracking-wide text-muted @3xl:px-[17px] @3xl:text-xs ${COLS}`}>
            <span>Name</span>
            <Filter field="school" label="School" options={schoolOptions} current={search.school} search={search} />
            <Filter field="degree" label="Degree" options={degreeOptions} current={search.degree} search={search} />
            <span>Program of study</span>
            <span>Country</span>
            <Filter field="sessions" label="Sessions" options={sessionOptions} current={search.sessions} search={search} />
            <Link href={sortHref} className="flex items-center gap-1 hover:text-ink @xl:justify-center">
              Last session <SortIcon dir={sort} />
            </Link>
          </div>
          {/* On phones the column headers hide, so the filters sit in a small row instead. */}
          <div className="mb-2 flex flex-wrap gap-4 px-1 text-xs font-semibold uppercase tracking-wide text-muted @xl:hidden">
            {filters}
            <Link href={sortHref} className="flex items-center gap-1">
              Last session <SortIcon dir={sort} />
            </Link>
          </div>

          {students.length === 0 ? (
            <EmptyState
              action={
                filtered && (
                  <Link href="/students" className={secondaryButton}>
                    Clear filters
                  </Link>
                )
              }
            >
              No students match these filters.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {students.map((s) => (
                <li key={s.id}>
                  <Link
                    href={`/students/${s.id}`}
                    className={`flex flex-wrap gap-x-3 px-4 py-3.5 text-sm hover:bg-accent-soft @xl:items-center @xl:px-3 @xl:text-[13px] @3xl:px-4 @3xl:text-sm ${COLS}`}
                  >
                    <span className="w-full font-medium @xl:w-auto">{s.full_name}</span>
                    <span className="w-full text-muted @xl:w-auto @xl:text-ink">{s.school}</span>
                    <span className="text-muted @xl:text-ink">{degreeLabel(s.degree_type)}</span>
                    <span className="text-muted @xl:text-ink">{s.program_of_study}</span>
                    <span className="text-muted @xl:text-ink">{s.country_of_origin}</span>
                    <span className="hidden @xl:block">{s.session_count}</span>
                    <span className="w-full whitespace-nowrap text-muted @xl:w-auto @xl:text-ink">
                      <span className="@xl:hidden">
                        {s.session_count} {s.session_count === 1 ? "session" : "sessions"} ·{" "}
                      </span>
                      {formatDate(s.last_session)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
