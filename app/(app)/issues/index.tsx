import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Alert,
  Modal,
  ScrollView,
  TextInput,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter, useFocusEffect } from 'expo-router';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { colors, spacing, borderRadius, modalOverlay } from '../../../constants/theme';
import { useI18n } from '../../../lib/i18n-context';
import { useRole } from '../../../lib/useRole';
import { apiFetch, API_BASE, getAuthToken } from '../../../lib/api';
import { formatDateTimeThai as formatDate } from '../../../lib/format-date';
import { vehicleTypeLabel, type IssueStatus } from '../../../lib/types';
import { DateField } from '../../../components/DateField';

type IssueWithVehicle = {
  id: string;
  inspection_id: string;
  vehicle_id: string;
  fleet_id: string;
  status: IssueStatus;
  defect_photo_urls: string[];
  completion_photo_urls: string[];
  created_at: string;
  updated_at: string;
  plate_number: string;
  vehicle_type: string;
  vehicle_fleet: string;
  inspector_name: string | null;
  inspection_date: string | null;
};

type TabFilter = 'all' | 'open' | 'in_progress' | 'completed';
type Period = 'all' | 'today' | 'week' | 'month' | 'pickMonth' | 'custom';

const STATUS_COLORS: Record<IssueStatus, string> = {
  open: colors.statusFail,
  in_progress: colors.statusPending,
  completed: colors.statusPass,
};

const STATUS_ICONS: Record<IssueStatus, keyof typeof Ionicons.glyphMap> = {
  open: 'alert-circle',
  in_progress: 'time-outline',
  completed: 'checkmark-circle',
};

const PAGE_LIMIT = 50;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad(n: number) { return n < 10 ? `0${n}` : `${n}`; }
function fmtDate(d: Date) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function startOfWeek(d: Date) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = x.getDay();
  const diff = (day + 6) % 7; // Monday-start week
  x.setDate(x.getDate() - diff);
  return x;
}
function startOfMonth(d: Date) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d: Date) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }

function buildMonthOptions(count = 12) {
  const now = new Date();
  const out: { value: string; label: string }[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({
      value: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`,
      label: d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }),
    });
  }
  return out;
}

export default function IssuesScreen() {
  const { t } = useI18n();
  const { fleetId: assignedFleetId, isAdmin, isVehicleOwner } = useRole();
  const fleetId = isVehicleOwner ? '' : assignedFleetId;
  const router = useRouter();
  const [issues, setIssues] = useState<IssueWithVehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<TabFilter>('all');
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const offsetRef = useRef(0);

  // Export modal state
  const [filterVisible, setFilterVisible] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [fleets, setFleets] = useState<{ fleet_id: string }[]>([]);
  const [fleetsLoaded, setFleetsLoaded] = useState(false);
  const [selectedFleets, setSelectedFleets] = useState<string[]>([]);
  const [period, setPeriod] = useState<Period>('all');
  const [pickedMonth, setPickedMonth] = useState<string>('');
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');

  const monthOptions = useMemo(() => buildMonthOptions(12), []);

  const fetchIssues = useCallback(async (reset = false) => {
    try {
      setError(null);
      const currentOffset = reset ? 0 : offsetRef.current;
      const params = new URLSearchParams();
      if (activeTab !== 'all') params.set('status', activeTab);
      if (!isAdmin && fleetId) params.set('fleetId', fleetId);
      params.set('limit', String(PAGE_LIMIT));
      params.set('offset', String(currentOffset));
      const data = await apiFetch(`/api/issues?${params.toString()}`);
      const fetched: IssueWithVehicle[] = Array.isArray(data.issues) ? data.issues : Array.isArray(data) ? data : [];
      if (reset) {
        setIssues(fetched);
        offsetRef.current = fetched.length;
      } else {
        setIssues((prev) => [...prev, ...fetched]);
        offsetRef.current = currentOffset + fetched.length;
      }
      setHasMore(fetched.length >= PAGE_LIMIT);
    } catch (err) {
      console.error('Failed to fetch issues:', err);
      setError(t('general.error'));
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
    }
  }, [activeTab, fleetId, isAdmin, t]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      setIssues([]);
      offsetRef.current = 0;
      setHasMore(true);
      fetchIssues(true);
    }, [activeTab, fetchIssues])
  );

  const onRefresh = () => {
    setRefreshing(true);
    setIssues([]);
    offsetRef.current = 0;
    setHasMore(true);
    fetchIssues(true);
  };

  const loadMore = () => {
    if (!hasMore || loading || loadingMore) return;
    setLoadingMore(true);
    fetchIssues(false);
  };

  const loadFleets = useCallback(async () => {
    if (!isAdmin || fleetsLoaded) return;
    try {
      const data = await apiFetch('/api/admin/fleets');
      setFleets(Array.isArray(data) ? data : []);
      setFleetsLoaded(true);
    } catch (err) {
      console.error('Failed to load fleets:', err);
    }
  }, [isAdmin, fleetsLoaded]);

  const openExport = () => {
    setFilterVisible(true);
    loadFleets();
  };

  const toggleFleet = (id: string) => {
    setSelectedFleets((prev) =>
      prev.includes(id) ? prev.filter((f) => f !== id) : [...prev, id]
    );
  };

  const resolveDateRange = (): { start?: string; end?: string; error?: string } => {
    const today = new Date();
    if (period === 'all') return {};
    if (period === 'today') {
      const s = fmtDate(today);
      return { start: s, end: s };
    }
    if (period === 'week') {
      return { start: fmtDate(startOfWeek(today)), end: fmtDate(today) };
    }
    if (period === 'month') {
      return { start: fmtDate(startOfMonth(today)), end: fmtDate(endOfMonth(today)) };
    }
    if (period === 'pickMonth') {
      if (!pickedMonth) return { error: 'Please select a month' };
      const [y, m] = pickedMonth.split('-').map(Number);
      const d = new Date(y, m - 1, 1);
      return { start: fmtDate(startOfMonth(d)), end: fmtDate(endOfMonth(d)) };
    }
    if (period === 'custom') {
      if (!ISO_DATE_RE.test(dateStart) || !ISO_DATE_RE.test(dateEnd)) {
        return { error: 'Enter both dates as YYYY-MM-DD' };
      }
      if (dateStart > dateEnd) return { error: 'Start date must be before end date' };
      return { start: dateStart, end: dateEnd };
    }
    return {};
  };

  const confirmExport = async () => {
    const range = resolveDateRange();
    if (range.error) {
      Alert.alert(t('general.invalidPeriod'), range.error);
      return;
    }
    try {
      setExporting(true);
      const token = await getAuthToken();
      const params = new URLSearchParams();
      if (activeTab !== 'all') params.set('status', activeTab);
      if (!isAdmin && fleetId) {
        params.set('fleetId', fleetId);
      } else if (isAdmin && selectedFleets.length > 0) {
        params.set('fleetId', selectedFleets.join(','));
      }
      if (range.start) params.set('dateStart', range.start);
      if (range.end) params.set('dateEnd', range.end);
      const url = `${API_BASE}/api/issues/export?${params.toString()}`;
      const fileUri = FileSystem.cacheDirectory + `issues-${new Date().toISOString().slice(0, 10)}.xlsx`;
      const result = await FileSystem.downloadAsync(url, fileUri, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (result.status !== 200) throw new Error(`Export failed (${result.status})`);
      setFilterVisible(false);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(result.uri, {
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          dialogTitle: t('dashboard.saveReport'),
          UTI: 'com.microsoft.excel.xlsx',
        });
      } else {
        Alert.alert(t('dashboard.exportSaved'), result.uri);
      }
    } catch (err: any) {
      Alert.alert(t('dashboard.exportFailed'), err.message || t('general.error'));
    } finally {
      setExporting(false);
    }
  };

  const tabs: { key: TabFilter; label: string }[] = [
    { key: 'all', label: t('issues.all') },
    { key: 'open', label: t('issues.open') },
    { key: 'in_progress', label: t('issues.inProgress') },
    { key: 'completed', label: t('issues.completed') },
  ];

  const periodChips: { key: Period; label: string }[] = [
    { key: 'all',       label: t('dashboard.allTime') },
    { key: 'today',     label: t('dashboard.today') },
    { key: 'week',      label: t('dashboard.thisWeek') },
    { key: 'month',     label: t('dashboard.thisMonth') },
    { key: 'pickMonth', label: t('dashboard.pickMonth') },
    { key: 'custom',    label: t('dashboard.custom') },
  ];

  const statusLabel = (status: IssueStatus) => {
    switch (status) {
      case 'open': return t('issues.open');
      case 'in_progress': return t('issues.inProgress');
      case 'completed': return t('issues.completed');
    }
  };

  const renderIssue = ({ item }: { item: IssueWithVehicle }) => {
    const done = item.status === 'completed';
    return (
      <TouchableOpacity
        style={[styles.row, done && styles.rowDone]}
        activeOpacity={0.6}
        onPress={() => router.push(`/(app)/issues/${item.id}`)}
      >
        <Ionicons
          name={STATUS_ICONS[item.status]}
          size={24}
          color={STATUS_COLORS[item.status]}
        />
        <View style={styles.rowContent}>
          <Text style={styles.plate}>{item.plate_number}</Text>
          <Text style={styles.meta}>
            {vehicleTypeLabel(item.vehicle_type)}
            {' • '}{statusLabel(item.status)}{' • '}{formatDate(item.created_at)}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* Tab filter with underline + export button */}
      <View style={styles.tabRow}>
        <View style={styles.tabsContainer}>
          {tabs.map((tab) => (
            <TouchableOpacity
              key={tab.key}
              style={[styles.tab, activeTab === tab.key && styles.tabActive]}
              onPress={() => setActiveTab(tab.key)}
              activeOpacity={0.7}
            >
              <Text style={[styles.tabText, activeTab === tab.key && styles.tabTextActive]}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity
          style={styles.exportBtn}
          onPress={openExport}
          activeOpacity={0.7}
        >
          <Ionicons name="download-outline" size={16} color="#fff" />
          <Text style={styles.exportBtnText}>{t('issues.export')}</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>{t('general.loading')}</Text>
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <Ionicons name="alert-circle-outline" size={48} color={colors.accent} style={{ marginBottom: spacing.md }} />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => { setLoading(true); fetchIssues(); }} activeOpacity={0.7}>
            <Text style={styles.retryText}>{t('general.retry')}</Text>
          </TouchableOpacity>
        </View>
      ) : issues.length === 0 ? (
        <View style={styles.centered}>
          <Ionicons name="checkmark-done-circle-outline" size={48} color={colors.textTertiary} style={{ marginBottom: spacing.sm }} />
          <Text style={styles.emptyText}>{t('issues.noIssues')}</Text>
        </View>
      ) : (
        <FlatList
          data={issues}
          keyExtractor={(item) => item.id}
          renderItem={renderIssue}
          initialNumToRender={12}
          maxToRenderPerBatch={8}
          windowSize={10}
          getItemLayout={(_, index) => ({
            length: 88,
            offset: 88 * index,
            index,
          })}
          onEndReachedThreshold={0.5}
          onEndReached={() => { if (hasMore && !loading) loadMore(); }}
          ListFooterComponent={loadingMore ? <ActivityIndicator style={{ paddingVertical: spacing.md }} color={colors.primary} /> : null}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
        />
      )}

      <Modal
        visible={filterVisible}
        transparent
        animationType="slide"
        onRequestClose={() => !exporting && setFilterVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t('issues.export')}</Text>
              <TouchableOpacity
                onPress={() => !exporting && setFilterVisible(false)}
                disabled={exporting}
                hitSlop={8}
              >
                <Ionicons name="close" size={24} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.modalBody} contentContainerStyle={{ paddingBottom: spacing.md }}>
              {isAdmin && (
                <View style={styles.section}>
                    <Text style={styles.sectionLabel}>{t('dashboard.fleets')}</Text>
                  <View style={styles.chipRow}>
                    <TouchableOpacity
                      style={[styles.chip, selectedFleets.length === 0 && styles.chipActive]}
                      onPress={() => setSelectedFleets([])}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.chipText, selectedFleets.length === 0 && styles.chipTextActive]}>
                        All Fleets
                      </Text>
                    </TouchableOpacity>
                    {fleets.map((f) => {
                      const active = selectedFleets.includes(f.fleet_id);
                      return (
                        <TouchableOpacity
                          key={f.fleet_id}
                          style={[styles.chip, active && styles.chipActive]}
                          onPress={() => toggleFleet(f.fleet_id)}
                          activeOpacity={0.7}
                        >
                          <Text style={[styles.chipText, active && styles.chipTextActive]}>
                            {f.fleet_id}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                    {!fleetsLoaded && (
                      <ActivityIndicator size="small" color={colors.accent} />
                    )}
                  </View>
                </View>
              )}

              {!isAdmin && fleetId ? (
                <View style={styles.section}>
                  <Text style={styles.sectionLabel}>{t('dashboard.fleet')}</Text>
                  <View style={[styles.chip, styles.chipActive, { alignSelf: 'flex-start' }]}>
                    <Text style={[styles.chipText, styles.chipTextActive]}>{fleetId}</Text>
                  </View>
                </View>
              ) : null}

              <View style={styles.section}>
                <Text style={styles.sectionLabel}>{t('dashboard.timePeriod')}</Text>
                <View style={styles.chipRow}>
                  {periodChips.map((p) => {
                    const active = period === p.key;
                    return (
                      <TouchableOpacity
                        key={p.key}
                        style={[styles.chip, active && styles.chipActive]}
                        onPress={() => setPeriod(p.key)}
                        activeOpacity={0.7}
                      >
                        <Text style={[styles.chipText, active && styles.chipTextActive]}>
                          {p.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              {period === 'pickMonth' && (
                <View style={styles.section}>
                  <Text style={styles.sectionLabel}>{t('dashboard.month')}</Text>
                  <View style={styles.chipRow}>
                    {monthOptions.map((m) => {
                      const active = pickedMonth === m.value;
                      return (
                        <TouchableOpacity
                          key={m.value}
                          style={[styles.chip, active && styles.chipActive]}
                          onPress={() => setPickedMonth(m.value)}
                          activeOpacity={0.7}
                        >
                          <Text style={[styles.chipText, active && styles.chipTextActive]}>
                            {m.label}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              )}

              {period === 'custom' && (
                <View style={styles.section}>
                  <Text style={styles.sectionLabel}>{t('dashboard.from')}</Text>
                  <DateField label={t('dashboard.from')} value={dateStart} onChange={setDateStart} />
                  <Text style={[styles.sectionLabel, { marginTop: spacing.sm }]}>{t('dashboard.to')}</Text>
                  <DateField label={t('dashboard.to')} value={dateEnd} onChange={setDateEnd} />
                </View>
              )}
            </ScrollView>

            <View style={styles.modalFooter}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={() => setFilterVisible(false)}
                disabled={exporting}
                activeOpacity={0.7}
              >
                <Text style={styles.cancelBtnText}>{t('admin.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.confirmBtn, exporting && styles.exportBtnDisabled]}
                onPress={confirmExport}
                disabled={exporting}
                activeOpacity={0.7}
              >
                {exporting ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <Ionicons name="download-outline" size={16} color="#fff" />
                <Text style={styles.confirmBtnText}>{t('issues.export')}</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  tabRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.white,
    gap: spacing.sm,
  },
  tabsContainer: {
    flex: 1,
    flexDirection: 'row',
    gap: 2,
    padding: 2,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.inputBackground,
    borderWidth: 1,
    borderColor: colors.border,
  },
  exportBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 8,
    borderRadius: borderRadius.sm,
  },
  exportBtnDisabled: {
    opacity: 0.6,
  },
  exportBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#fff',
  },
  tab: {
    flex: 1,
    paddingVertical: 7,
    alignItems: 'center',
    borderRadius: 4,
  },
  tabActive: {
    backgroundColor: colors.primary,
  },
  tabText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  tabTextActive: {
    color: colors.onPrimary,
    fontWeight: '700',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.md,
  },
  rowDone: {
    opacity: 0.6,
  },
  rowContent: {
    flex: 1,
  },
  plate: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  meta: {
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: 2,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
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
  modalOverlay: {
    flex: 1,
    backgroundColor: modalOverlay,
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: borderRadius.lg,
    borderTopRightRadius: borderRadius.lg,
    maxHeight: '85%',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  modalBody: {
    paddingHorizontal: spacing.md,
  },
  section: {
    paddingTop: spacing.md,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textSecondary,
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: borderRadius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.inputBackground,
  },
  chipActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  chipText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  chipTextActive: {
    color: '#fff',
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.textPrimary,
    backgroundColor: colors.inputBackground,
  },
  modalFooter: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: borderRadius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    backgroundColor: colors.white,
  },
  cancelBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  confirmBtn: {
    flex: 1.4,
    flexDirection: 'row',
    gap: 6,
    paddingVertical: 12,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#fff',
  },
});
