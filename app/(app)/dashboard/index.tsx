import { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
  TouchableOpacity,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import Svg, { Circle, Text as SvgText, G } from 'react-native-svg';
import { useFocusEffect } from 'expo-router';
import { colors, spacing, borderRadius, shadows } from '../../../constants/theme';
import { useI18n } from '../../../lib/i18n-context';
import { useRole } from '../../../lib/useRole';
import { useAuth } from '../../../lib/auth-context';
import { apiFetch } from '../../../lib/api';
import { formatDateThai } from '../../../lib/format-date';
import { SkeletonDashboard } from '../../../components/Skeleton';

type FleetStat = {
  fleetId: string;
  total: number;
  checked: number;
  pending: number;
};

type WeeklyStat = {
  total: number;
  checked: number;
  pending: number;
  percentage: number;
};

type DashboardData = {
  date: string;
  overall: {
    total: number;
    checked: number;
    pending: number;
    percentage: number;
  };
  weekly?: WeeklyStat;
  fleets: FleetStat[];
};

type HistoryInspection = {
  id: string;
  vehicle_id: string;
  plate_number: string;
  vehicle_type: string;
  fleet_id: string;
  overall_status: string;
  inspection_date: string;
  inspector_name?: string;
  frequency?: string;
  mileage?: number | null;
};

type HistoryData = {
  total: number;
  passed: number;
  failed: number;
  inspections: HistoryInspection[];
};

/* ───────────────────────── Donut Chart ───────────────────────── */

function DonutChart({ checked, total, size = 160 }: { checked: number; total: number; size?: number }) {
  const pending = total - checked;
  const pct = total > 0 ? checked / total : 0;
  const radius = (size - 20) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;

  const checkedLength = circumference * pct;
  const pendingLength = circumference * (1 - pct);

  return (
    <Svg width={size} height={size}>
      {/* Pending (red) - full circle background */}
      <Circle
        cx={center} cy={center} r={radius}
        stroke={colors.statusFail}
        strokeWidth={18}
        fill="none"
        opacity={0.9}
      />
      {/* Checked (green) - overlaid arc */}
      <Circle
        cx={center} cy={center} r={radius}
        stroke={colors.statusChecked}
        strokeWidth={18}
        fill="none"
        strokeDasharray={`${checkedLength} ${pendingLength}`}
        strokeLinecap="round"
        transform={`rotate(-90 ${center} ${center})`}
      />
      {/* Center text */}
      <SvgText
        x={center} y={center - 6}
        textAnchor="middle"
        fontSize={32}
        fontWeight="800"
        fill={colors.textPrimary}
      >
        {Math.round(pct * 100)}%
      </SvgText>
      <SvgText
        x={center} y={center + 18}
        textAnchor="middle"
        fontSize={12}
        fill={colors.textSecondary}
      >
        {checked}/{total}
      </SvgText>
    </Svg>
  );
}

/* ───────────────────────── Fleet Row ───────────────────────── */

function FleetRow({ fleet }: { fleet: FleetStat }) {
  const pct = fleet.total > 0 ? Math.round((fleet.checked / fleet.total) * 100) : 0;
  const isComplete = pct === 100;
  const isZero = pct === 0;

  return (
    <View style={[styles.fleetRow, isComplete && styles.fleetRowComplete]}>
      <View style={styles.fleetInfo}>
        <Text style={[styles.fleetCode, isZero && styles.fleetCodeUrgent]}>
          {fleet.fleetId}
        </Text>
        <View style={styles.fleetBar}>
          <View style={[styles.fleetBarFill, {
            width: `${pct}%`,
            backgroundColor: isComplete ? colors.statusChecked : isZero ? colors.statusFail : colors.primary,
          }]} />
        </View>
      </View>
      <Text style={styles.fleetNumbers}>{fleet.checked}/{fleet.total}</Text>
      <Text style={[styles.fleetPct, {
        color: isComplete ? colors.statusChecked : isZero ? colors.statusFail : colors.textPrimary,
      }]}>{pct}%</Text>
    </View>
  );
}

/* ───────────────────────── History Section ───────────────────────── */

type DateRange = 'today' | 'week' | 'month';

function pad2(n: number) { return n < 10 ? `0${n}` : `${n}`; }
function fmtLocalDate(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function startOfWeekMon(d: Date) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = x.getDay();
  const diff = (day + 6) % 7;
  x.setDate(x.getDate() - diff);
  return x;
}
function startOfMonthLocal(d: Date) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonthLocal(d: Date) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }

function getDateRange(range: DateRange): { startDate: string; endDate: string } {
  const now = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
  const endDate = now.toISOString().split('T')[0];

  switch (range) {
    case 'today':
      return { startDate: endDate, endDate };
    case 'week': {
      const weekAgo = new Date(now);
      weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);
      return { startDate: weekAgo.toISOString().split('T')[0], endDate };
    }
    case 'month': {
      const monthAgo = new Date(now);
      monthAgo.setUTCMonth(monthAgo.getUTCMonth() - 1);
      return { startDate: monthAgo.toISOString().split('T')[0], endDate };
    }
  }
}

function HistorySection({ fleetId, isAdmin }: { fleetId: string; isAdmin: boolean }) {
  const { t } = useI18n();
  const [range, setRange] = useState<DateRange>('today');
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);

  const fetchHistory = useCallback(async () => {
    try {
      const { startDate, endDate } = getDateRange(range);
      const params = new URLSearchParams({ startDate, endDate });
      if (!isAdmin && fleetId) params.append('fleetId', fleetId);
      const data = await apiFetch(`/api/history?${params.toString()}`);
      setHistory(data);
    } catch {
      setHistory(null);
    } finally {
      setInitialLoading(false);
    }
  }, [range, fleetId, isAdmin]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const rangeButtons: { key: DateRange; label: string }[] = [
    { key: 'today', label: t('dashboard.today') },
    { key: 'week', label: t('dashboard.thisWeek') },
    { key: 'month', label: t('dashboard.thisMonth') },
  ];

  return (
    <View style={historyStyles.container}>
      <Text style={historyStyles.title}>{t('dashboard.history')}</Text>

      {/* Tab buttons with underline */}
      <View style={historyStyles.rangeRow}>
        {rangeButtons.map((btn) => (
          <TouchableOpacity
            key={btn.key}
            style={[historyStyles.rangeBtn, range === btn.key && historyStyles.rangeBtnActive]}
            onPress={() => setRange(btn.key)}
            activeOpacity={0.7}
          >
            <Text style={[historyStyles.rangeBtnText, range === btn.key && historyStyles.rangeBtnTextActive]}>
              {btn.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {initialLoading && !history ? (
        <ActivityIndicator color={colors.primary} style={{ marginVertical: spacing.md }} />
      ) : history ? (
        <View>
          {/* Stats as simple rows */}
          <View style={historyStyles.statsCard}>
            <View style={historyStyles.statRow}>
              <Text style={historyStyles.statLabel}>{t('dashboard.totalInspections')}</Text>
              <Text style={historyStyles.statNumber}>{history.total}</Text>
            </View>
            <View style={historyStyles.statDivider} />
            <View style={historyStyles.statRow}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Ionicons name="checkmark-circle" size={16} color={colors.statusPass} style={{ marginRight: 6 }} />
                <Text style={historyStyles.statLabel}>{t('dashboard.passed')}</Text>
              </View>
              <Text style={[historyStyles.statNumber, { color: colors.statusPass }]}>{history.passed}</Text>
            </View>
            <View style={historyStyles.statDivider} />
            <View style={historyStyles.statRow}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Ionicons name="close-circle" size={16} color={colors.statusFail} style={{ marginRight: 6 }} />
                <Text style={historyStyles.statLabel}>{t('dashboard.failed')}</Text>
              </View>
              <Text style={[historyStyles.statNumber, { color: colors.statusFail }]}>{history.failed}</Text>
            </View>
          </View>

          {history.inspections.length === 0 ? (
            <Text style={historyStyles.emptyText}>{t('dashboard.noInspections')}</Text>
          ) : (
            history.inspections
              .slice(0, 10)
              .map((ins) => {
                const dateStr = formatDateThai(ins.inspection_date);
                const failed = ins.overall_status === 'fail';
                return (
                  <View key={ins.id} style={historyStyles.failRow}>
                    <Ionicons
                      name={failed ? 'warning' : 'checkmark-circle'}
                      size={20}
                      color={failed ? colors.accent : colors.statusPass}
                    />
                    <View style={{ flex: 1, marginLeft: spacing.md }}>
                      <Text style={historyStyles.failPlate}>{ins.plate_number}</Text>
                      <Text style={historyStyles.failMeta}>
                        {t('inspection.fleet')}: {ins.fleet_id}
                        {' \u2022 '}{t('inspection.vehicleType')}: {ins.vehicle_type}
                      </Text>
                      <Text style={historyStyles.failMeta}>
                        {t('inspection.date')}: {dateStr}
                        {' \u2022 '}{t('inspection.inspector')}: {ins.inspector_name || '-'}
                      </Text>
                      <Text style={historyStyles.failMeta}>
                        {t('inspection.event')}: {ins.frequency || '-'}
                        {' \u2022 '}{t('inspection.mileage')}: {ins.mileage != null ? `${ins.mileage.toLocaleString()} km` : '-'}
                      </Text>
                    </View>
                    <View style={[historyStyles.failBadge, !failed && historyStyles.passBadge]}>
                      <Text style={[historyStyles.failBadgeText, !failed && historyStyles.passBadgeText]}>
                        {failed ? t('inspection.fail') : t('inspection.pass')}
                      </Text>
                    </View>
                  </View>
                );
              })
          )}
        </View>
      ) : null}
    </View>
  );
}

const historyStyles = StyleSheet.create({
  container: {
    marginTop: spacing.lg,
    marginBottom: spacing.md,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: spacing.md,
  },
  rangeRow: {
    flexDirection: 'row',
    gap: spacing.lg,
    marginBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rangeBtn: {
    paddingVertical: spacing.sm,
    paddingBottom: 10,
    marginBottom: -1,
  },
  rangeBtnActive: {
    borderBottomWidth: 2,
    borderBottomColor: colors.accent,
  },
  rangeBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  rangeBtnTextActive: {
    color: colors.accent,
    fontWeight: '700',
  },
  statsCard: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    ...shadows.sm,
  },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
  },
  statDivider: {
    height: 1,
    backgroundColor: colors.border,
  },
  statNumber: {
    fontSize: 20,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  statLabel: {
    fontSize: 14,
    color: colors.textSecondary,
  },
  emptyText: {
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: 'center',
    paddingVertical: spacing.md,
  },
  failRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  failPlate: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  failMeta: {
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: 2,
  },
  failBadge: {
    backgroundColor: colors.accent + '15',
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: borderRadius.full,
  },
  failBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.accent,
  },
  passBadge: {
    backgroundColor: colors.statusPass + '15',
  },
  passBadgeText: {
    color: colors.statusPass,
  },
});

/* ───────────────────────── Dashboard Screen ───────────────────────── */

export default function DashboardScreen() {
  const { t } = useI18n();
  const { fleetId, isAdmin, isVehicleOwner } = useRole();
  const { user } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchDashboard = useCallback(async () => {
    try {
      setError(null);
      const url = isAdmin || isVehicleOwner ? '/api/dashboard' : `/api/dashboard?fleetId=${fleetId}`;
      const d = await apiFetch(url);
      setData(d);
    } catch (err) {
      console.error('Failed to fetch dashboard:', err);
      setError(t('general.error'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [fleetId, isAdmin, isVehicleOwner, t]);

  useFocusEffect(
    useCallback(() => {
      fetchDashboard();
    }, [fetchDashboard])
  );

  const onRefresh = () => {
    setRefreshing(true);
    fetchDashboard();
  };

  if (loading) {
    return <SkeletonDashboard />;
  }

  if (error) {
    return (
      <View style={styles.centered}>
        <Ionicons name="alert-circle-outline" size={48} color={colors.accent} style={{ marginBottom: spacing.md }} />
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={() => { setLoading(true); fetchDashboard(); }} activeOpacity={0.7}>
          <Text style={styles.retryText}>{t('general.retry')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!data) {
    return (
      <View style={styles.centered}>
        <Ionicons name="analytics-outline" size={48} color={colors.textTertiary} style={{ marginBottom: spacing.sm }} />
        <Text style={styles.emptyText}>{t('dashboard.noData')}</Text>
      </View>
    );
  }

  const { overall, weekly, fleets } = data;

  // Sort fleets by urgency: most pending first, 100% pushed to bottom
  const sortedFleets = [...fleets].sort((a, b) => {
    const aPct = a.total > 0 ? a.checked / a.total : 1;
    const bPct = b.total > 0 ? b.checked / b.total : 1;
    return aPct - bPct;
  });

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
      >
        {/* ─── Greeting ─── */}
        <View style={styles.greetingRow}>
          <View style={styles.greetingWrap}>
            {user && (
              <>
                <Text style={styles.greetingName}>
                  {t('dashboard.greeting').replace('{name}', user.firstName)}
                </Text>
                <Text style={styles.greetingDate}>
                  {formatDateThai(new Date())}
                </Text>
              </>
            )}
          </View>
        </View>

        {/* ─── Hero: Donut Chart ─── */}
        <View style={styles.heroCard}>
          <View style={styles.heroTop}>
            <View style={styles.donutContainer}>
              {overall.total === 0 ? (
                <View style={styles.heroEmpty}>
                  <Ionicons name="analytics-outline" size={32} color={colors.textTertiary} />
                  <Text style={styles.heroEmptyText}>{t('dashboard.noInspections')}</Text>
                </View>
              ) : (
                <DonutChart checked={overall.checked} total={overall.total} size={126} />
              )}
            </View>
            <View style={styles.heroMetrics}>
              <View style={styles.metricRow}>
                <View style={[styles.metricDot, { backgroundColor: colors.statusChecked }]} />
                <Text style={styles.metricLabel}>{t('dashboard.checkedLabel')}</Text>
                <Text style={styles.metricCount}>{overall.checked}</Text>
              </View>
              <View style={styles.metricDivider} />
              <View style={styles.metricRow}>
                <View style={[styles.metricDot, { backgroundColor: colors.statusFail }]} />
                <Text style={styles.metricLabel}>{t('dashboard.pendingLabel')}</Text>
                <Text style={styles.metricCount}>{overall.pending}</Text>
              </View>
              <Text style={styles.dateLabel}>{t('dashboard.today')} · {data.date}</Text>
            </View>
          </View>
        </View>

        {/* ─── Fleet List ─── */}
        <Text style={styles.sectionTitle}>{t('dashboard.pendingByFleet')}</Text>

        <View style={styles.fleetCard}>
          {sortedFleets.map((fleet) => (
            <FleetRow key={fleet.fleetId} fleet={fleet} />
          ))}
        </View>

        {/* ─── Weekly Inspection Card ─── */}
        {weekly && weekly.total > 0 && (
          <>
            <Text style={styles.sectionTitle}>{t('dashboard.weeklyCompletion')}</Text>
            <View style={weeklyStyles.card}>
              <View style={weeklyStyles.row}>
                <View style={weeklyStyles.stat}>
                  <Ionicons name="checkmark-circle" size={20} color={colors.statusChecked} />
                  <Text style={weeklyStyles.num}>{weekly.checked}</Text>
                  <Text style={weeklyStyles.label}>{t('dashboard.checkedLabel')}</Text>
                </View>
                <View style={weeklyStyles.divider} />
                <View style={weeklyStyles.stat}>
                  <Ionicons name="ellipse-outline" size={20} color={colors.statusFail} />
                  <Text style={weeklyStyles.num}>{weekly.pending}</Text>
                  <Text style={weeklyStyles.label}>{t('dashboard.pendingLabel')}</Text>
                </View>
                <View style={weeklyStyles.divider} />
                <View style={weeklyStyles.stat}>
                  <Text style={[weeklyStyles.pct, {
                    color: weekly.percentage === 100 ? colors.statusChecked : weekly.percentage === 0 ? colors.statusFail : colors.textPrimary,
                  }]}>{weekly.percentage}%</Text>
                  <Text style={weeklyStyles.label}>{weekly.checked}/{weekly.total}</Text>
                </View>
              </View>
              <View style={weeklyStyles.barTrack}>
                <View style={[weeklyStyles.barFill, {
                  width: `${weekly.percentage}%`,
                  backgroundColor: weekly.percentage === 100 ? colors.statusChecked : colors.primary,
                }]} />
              </View>
            </View>
          </>
        )}

        {/* ─── History Section ─── */}
        <HistorySection fleetId={isVehicleOwner ? '' : fleetId} isAdmin={isAdmin} />
      </ScrollView>

    </View>
  );
}

/* ───────────────────────── Styles ───────────────────────── */

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.background,
  },
  loadingText: {
    marginTop: spacing.sm,
    color: colors.textSecondary,
  },
  emptyText: {
    fontSize: 16,
    color: colors.textSecondary,
  },
  errorText: {
    fontSize: 16,
    color: colors.accent,
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  retryButton: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 4,
    borderRadius: borderRadius.sm,
  },
  retryText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.onPrimary,
  },
  list: {
    paddingHorizontal: 12,
    paddingBottom: spacing.xl,
  },
  greetingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
    paddingTop: spacing.sm,
    gap: spacing.sm,
  },
  greetingWrap: {
    flex: 1,
  },
  greetingName: {
    fontSize: 19,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  greetingDate: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 2,
  },
  /* Hero card */
  heroCard: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.md,
    padding: 12,
    marginTop: 10,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.sm,
  },
  heroTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  donutContainer: {
    width: 128,
    minHeight: 126,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroEmpty: {
    width: 126,
    minHeight: 126,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.inputBackground,
    borderRadius: borderRadius.md,
  },
  heroEmptyText: {
    fontSize: 11,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  heroMetrics: { flex: 1 },
  metricRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 38,
  },
  metricDot: { width: 8, height: 8, borderRadius: 4, marginRight: spacing.sm },
  metricLabel: { flex: 1, fontSize: 12, fontWeight: '600', color: colors.textSecondary },
  metricCount: { fontSize: 20, fontWeight: '800', color: colors.textPrimary },
  metricDivider: {
    height: 1,
    backgroundColor: colors.border,
  },
  dateLabel: {
    fontSize: 10,
    color: colors.textTertiary,
    fontWeight: '600',
    marginTop: spacing.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },

  /* Section title */
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: spacing.sm,
  },

  /* Fleet card */
  fleetCard: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.md,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.sm,
  },

  /* Fleet row */
  fleetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  fleetRowComplete: {
    opacity: 0.55,
  },
  fleetInfo: {
    flex: 1,
    marginRight: spacing.sm,
  },
  fleetCode: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 4,
  },
  fleetCodeUrgent: {
    color: colors.statusFail,
  },
  fleetBar: {
    height: 6,
    backgroundColor: colors.border,
    borderRadius: 3,
    overflow: 'hidden',
  },
  fleetBarFill: {
    height: '100%',
    borderRadius: 3,
  },
  fleetNumbers: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textSecondary,
    width: 44,
    textAlign: 'right',
    marginRight: spacing.sm,
  },
  fleetPct: {
    fontSize: 14,
    fontWeight: '700',
    width: 40,
    textAlign: 'right',
  },
});

const weeklyStyles = StyleSheet.create({
  card: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.md,
    padding: 12,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    marginBottom: spacing.md,
  },
  stat: {
    alignItems: 'center',
    flex: 1,
    gap: 4,
  },
  divider: {
    width: 1,
    height: 40,
    backgroundColor: colors.border,
  },
  num: {
    fontSize: 24,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  pct: {
    fontSize: 24,
    fontWeight: '800',
  },
  label: {
    fontSize: 11,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  barTrack: {
    height: 8,
    backgroundColor: colors.border,
    borderRadius: 4,
    overflow: 'hidden',
  },
  barFill: {
    height: 8,
    borderRadius: 4,
  },
});
