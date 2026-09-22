import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ColumnCounts } from '../bindings/ipc/ColumnCounts';
import type { ProfileChart } from '../bindings/ipc/ProfileChart';
import type { HistogramBucket } from '../bindings/ipc/HistogramBucket';
import type { ValueCount } from '../bindings/ipc/ValueCount';
import { formatCellValue } from '../lib/format';
import { cancelProfile, nextProfileRequestId } from '../lib/profile-request';
import { toErrorMessage } from '../lib/tauri';
import { assertNever } from '../lib/exhaustive';
import type { ProfileCondition } from '../lib/filter-sql';

export interface ColumnProfileViewProps {
  /** The column's name, as its own grid shows it. */
  name: string;
  /** What is written under the name: the column's type. */
  typeLabel: string;
  /**
   * How a condition names this column. Not always its name: a query
   * result addresses its columns by position, since two of them may share
   * a name and an expression's name is not an identifier.
   */
  columnRef: string;
  /**
   * What the panel is a profile of, in one string. The panel starts over
   * when it changes, so an old chart can never apply a value to rows it
   * did not describe.
   */
  requestKey: string;
  /**
   * Ask for the counts. Called once per `requestKey`, with the id the panel
   * cancels it by if it stops waiting.
   */
  loadCounts: (requestId: string) => Promise<ColumnCounts>;
  /**
   * Ask for the chart those counts call for, under the same id. It is a
   * second scan, and on a large column a far longer one, which is why the
   * panel shows the counts without waiting for it.
   */
  loadChart: (requestId: string, counts: ColumnCounts) => Promise<ProfileChart>;
  /** A line above the counts: what the profile covers, when that is not all of it. */
  notice?: string | null;
  onClose: () => void;
  /**
   * A click on a value or a bucket: the conditions that select its rows.
   * The panel calls `onClose` after it for a value or NULL — the profile
   * of one value is a single bar, so there is nothing left to show — and
   * stays open for a bucket, whose rows it bins again (the drill-down).
   */
  onAddConditions: (conditions: ProfileCondition[]) => void;
}

/** A bucket edge for the eye: thousands separators, no trailing noise. */
function formatEdge(edge: string): string {
  const n = Number(edge);
  return edge !== '' && Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 10 }) : edge;
}

interface BarRowProps {
  label: React.ReactNode;
  /** The full text, for the tooltip and assistive technology. */
  name: string;
  count: number;
  /** The count the longest bar stands for. */
  max: number;
  action: string;
  onClick: () => void;
}

/**
 * One value or bucket: its label, a bar in proportion to the largest
 * count, and the count itself. The whole row is the button — the bar
 * alone would be a thin target.
 */
function BarRow({ label, name, count, max, action, onClick }: BarRowProps) {
  const width = max > 0 ? Math.max(count > 0 ? 1 : 0, (count / max) * 100) : 0;
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        title={`${action}: ${name}`}
        aria-label={`${name}: ${count.toLocaleString()}`}
        className="w-full grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)_auto] items-center gap-2 px-1 py-0.5 rounded text-left hover:bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        <span className="font-mono text-xs truncate text-primary">{label}</span>
        <span className="h-2 rounded-r-sm bg-blue-500 dark:bg-blue-400" style={{ width: `${width}%` }} aria-hidden="true" />
        <span className="font-mono text-xs tabular-nums text-tertiary">{count.toLocaleString()}</span>
      </button>
    </li>
  );
}

interface StatProps {
  label: string;
  value: string;
}

function Stat({ label, value }: StatProps) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs text-tertiary">{label}</dt>
      <dd className="text-sm font-mono tabular-nums text-primary">{value}</dd>
    </div>
  );
}

const percent = (part: number, whole: number) =>
  whole > 0 ? `${((part / whole) * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%` : '';

/**
 * The column profile: how many rows, NULLs and distinct values the column
 * has under its grid's filter, and a chart of its values — every value
 * with its count, or equal-width buckets past twenty distinct values
 * (`services::profile` on the backend decides which). A click on a value
 * or a bucket adds it to the filter, so "see the distribution, then narrow
 * to a slice" is one motion; the panel then profiles the slice.
 *
 * What is profiled is the caller's: a file's column through its cached
 * session, or a column of the rows a query returned. The panel knows only
 * how to ask and what to do with the answer.
 *
 * One request per `requestKey`. A newer request supersedes an older one
 * whatever order they return in — profiling is a scan, and a filtered one
 * can take longer than the unfiltered one that replaced it.
 */
export function ColumnProfileView(props: ColumnProfileViewProps) {
  // A chart belongs to the complete request, including its filter. Remount
  // before painting a different request so old bars can never apply values
  // to a new column or to a row set they did not describe.
  return <ProfileRequest key={props.requestKey} {...props} />;
}

function ProfileRequest({ name, typeLabel, columnRef, loadCounts, loadChart, notice, onClose, onAddConditions }: ColumnProfileViewProps) {
  const { t } = useTranslation();
  const [counts, setCounts] = useState<ColumnCounts | null>(null);
  const [chart, setChart] = useState<ProfileChart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    const seq = ++requestSeq.current;
    const requestId = nextProfileRequestId();
    setError(null);
    // Two scans, shown as they arrive: the counts are the numbers above the
    // chart and on a large column they land seconds before it does. A panel
    // that waited for both would show a spinner for the whole of it.
    void (async () => {
      try {
        const counted = await loadCounts(requestId);
        if (seq !== requestSeq.current) return;
        setCounts(counted);
        const charted = await loadChart(requestId, counted);
        if (seq !== requestSeq.current) return;
        setChart(charted);
      } catch (err) {
        if (seq !== requestSeq.current) return;
        setError(toErrorMessage(err));
      }
    })();
    // Dropping the answer is not enough: the scan holds memory the next
    // profile needs, so the backend is told the panel has moved on. An id
    // that has already answered cancels nothing.
    return () => { ++requestSeq.current; void cancelProfile(requestId); };
    // `load` closes over the request this panel was mounted for, and the
    // panel is remounted when that changes; re-running on its identity
    // would ask again on every render of the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A value or NULL narrows the column to one thing: the chart would come
  // back as one bar, so the panel closes and the eye is left with the
  // condition the filter bar highlights. A bucket keeps the panel open,
  // because the next profile bins that range again.
  const filterValue = (value: ValueCount) => {
    onAddConditions([{ column: columnRef, operator: '=', value: formatCellValue(value.value) ?? '' }]);
    onClose();
  };
  const filterNull = () => {
    onAddConditions([{ column: columnRef, operator: 'IS NULL', value: '' }]);
    onClose();
  };
  const filterBucket = (bucket: HistogramBucket) =>
    onAddConditions([
      { column: columnRef, operator: '>=', value: bucket.lower },
      { column: columnRef, operator: bucket.upper_inclusive ? '<=' : '<', value: bucket.upper },
    ]);

  const nullRow = (max: number) =>
    counts && counts.null_count > 0 ? (
      <BarRow
        label={<span className="italic text-tertiary">{t('viewer.profile.null')}</span>}
        name={t('viewer.profile.null')}
        count={counts.null_count}
        max={max}
        action={t('viewer.profile.filterNull')}
        onClick={filterNull}
      />
    ) : null;

  const chartBlock = (() => {
    if (!counts || !chart) return null;
    switch (chart.shape) {
      case 'top_values': {
        const max = Math.max(counts.null_count, ...chart.values.map(v => v.count));
        const partial = counts.distinct_count !== null && chart.values.length < counts.distinct_count;
        return (
          <>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-tertiary">
              {partial
                ? t('viewer.profile.topValues', { shown: chart.values.length, distinct: counts.distinct_count?.toLocaleString() })
                : t('viewer.profile.values')}
            </h3>
            <ul className="space-y-0.5">
              {chart.values.map(value => {
                const text = formatCellValue(value.value) ?? '';
                const label = text.trim() === '' ? JSON.stringify(text) : text;
                return (
                  <BarRow
                    key={text}
                    label={label}
                    name={label}
                    count={value.count}
                    max={max}
                    action={t('viewer.profile.filterValue')}
                    onClick={() => filterValue(value)}
                  />
                );
              })}
              {nullRow(max)}
            </ul>
            {chart.other > 0 && (
              <p className="text-xs text-tertiary">{t('viewer.profile.otherValues', { count: chart.other })}</p>
            )}
          </>
        );
      }
      case 'histogram': {
        const max = Math.max(counts.null_count, ...chart.buckets.map(b => b.count));
        return (
          <>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-tertiary">{t('viewer.profile.distribution')}</h3>
            <ul className="space-y-0.5">
              {chart.buckets.map(bucket => {
                const name = `${formatEdge(bucket.lower)} – ${bucket.upper_inclusive ? '≤ ' : ''}${formatEdge(bucket.upper)}`;
                return (
                  <BarRow
                    key={bucket.lower}
                    label={name}
                    name={name}
                    count={bucket.count}
                    max={max}
                    action={t('viewer.profile.filterRange')}
                    onClick={() => filterBucket(bucket)}
                  />
                );
              })}
              {nullRow(max)}
            </ul>
            {chart.other > 0 && (
              <p className="text-xs text-tertiary">{t('viewer.profile.notBinned', { count: chart.other })}</p>
            )}
          </>
        );
      }
      case 'unsupported':
        return (
          <>
            <ul className="space-y-0.5">{nullRow(counts.total_rows)}</ul>
            <p className="text-xs text-tertiary">{t('viewer.profile.noChart')}</p>
          </>
        );
      default:
        return assertNever(chart, 'profile chart');
    }
  })();

  return (
    <aside
      aria-label={t('viewer.profile.title', { column: name })}
      className="w-80 shrink-0 flex flex-col border-l border-primary bg-primary"
    >
      <div className="flex items-start gap-2 px-3 py-2 border-b border-primary">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold truncate text-primary" title={name}>{name}</h2>
          <div className="text-xs text-tertiary">{typeLabel}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          title={t('common.close')}
          aria-label={t('common.close')}
          className="p-1 rounded text-tertiary hover:text-primary hover:bg-tertiary"
        >
          <X size={16} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {error && !counts ? (
          <p role="alert" className="text-xs font-mono break-words text-red-600 dark:text-red-400">{error}</p>
        ) : counts ? (
          <div className="space-y-3">
            {notice && <p className="text-xs text-tertiary">{notice}</p>}
            <dl className="space-y-1">
              <Stat label={t('viewer.profile.rows')} value={counts.total_rows.toLocaleString()} />
              <Stat
                label={t('viewer.profile.nulls')}
                value={`${counts.null_count.toLocaleString()} ${percent(counts.null_count, counts.total_rows)}`.trim()}
              />
              <Stat
                label={t('viewer.profile.distinct')}
                value={
                  counts.distinct_count === null
                    ? '—'
                    : counts.distinct_approximate
                      // An estimate that printed like a count would be read
                      // as one; the sign says what it is and the line below
                      // says why there is no exact number.
                      ? t('viewer.profile.distinctApproximate', { value: counts.distinct_count.toLocaleString() })
                      : counts.distinct_count.toLocaleString()
                }
              />
            </dl>
            {counts.distinct_approximate && (
              <p className="text-xs text-tertiary">{t('viewer.profile.distinctEstimated')}</p>
            )}
            {/* The chart is the second scan. Until it lands the counts stand
                on their own, and a failure belongs where the bars would be —
                the numbers above it are already answered. */}
            {error ? (
              <p role="alert" className="text-xs font-mono break-words text-red-600 dark:text-red-400">{error}</p>
            ) : chart ? (
              chartBlock
            ) : (
              <div className="flex items-center gap-2 text-xs text-tertiary" aria-busy="true">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600" />
                {t('viewer.profile.loading')}
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-tertiary">
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600" />
            {t('viewer.profile.loading')}
          </div>
        )}
      </div>
    </aside>
  );
}
