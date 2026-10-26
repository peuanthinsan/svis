import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import Ionicons from '@expo/vector-icons/Ionicons';
import { colors, spacing, borderRadius } from '../constants/theme';
import { useI18n } from '../lib/i18n-context';
import { useRole } from '../lib/useRole';
import { apiFetch, API_BASE, getAuthToken } from '../lib/api';
import { DateField } from './DateField';

type Period = 'all' | 'today' | 'week' | 'month' | 'pickMonth' | 'custom';
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad2 = (n: number) => n < 10 ? `0${n}` : `${n}`;
const localDate = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const startOfWeek = (d: Date) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const endOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 0);

function monthOptions(count = 12) {
  const now = new Date();
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    return { value: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`, label: d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) };
  });
}

export default function DashboardExportForm() {
  const { t } = useI18n();
  const { fleetId: assignedFleetId, isAdmin, isVehicleOwner } = useRole();
  const fleetId = isVehicleOwner ? '' : assignedFleetId;
  const [period, setPeriod] = useState<Period>('all');
  const [selectedFleets, setSelectedFleets] = useState<string[]>([]);
  const [fleetList, setFleetList] = useState<{ fleet_id: string }[]>([]);
  const [fleetsLoaded, setFleetsLoaded] = useState(false);
  const [pickedMonth, setPickedMonth] = useState('');
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');
  const [exporting, setExporting] = useState(false);
  const months = useMemo(() => monthOptions(), []);

  const loadFleets = useCallback(async () => {
    if (!isAdmin || fleetsLoaded) return;
    try { const list = await apiFetch('/api/admin/fleets'); setFleetList(Array.isArray(list) ? list : []); setFleetsLoaded(true); }
    catch (err) { console.error('Failed to load fleets:', err); }
  }, [isAdmin, fleetsLoaded]);
  useEffect(() => { loadFleets(); }, [loadFleets]);

  const resolveRange = () => {
    const today = new Date();
    if (period === 'all') return {};
    if (period === 'today') { const d = localDate(today); return { start: d, end: d }; }
    if (period === 'week') return { start: localDate(startOfWeek(today)), end: localDate(today) };
    if (period === 'month') return { start: localDate(startOfMonth(today)), end: localDate(endOfMonth(today)) };
    if (period === 'pickMonth') {
      if (!pickedMonth) return { error: t('dashboard.selectMonth') };
      const [y, m] = pickedMonth.split('-').map(Number); const d = new Date(y, m - 1, 1);
      return { start: localDate(startOfMonth(d)), end: localDate(endOfMonth(d)) };
    }
    if (!ISO_DATE_RE.test(dateStart) || !ISO_DATE_RE.test(dateEnd)) return { error: t('dashboard.invalidDates') };
    if (dateStart > dateEnd) return { error: t('dashboard.startAfterEnd') };
    return { start: dateStart, end: dateEnd };
  };

  const exportReport = async () => {
    const range = resolveRange();
    if ('error' in range && range.error) { Alert.alert(t('dashboard.invalidPeriod'), range.error); return; }
    try {
      setExporting(true);
      const params = new URLSearchParams(); const token = await getAuthToken();
      if (!isAdmin && fleetId) params.set('fleetId', fleetId);
      else if (isAdmin && selectedFleets.length) params.set('fleetId', selectedFleets.join(','));
      if ('start' in range && range.start) params.set('dateStart', range.start);
      if ('end' in range && range.end) params.set('dateEnd', range.end);
      const uri = `${FileSystem.cacheDirectory}dashboard-${new Date().toISOString().slice(0, 10)}.xlsx`;
      const result = await FileSystem.downloadAsync(`${API_BASE}/api/dashboard/export?${params}`, uri, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (result.status !== 200) throw new Error(`Export failed (${result.status})`);
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(result.uri, { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', dialogTitle: t('dashboard.saveReport'), UTI: 'com.microsoft.excel.xlsx' });
      else Alert.alert(t('dashboard.exportSaved'), result.uri);
    } catch (err: any) { Alert.alert(t('dashboard.exportFailed'), err.message || t('general.error')); }
    finally { setExporting(false); }
  };

  const chips: { key: Period; label: string }[] = [
    { key: 'all', label: t('dashboard.allTime') }, { key: 'today', label: t('dashboard.today') },
    { key: 'week', label: t('dashboard.thisWeek') }, { key: 'month', label: t('dashboard.thisMonth') },
    { key: 'pickMonth', label: t('dashboard.pickMonth') }, { key: 'custom', label: t('dashboard.custom') },
  ];
  const toggleFleet = (id: string) => setSelectedFleets((prev) => prev.includes(id) ? prev.filter((fleet) => fleet !== id) : [...prev, id]);
  const Chip = ({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) => <TouchableOpacity style={[styles.chip, active && styles.chipActive]} onPress={onPress} activeOpacity={0.7}><Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text></TouchableOpacity>;

  return <ScrollView style={styles.container} contentContainerStyle={styles.content}>
    <View style={styles.intro}><Ionicons name="download-outline" size={28} color={colors.accent} /><View style={styles.introText}><Text style={styles.title}>{t('dashboard.exportTitle')}</Text><Text style={styles.subtitle}>{t('export.description')}</Text></View></View>
    {isAdmin ? <View style={styles.section}><Text style={styles.sectionLabel}>{t('dashboard.fleets')}</Text><View style={styles.chipRow}><Chip label={t('dashboard.allFleets')} active={!selectedFleets.length} onPress={() => setSelectedFleets([])} />{fleetList.map((fleet) => <Chip key={fleet.fleet_id} label={fleet.fleet_id} active={selectedFleets.includes(fleet.fleet_id)} onPress={() => toggleFleet(fleet.fleet_id)} />)}{!fleetsLoaded && <ActivityIndicator size="small" color={colors.accent} />}</View></View> : fleetId ? <View style={styles.section}><Text style={styles.sectionLabel}>{t('dashboard.fleet')}</Text><Chip label={fleetId} active onPress={() => undefined} /></View> : null}
    <View style={styles.section}><Text style={styles.sectionLabel}>{t('dashboard.timePeriod')}</Text><View style={styles.chipRow}>{chips.map((chip) => <Chip key={chip.key} label={chip.label} active={period === chip.key} onPress={() => setPeriod(chip.key)} />)}</View></View>
    {period === 'pickMonth' && <View style={styles.section}><Text style={styles.sectionLabel}>{t('dashboard.month')}</Text><View style={styles.chipRow}>{months.map((month) => <Chip key={month.value} label={month.label} active={pickedMonth === month.value} onPress={() => setPickedMonth(month.value)} />)}</View></View>}
    {period === 'custom' && <View style={styles.section}><Text style={styles.sectionLabel}>{t('dashboard.from')}</Text><DateField label={t('dashboard.from')} value={dateStart} onChange={setDateStart} /><Text style={[styles.sectionLabel, { marginTop: spacing.sm }]}>{t('dashboard.to')}</Text><DateField label={t('dashboard.to')} value={dateEnd} onChange={setDateEnd} /></View>}
    <TouchableOpacity style={[styles.exportButton, exporting && styles.disabled]} onPress={exportReport} disabled={exporting} activeOpacity={0.8}>{exporting ? <ActivityIndicator size="small" color="#fff" /> : <><Ionicons name="download-outline" size={18} color="#fff" /><Text style={styles.exportButtonText}>{t('dashboard.export')}</Text></>}</TouchableOpacity>
  </ScrollView>;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background }, content: { padding: spacing.md, paddingBottom: spacing.xl },
  intro: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.white, borderRadius: borderRadius.md, padding: spacing.md }, introText: { flex: 1, marginLeft: spacing.md }, title: { fontSize: 18, fontWeight: '700', color: colors.textPrimary }, subtitle: { fontSize: 13, color: colors.textSecondary, marginTop: 4 },
  section: { paddingTop: spacing.lg }, sectionLabel: { fontSize: 13, fontWeight: '600', color: colors.textSecondary, marginBottom: spacing.sm, textTransform: 'uppercase', letterSpacing: 0.4 }, chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }, chip: { paddingHorizontal: spacing.md, paddingVertical: 9, borderRadius: borderRadius.full, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.inputBackground }, chipActive: { backgroundColor: colors.accent, borderColor: colors.accent }, chipText: { fontSize: 13, fontWeight: '600', color: colors.textPrimary }, chipTextActive: { color: '#fff' }, exportButton: { flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent, borderRadius: borderRadius.sm, paddingVertical: 14, marginTop: spacing.xl }, exportButtonText: { fontSize: 15, fontWeight: '700', color: '#fff' }, disabled: { opacity: 0.6 },
});
