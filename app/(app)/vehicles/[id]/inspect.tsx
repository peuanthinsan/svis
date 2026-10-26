import { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { Image } from 'expo-image';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter, Stack, Redirect } from 'expo-router';
import { useAuth } from '../../../../lib/auth-context';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import { colors, spacing, borderRadius, shadows, statusColors } from '../../../../constants/theme';
import { useI18n } from '../../../../lib/i18n-context';
import { ApiError, apiFetch, API_BASE, getAuthToken } from '../../../../lib/api';
import { useConnectivity } from '../../../../lib/offline/connectivity';
import { cacheVehicles, getCachedVehicle, cacheChecklist, getCachedChecklist } from '../../../../lib/offline/cache-service';
import { queueInspection } from '../../../../lib/offline/sync-service';
import { SyncStatusBanner } from '../../../../components/SyncStatusBanner';
import { getTodayThai, getMondayOfWeekThai } from '../../../../lib/format-date';
import { ZONE_SECTIONS, VEHICLE_TYPE_I18N_KEYS, type ChecklistItem, type ChecklistSection, type InspectionZone, type Vehicle } from '../../../../lib/types';
import { useRole } from '../../../../lib/useRole';
import VehicleMap from '../../../../components/VehicleMap';

type ItemResult = 'pass' | 'fail';
type Frequency = 'daily' | 'weekly' | 'post_route';

const SECTION_ORDER: ChecklistSection[] = [
  'front', 'rear', 'sides', 'top', 'underbody', 'cabin', 'cargo', 'documents', 'supplies',
];

const ZONE_ORDER: InspectionZone[] = ['front', 'cabin', 'cargo_supplies', 'exterior_tires'];

const FREQUENCY_TABS: Frequency[] = ['daily', 'weekly', 'post_route'];

export default function InspectScreen() {
  const { isVehicleOwner } = useRole();
  const { id } = useLocalSearchParams<{ id: string }>();
  if (isVehicleOwner) return <Redirect href={{ pathname: '/(app)/vehicles/[id]', params: { id } }} />;
  return <InspectForm />;
}

function InspectForm() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { t, locale } = useI18n();
  const { user } = useAuth();
  const { isAdmin } = useRole();
  const { isOnline, refreshPendingCount } = useConnectivity();

  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [checklistItems, setChecklistItems] = useState<ChecklistItem[]>([]);
  const [results, setResults] = useState<Record<string, ItemResult>>({});
  const [photosByItem, setPhotosByItem] = useState<Record<string, string[]>>({});
  const [notesByItem, setNotesByItem] = useState<Record<string, string>>({});
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});
  const [activeZone, setActiveZone] = useState<InspectionZone | null>(null);
  const [photos, setPhotos] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [frequency, setFrequency] = useState<Frequency>('daily');
  const [mileage, setMileage] = useState('');
  const [odometerPhoto, setOdometerPhoto] = useState<string | null>(null);
  const [vehicleUsable, setVehicleUsable] = useState<boolean | null>(null);
  const [carryoverItems, setCarryoverItems] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [existingInspectionId, setExistingInspectionId] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [readOnlyInspector, setReadOnlyInspector] = useState('');
  const [checklistError, setChecklistError] = useState(false);
  const [diagramVisible, setDiagramVisible] = useState(false);
  const checklistRequestRef = useRef(0);
  const checklistScrollRef = useRef<ScrollView>(null);

  const failCount = checklistItems.filter(ci => results[ci.id] === 'fail').length;
  const hasFailures = failCount > 0;
  const answeredCount = checklistItems.filter(ci => results[ci.id] === 'pass' || results[ci.id] === 'fail').length;
  const allItemsAnswered = checklistItems.length > 0 && checklistItems.every(it => results[it.id] === 'pass' || results[it.id] === 'fail');
  const mileageValid = /^\d+$/.test(mileage.trim()) && parseInt(mileage.trim(), 10) >= 0;
  const odometerProvided = !!odometerPhoto;
  const canSubmit = !submitting && checklistItems.length > 0 && allItemsAnswered && mileageValid && odometerProvided && vehicleUsable !== null;
  const completionPercent = checklistItems.length > 0
    ? Math.round((answeredCount / checklistItems.length) * 100)
    : 0;
  const completedRequirements = [
    allItemsAnswered,
    mileageValid && odometerProvided,
    vehicleUsable !== null,
  ];
  const remainingRequirements = completedRequirements.filter((complete) => !complete).length;

  const presentSections = SECTION_ORDER.filter((s) =>
    checklistItems.some((ci) => ci.section === s)
  );

  // Zone-based filtering: active zone maps to multiple sections
  const activeZoneSections = activeZone ? ZONE_SECTIONS[activeZone] : null;
  const visibleItems = activeZoneSections
    ? checklistItems.filter((ci) => activeZoneSections.includes(ci.section))
    : checklistItems;
  const visibleFailCount = visibleItems.filter((item) => results[item.id] === 'fail').length;

  // Per-zone fail counts and statuses
  const zoneFailCounts: Record<InspectionZone, number> = { front: 0, cabin: 0, cargo_supplies: 0, exterior_tires: 0 };
  const zoneItemCounts: Record<InspectionZone, number> = { front: 0, cabin: 0, cargo_supplies: 0, exterior_tires: 0 };
  const zoneStatuses: Record<InspectionZone, 'pending' | 'pass' | 'fail'> = {
    front: 'pending', cabin: 'pending', cargo_supplies: 'pending', exterior_tires: 'pending',
  };
  for (const zone of ZONE_ORDER) {
    const sections = ZONE_SECTIONS[zone];
    const zoneItems = checklistItems.filter((ci) => sections.includes(ci.section));
    zoneItemCounts[zone] = zoneItems.length;
    if (zoneItems.length === 0) continue;
    let fails = 0;
    let allChecked = true;
    for (const ci of zoneItems) {
      if (results[ci.id] === 'fail') fails++;
      if (!results[ci.id]) allChecked = false;
    }
    zoneFailCounts[zone] = fails;
    if (fails > 0) zoneStatuses[zone] = 'fail';
    else if (allChecked && zoneItems.length > 0) zoneStatuses[zone] = 'pass';
  }

  const zoneLabels: Record<InspectionZone, string> = {
    front: t('zone.front' as any),
    cabin: t('zone.cabin' as any),
    cargo_supplies: t('zone.cargo_supplies' as any),
    exterior_tires: t('zone.exterior_tires' as any),
  };

  const selectZone = useCallback((zone: InspectionZone | null) => {
    setActiveZone(zone);
    // A zone behaves like a tab: replace the list and start at its first item.
    checklistScrollRef.current?.scrollTo({ y: 0, animated: false });
  }, []);

  useEffect(() => {
    loadData();
  }, [id]);

  useEffect(() => {
    if (vehicle) {
      loadChecklist(vehicle.vehicle_type);
    }
  }, [frequency]);

  // getMondayOfWeekThai imported from lib/format-date

  async function loadChecklist(vehicleType: string) {
    if (!user?.companyId) return;
    const requestId = ++checklistRequestRef.current;
    try {
      setChecklistError(false);
      const checklistType = vehicleType === 'e_van' ? 'e_van' : vehicleType;
      let items: ChecklistItem[];
      if (!isOnline) {
        const cached = await getCachedChecklist(user.companyId, checklistType, frequency);
        if (!cached) throw new Error('No cached checklist');
        items = cached;
      } else {
        try {
          items = await apiFetch(
            `/api/checklist?vehicleType=${checklistType}&frequency=${frequency}`
          );
          // Cache for offline use
          void cacheChecklist(user.companyId, checklistType, frequency, items);
        } catch (error) {
          if (error instanceof ApiError) throw error;
          const cached = await getCachedChecklist(user.companyId, checklistType, frequency);
          if (!cached) throw new Error('No cached checklist');
          items = cached;
        }
      }
      if (requestId !== checklistRequestRef.current) return;
      setChecklistItems(items);

      // Start with the complete checklist. Zones are optional filters.
      setActiveZone(null);

      // Default to NO selection so the driver explicitly marks every item.
      setResults({});
      setPhotosByItem({});
      setNotesByItem({});
      setExpandedItems({});

      // Reset edit/readOnly state when frequency changes
      setEditMode(false);
      setExistingInspectionId(null);
      setReadOnly(false);
      setReadOnlyInspector('');
      setPhotos([]);
      setNotes('');
      setMileage('');
      setOdometerPhoto(null);
      setVehicleUsable(null);
      setCarryoverItems(new Set());

      // Cached checklist data is sufficient to begin an offline inspection.
      // Existing-inspection and carryover lookups are network-only and would
      // otherwise keep the screen behind the loading state until timeout.
      if (!isOnline) return;

      // Check for existing inspection
      try {
        let logs;
        if (frequency === 'weekly') {
          const monday = getMondayOfWeekThai();
          logs = await apiFetch(
            `/api/inspections?vehicleId=${id}&since=${monday}&frequency=${frequency}`
          );
        } else {
          const today = getTodayThai();
          logs = await apiFetch(
            `/api/inspections?vehicleId=${id}&date=${today}&frequency=${frequency}`
          );
        }
        if (requestId !== checklistRequestRef.current) return;

        if (logs.length > 0) {
          const existing = logs[0];
          if (existing.inspector_id === user?.id || isAdmin) {
            // This driver's own inspection or admin editing — load in edit mode
            setEditMode(true);
            setExistingInspectionId(existing.id);
            setNotes(existing.notes || '');
            // Pre-fill results from existing inspection
            if (existing.results) {
              const savedResults: Record<string, ItemResult> = {};
              const savedPhotos: Record<string, string[]> = {};
              const savedNotes: Record<string, string> = {};
              for (const r of existing.results) {
                const matchingItem = items.find(
                  (ci: ChecklistItem) => ci.id === r.checklist_item_id
                );
                if (matchingItem) {
                  savedResults[matchingItem.id] = r.result as ItemResult;
                  if (Array.isArray(r.photo_urls) && r.photo_urls.length > 0) {
                    savedPhotos[matchingItem.id] = r.photo_urls.filter(
                      (u: string) => u && !u.includes('placeholder')
                    );
                  }
                  if (r.notes) savedNotes[matchingItem.id] = r.notes;
                }
              }
              setResults(prev => ({ ...prev, ...savedResults }));
              setPhotosByItem(savedPhotos);
              setNotesByItem(savedNotes);
            }
            // Load existing photos
            if (existing.photo_urls) {
              setPhotos(existing.photo_urls.filter((u: string) => u && !u.includes('placeholder')));
            }
            // Load existing mileage / odometer photo
            if (typeof existing.mileage === 'number') {
              setMileage(String(existing.mileage));
            }
            if (existing.odometer_photo_url) {
              setOdometerPhoto(existing.odometer_photo_url);
            }
            if (typeof existing.vehicle_usable === 'boolean') {
              setVehicleUsable(existing.vehicle_usable);
            }
          } else {
            // Different driver inspected — show read-only message
            setReadOnly(true);
            setReadOnlyInspector(existing.inspector_name);
          }
        } else if (frequency !== 'post_route') {
          // Fresh inspection: defects still open from earlier inspections default to
          // fail until resolved (client request) — the driver flips them to pass once fixed.
          try {
            const carry = await apiFetch(`/api/inspections?vehicleId=${id}&carryover=1`);
            if (requestId !== checklistRequestRef.current) return;
            const preFilled: Record<string, ItemResult> = {};
            const ids = new Set<string>();
            for (const c of carry?.items ?? []) {
              const match = items.find((ci: ChecklistItem) => ci.id === c.checklist_item_id);
              if (match) {
                preFilled[match.id] = 'fail';
                ids.add(match.id);
              }
            }
            if (ids.size > 0) {
              setResults(prev => ({ ...prev, ...preFilled }));
              setExpandedItems(prev => {
                const next = { ...prev };
                ids.forEach(itemId => { next[itemId] = true; });
                return next;
              });
              setCarryoverItems(ids);
            }
          } catch {
            // Offline or endpoint unavailable — the driver marks items manually.
          }
        }
      } catch (err) {
        console.error('Failed to check existing inspection:', err);
      }
    } catch (err) {
      console.error('Failed to load checklist:', err);
      if (requestId === checklistRequestRef.current) setChecklistError(true);
    }
  }

  async function loadData() {
    if (!user?.companyId) return;
    try {
      let found;
      if (!isOnline) {
        found = await getCachedVehicle(
          user.companyId,
          id!,
          isAdmin ? undefined : user.fleetId
        );
      } else {
        try {
          found = await apiFetch(`/api/vehicles?id=${id}`);
          // Cache for offline
          if (found) void cacheVehicles(user.companyId, [found]);
        } catch (error) {
          if (error instanceof ApiError) throw error;
          found = await getCachedVehicle(
            user.companyId,
            id!,
            isAdmin ? undefined : user.fleetId
          );
        }
      }
      if (found) {
        setVehicle(found);
        await loadChecklist(found.vehicle_type);
      }
    } catch (err) {
      console.error('Failed to load inspection data:', err);
    } finally {
      setLoading(false);
    }
  }

  const toggleResult = useCallback((itemId: string, value: ItemResult) => {
    Haptics.impactAsync(value === 'fail' ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light);
    setResults(prev => ({ ...prev, [itemId]: value }));
    // Auto-expand the row when user marks it as failed so they can immediately add photo/notes.
    if (value === 'fail') {
      setExpandedItems(prev => ({ ...prev, [itemId]: true }));
    }
  }, []);

  const toggleExpanded = useCallback((itemId: string) => {
    setExpandedItems(prev => ({ ...prev, [itemId]: !prev[itemId] }));
  }, []);

  const setItemNote = useCallback((itemId: string, value: string) => {
    setNotesByItem(prev => ({ ...prev, [itemId]: value }));
  }, []);

  async function addItemPhotoFromCamera(itemId: string) {
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) { Alert.alert('', t('general.cameraPermission')); return; }
      const result = await ImagePicker.launchCameraAsync({ quality: 0.7 });
      if (!result.canceled && result.assets?.[0]?.uri) {
        const uri = result.assets[0].uri;
        setPhotosByItem(prev => ({ ...prev, [itemId]: [...(prev[itemId] || []), uri] }));
      }
    } catch (err: any) {
      Alert.alert(t('general.cameraError'), err.message || t('general.cameraError'));
    }
  }

  async function addItemPhotoFromLibrary(itemId: string) {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ quality: 0.7 });
      if (!result.canceled && result.assets?.[0]?.uri) {
        const uri = result.assets[0].uri;
        setPhotosByItem(prev => ({ ...prev, [itemId]: [...(prev[itemId] || []), uri] }));
      }
    } catch (err: any) {
      Alert.alert(t('general.galleryError'), err.message || t('general.galleryError'));
    }
  }

  function removeItemPhoto(itemId: string, index: number) {
    setPhotosByItem(prev => {
      const list = prev[itemId] || [];
      return { ...prev, [itemId]: list.filter((_, i) => i !== index) };
    });
  }

  async function takePhoto() {
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('', t('general.cameraPermission'));
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        quality: 0.7,
      });
      if (!result.canceled && result.assets?.[0]?.uri) {
        setPhotos(prev => [...prev, result.assets[0].uri]);
      }
    } catch (err: any) {
      Alert.alert(t('general.cameraError'), err.message || t('general.cameraError'));
    }
  }

  async function pickPhoto() {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        quality: 0.7,
      });
      if (!result.canceled && result.assets?.[0]?.uri) {
        setPhotos(prev => [...prev, result.assets[0].uri]);
      }
    } catch (err: any) {
      Alert.alert(t('general.galleryError'), err.message || t('general.galleryError'));
    }
  }

  function removePhoto(index: number) {
    setPhotos(prev => prev.filter((_, i) => i !== index));
  }

  async function takeOdometerPhoto() {
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('', t('general.cameraPermission'));
        return;
      }
      const result = await ImagePicker.launchCameraAsync({ quality: 0.7 });
      if (!result.canceled && result.assets?.[0]?.uri) {
        setOdometerPhoto(result.assets[0].uri);
      }
    } catch (err: any) {
      Alert.alert(t('general.cameraError'), err.message || t('general.cameraError'));
    }
  }

  async function pickOdometerPhoto() {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ quality: 0.7 });
      if (!result.canceled && result.assets?.[0]?.uri) {
        setOdometerPhoto(result.assets[0].uri);
      }
    } catch (err: any) {
      Alert.alert(t('general.galleryError'), err.message || t('general.galleryError'));
    }
  }

  async function handleClearInspection() {
    if (!existingInspectionId) return;
    Alert.alert(
      t('inspection.clearTitle'),
      t('inspection.clearConfirm'),
      [
        { text: t('admin.cancel'), style: 'cancel' },
        {
          text: t('admin.delete'),
          style: 'destructive',
          onPress: async () => {
            try {
              await apiFetch(`/api/inspections?inspectionId=${existingInspectionId}`, {
                method: 'DELETE',
              });
              Alert.alert('', t('inspection.cleared'), [
                { text: 'OK', onPress: () => router.replace('/(app)/vehicles') },
              ]);
            } catch (err: any) {
              Alert.alert(t('general.error'), err.message);
            }
          },
        },
      ]
    );
  }

  async function handleSubmit() {
    if (!vehicle || !user?.id) return;

    // Validation: every item must have an explicit pass/fail selection (no defaults).
    const unanswered = checklistItems.filter((it) => results[it.id] !== 'pass' && results[it.id] !== 'fail');
    if (unanswered.length > 0) {
      const firstUnanswered = unanswered[0];
      const unansweredZone = ZONE_ORDER.find((z) => ZONE_SECTIONS[z].includes(firstUnanswered.section));
      if (unansweredZone) selectZone(unansweredZone);
      Alert.alert(
        t('inspection.allItemsRequired'),
        `${locale === 'th' ? firstUnanswered.item_name_th : firstUnanswered.item_name_en}`,
      );
      return;
    }

    // Validation: every failed item must have at least one photo.
    const missingPhotoItems = checklistItems.filter(
      (it) => results[it.id] === 'fail' && (photosByItem[it.id]?.length ?? 0) === 0
    );
    if (missingPhotoItems.length > 0) {
      const firstMissing = missingPhotoItems[0];
      // Open the tab containing the first missing item so the user sees it.
      const missingZone = ZONE_ORDER.find((z) => ZONE_SECTIONS[z].includes(firstMissing.section));
      if (missingZone) selectZone(missingZone);
      Alert.alert(t('inspection.itemPhotoRequired'),
        `${locale === 'th' ? firstMissing.item_name_th : firstMissing.item_name_en}`);
      return;
    }

    // Validation: mileage + odometer photo are mandatory.
    const mileageStr = mileage.trim();
    if (!/^\d+$/.test(mileageStr)) {
      Alert.alert(t('inspection.mileageRequired'), '');
      return;
    }
    const mileageNum = parseInt(mileageStr, 10);
    if (!odometerPhoto) {
      Alert.alert(t('inspection.odometerPhotoRequired'), '');
      return;
    }

    // Validation: the final usable question must be answered (drives Out of Service).
    if (vehicleUsable === null) {
      Alert.alert(t('inspection.vehicleUsableRequired'), '');
      return;
    }

    setSubmitting(true);

    const today = getTodayThai();
    const inspectorName = user
      ? `${user.firstName} ${user.lastName}`.trim()
      : 'Unknown';

    // Offline: queue for later sync — photos (global + per-item) persisted locally.
    if (!isOnline && !editMode) {
      try {
        const resultsPayload = checklistItems.map(item => ({
          checklistItemId: item.id,
          result: results[item.id]!,
          photoUrls: [] as string[], // filled during sync
          notes: notesByItem[item.id] || '',
        }));
        const payload = {
          vehicleId: vehicle.id,
          inspectionDate: today,
          inspectorId: user?.id,
          inspectorName,
          fleetId: vehicle.fleet_id,
          results: resultsPayload,
          photoUrls: [],
          notes,
          frequency,
          mileage: mileageNum,
          odometerPhotoLocal: odometerPhoto,
          vehicleUsable,
        };
        await queueInspection(
          `${user.companyId}:${user.id}`,
          payload,
          photos,
          photosByItem
        );
        await refreshPendingCount();
        Alert.alert('', t('offline.savedOffline'), [
          { text: 'OK', onPress: () => router.replace('/(app)/vehicles') },
        ]);
      } catch (err: any) {
        Alert.alert(t('general.error'), err.message);
      } finally {
        setSubmitting(false);
      }
      return;
    }

    try {
      const uploadOne = async (photoUri: string): Promise<string> => {
        if (photoUri.startsWith('http')) return photoUri;
        const formData = new FormData();
        const filename = `inspection-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`;
        formData.append('file', {
          uri: photoUri,
          type: 'image/jpeg',
          name: filename,
        } as any);

        const token = await getAuthToken();
        const uploadRes = await fetch(`${API_BASE}/api/upload?filename=${filename}`, {
          method: 'POST',
          body: formData,
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
        if (!uploadRes.ok) throw new Error('Photo upload failed');
        const uploadData = await uploadRes.json();
        return uploadData.url as string;
      };

      // Upload inspection-level photos
      const photoUrls = await Promise.all(photos.map(uploadOne));

      // Upload odometer photo
      const odometerPhotoUrl = await uploadOne(odometerPhoto);

      // Upload per-item photos in parallel across all items
      const itemEntries = Object.entries(photosByItem);
      const uploadedByItemEntries = await Promise.all(
        itemEntries.map(async ([itemId, uris]) => {
          const urls = await Promise.all(uris.map(uploadOne));
          return [itemId, urls] as const;
        })
      );
      const uploadedByItem: Record<string, string[]> = Object.fromEntries(uploadedByItemEntries);

      const resultsPayload = checklistItems.map(item => ({
        checklistItemId: item.id,
        result: results[item.id]!,
        photoUrls: uploadedByItem[item.id] ?? [],
        notes: notesByItem[item.id] || '',
      }));

      if (editMode && existingInspectionId) {
        await apiFetch('/api/inspections', {
          method: 'PUT',
          body: JSON.stringify({
            inspectionId: existingInspectionId,
            results: resultsPayload,
            photoUrls,
            notes,
            mileage: mileageNum,
            odometerPhotoUrl,
            vehicleUsable,
          }),
        });
      } else {
        const payload = {
          vehicleId: vehicle.id,
          inspectionDate: today,
          inspectorId: user?.id,
          inspectorName,
          fleetId: vehicle.fleet_id,
          results: resultsPayload,
          photoUrls,
          notes,
          frequency,
          mileage: mileageNum,
          odometerPhotoUrl,
          vehicleUsable,
        };

        await apiFetch('/api/inspections', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }

      Alert.alert('', t('inspection.success'), [
        { text: 'OK', onPress: () => router.replace('/(app)/vehicles') },
      ]);
    } catch (err: any) {
      if (err.message?.includes('Already inspected by')) {
        Alert.alert('', err.message);
      } else if (err.message?.includes('already inspected')) {
        Alert.alert('', t('inspection.alreadyInspected'));
      } else {
        Alert.alert(t('general.error'), err.message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  if (!vehicle) {
    return (
      <View style={styles.center}>
        <Ionicons name="alert-circle-outline" size={48} color={colors.textSecondary} style={{ marginBottom: spacing.sm }} />
        <Text style={styles.errorText}>{t('general.error')}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: editMode ? t('inspection.editTitle') : t('inspection.daily'),
          headerLeft: () => (
            <TouchableOpacity onPress={() => router.replace('/(app)/vehicles')} style={{ paddingRight: spacing.sm }}>
              <Ionicons name="arrow-back" size={24} color={colors.onPrimary} />
            </TouchableOpacity>
          ),
        }}
      />

      <SyncStatusBanner />

      {/* Read-only state: another driver already inspected */}
      {readOnly && (
        <View style={styles.readOnlyContainer}>
          <Ionicons name="information-circle-outline" size={48} color={colors.accent} style={{ marginBottom: spacing.md }} />
          <Text style={styles.readOnlyTitle}>
            {t('inspection.alreadyCheckedBy')}
          </Text>
          <Text style={styles.readOnlyName}>{readOnlyInspector}</Text>
          <TouchableOpacity
            style={styles.readOnlyBackBtn}
            onPress={() => router.replace('/(app)/vehicles')}
            activeOpacity={0.7}
          >
            <Ionicons name="arrow-back" size={18} color={colors.white} style={{ marginRight: 6 }} />
            <Text style={styles.readOnlyBackText}>{t('nav.vehicles')}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Vehicle header */}
      {!readOnly && (
      <>
      <View style={styles.vehicleHeader}>
        <View style={styles.vehicleIdentityRow}>
          <View style={styles.vehicleIdentity}>
            <Text style={styles.plateNumber}>{vehicle.plate_number}</Text>
            <View style={styles.vehicleMetaRow}>
              <View style={styles.vehicleMetaItem}>
                <Ionicons name="business-outline" size={13} color={styles.fleetText.color} />
                <Text style={styles.fleetText}>{vehicle.fleet_id}</Text>
              </View>
              <View style={styles.vehicleMetaDivider} />
              <View style={styles.vehicleMetaItem}>
                <Ionicons name="car-outline" size={13} color={styles.fleetText.color} />
                <Text style={styles.fleetText}>{t(VEHICLE_TYPE_I18N_KEYS[vehicle.vehicle_type])}</Text>
              </View>
            </View>
            <View style={styles.vehicleMetaItem}>
              <Ionicons name="calendar-clear-outline" size={13} color={styles.dateText.color} />
              <Text style={styles.dateText}>
                {(() => {
                  const d = new Date();
                  const dd = String(d.getDate()).padStart(2, '0');
                  const mm = String(d.getMonth() + 1).padStart(2, '0');
                  const yyyy = d.getFullYear();
                  return `${dd}/${mm}/${yyyy}`;
                })()}
              </Text>
            </View>
          </View>
          {editMode && (
            <View style={styles.editBadge}>
              <Ionicons name="create-outline" size={13} color={colors.white} />
              <Text style={styles.editBadgeText}>{t('inspection.editing')}</Text>
            </View>
          )}
          <View style={styles.completionStamp}>
            <Text style={styles.completionNumber}>{answeredCount}/{checklistItems.length}</Text>
            <Text style={styles.completionLabel}>{completionPercent}%</Text>
          </View>
        </View>

        <View style={styles.headerProgressTrack}>
          <View style={[styles.headerProgressFill, { width: `${completionPercent}%` }]} />
        </View>
      </View>

      {/* Frequency toggle */}
      <View style={styles.frequencySection}>
        <View style={styles.frequencyRow}>
          {FREQUENCY_TABS.map((freq) => (
            <TouchableOpacity
              key={freq}
              style={[styles.frequencyBtn, frequency === freq && styles.frequencyBtnActive]}
              onPress={() => setFrequency(freq)}
              activeOpacity={0.7}
              accessibilityRole="tab"
              accessibilityState={{ selected: frequency === freq }}
            >
              <Text style={[styles.frequencyText, frequency === freq && styles.frequencyTextActive]} numberOfLines={1}>
                {freq === 'daily'
                  ? t('inspection.dailyEvent')
                  : freq === 'weekly'
                  ? t('inspection.weeklyEvent')
                  : t('inspection.postRouteEvent')}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Interactive vehicle zone map */}
      {checklistItems.length > 0 && vehicle && (
        <VehicleMap
          vehicleType={vehicle.vehicle_type}
          zoneStatuses={zoneStatuses}
          zoneFailCounts={zoneFailCounts}
          zoneItemCounts={zoneItemCounts}
          totalItemCount={checklistItems.length}
          activeZone={activeZone}
          onZonePress={(zone) => selectZone(zone)}
          onAllZonesPress={() => selectZone(null)}
          zoneLabels={zoneLabels}
          allZonesLabel={t('inspection.allZones')}
          title={t('inspection.vehicleDiagram')}
          diagramVisible={diagramVisible}
          onToggleDiagram={() => setDiagramVisible(v => !v)}
        />
      )}

      {/* Checklist */}
      <ScrollView ref={checklistScrollRef} style={styles.scrollArea} contentContainerStyle={styles.scrollContent}>
        <View style={styles.zoneContentHeader}>
          <View>
            <Text style={styles.zoneContentEyebrow}>{t('inspection.showingItems')}</Text>
            <Text style={styles.zoneContentTitle}>
              {activeZone ? zoneLabels[activeZone] : t('inspection.allZones')}
            </Text>
          </View>
          <View style={styles.zoneContentCount}>
            <Text style={styles.zoneContentCountNumber}>{visibleItems.length}</Text>
            <Text style={styles.zoneContentCountLabel}>{t('inspection.items')}</Text>
          </View>
        </View>
        {carryoverItems.size > 0 && (
          <View style={styles.carryoverBanner}>
            <Ionicons name="alert-circle" size={18} color={colors.accent} style={{ marginRight: 6 }} />
            <Text style={styles.carryoverText}>{t('inspection.carryoverNotice')}</Text>
          </View>
        )}
        {checklistError && (
          <View style={{ padding: spacing.lg, alignItems: 'center' }}>
            <Ionicons name="alert-circle-outline" size={48} color={colors.accent} />
            <Text style={{ color: colors.textSecondary, marginTop: spacing.sm }}>{t('general.error')}</Text>
            <TouchableOpacity
              style={{ marginTop: spacing.md, backgroundColor: colors.primary, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: borderRadius.sm }}
              onPress={() => vehicle && loadChecklist(vehicle.vehicle_type)}
              activeOpacity={0.7}
            >
              <Text style={{ fontWeight: '600', color: colors.onPrimary }}>{t('general.retry')}</Text>
            </TouchableOpacity>
          </View>
        )}
        {activeZone && visibleItems.length === 0 && (
          <View style={styles.emptyZone}>
            <Ionicons name="list-outline" size={28} color={colors.textTertiary} />
            <Text style={styles.emptyZoneText}>{t('inspection.noItemsInZone')}</Text>
          </View>
        )}
        {visibleItems.map((item, itemIndex) => {
          const itemResult = results[item.id];
          const itemPhotos = photosByItem[item.id] || [];
          const itemNote = notesByItem[item.id] || '';
          const needsPhoto = itemResult === 'fail' && itemPhotos.length === 0;
          // Expanded when: user manually expanded, item is failed, or details already exist.
          const expanded =
            expandedItems[item.id] ||
            itemResult === 'fail' ||
            itemPhotos.length > 0 ||
            !!itemNote;
          return (
            <View
              key={item.id}
              style={[
                styles.checkCard,
                itemResult === 'pass' && styles.checkCardPass,
                itemResult === 'fail' && styles.checkCardFail,
              ]}
            >
              <View style={styles.checkCardHeader}>
                <TouchableOpacity
                  style={styles.checkLabelWrap}
                  onPress={() => toggleExpanded(item.id)}
                  activeOpacity={0.6}
                >
                  <View style={[
                    styles.itemOrderBadge,
                    itemResult === 'pass' && styles.itemOrderBadgePass,
                    itemResult === 'fail' && styles.itemOrderBadgeFail,
                  ]}>
                    <Text style={[
                      styles.itemOrderText,
                      !!itemResult && styles.itemOrderTextSelected,
                    ]}>{String(itemIndex + 1).padStart(2, '0')}</Text>
                  </View>
                  <View style={styles.checkLabelCopy}>
                    <Text style={styles.checkLabel}>
                      {locale === 'th' ? item.item_name_th : item.item_name_en}
                    </Text>
                  {/* Collapsed-state indicators */}
                    <View style={styles.indicatorRow}>
                      {itemPhotos.length > 0 && (
                        <View style={styles.indicatorChip}>
                          <Ionicons name="camera" size={11} color={colors.accent} />
                          <Text style={styles.indicatorText}>{itemPhotos.length}</Text>
                        </View>
                      )}
                      {!!itemNote && (
                        <Ionicons
                          name="chatbubble-ellipses"
                          size={12}
                          color={colors.accent}
                          style={{ marginLeft: 6 }}
                        />
                      )}
                      <Ionicons
                        name={expanded ? 'chevron-up' : 'chevron-down'}
                        size={14}
                        color={colors.textTertiary}
                        style={{ marginLeft: 6 }}
                      />
                    </View>
                  </View>
                </TouchableOpacity>
                <View style={styles.toggleRow}>
                  <TouchableOpacity
                    style={[styles.toggleBtn, itemResult === 'pass' && styles.togglePass]}
                    onPress={() => toggleResult(item.id, 'pass')}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={`${locale === 'th' ? item.item_name_th : item.item_name_en} - ${t('inspection.pass')}`}
                    accessibilityState={{ selected: itemResult === 'pass' }}
                  >
                    <Ionicons
                      name="checkmark-circle-outline"
                      size={16}
                      color={itemResult === 'pass' ? colors.white : colors.statusPass}
                    />
                    <Text style={[styles.toggleText, itemResult === 'pass' && styles.toggleTextActive]}>
                      {t('inspection.pass')}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.toggleBtn, itemResult === 'fail' && styles.toggleFail]}
                    onPress={() => toggleResult(item.id, 'fail')}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={`${locale === 'th' ? item.item_name_th : item.item_name_en} - ${t('inspection.fail')}`}
                    accessibilityState={{ selected: itemResult === 'fail' }}
                  >
                    <Ionicons
                      name="close-circle-outline"
                      size={16}
                      color={itemResult === 'fail' ? colors.white : colors.statusFail}
                    />
                    <Text style={[styles.toggleText, itemResult === 'fail' && styles.toggleTextActive]}>
                      {t('inspection.fail')}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>

              {expanded && (
                <>
                  {/* Per-item photos */}
                  <View style={styles.itemPhotoRow}>
                    {itemPhotos.map((uri, idx) => (
                      <View key={idx} style={styles.itemPhotoThumb}>
                        <Image source={{ uri }} style={styles.itemPhotoImage} />
                        <TouchableOpacity
                          style={styles.itemPhotoRemove}
                          onPress={() => removeItemPhoto(item.id, idx)}
                        >
                          <Ionicons name="close" size={12} color={colors.white} />
                        </TouchableOpacity>
                      </View>
                    ))}
                    <TouchableOpacity
                      style={[styles.itemPhotoAdd, needsPhoto && styles.itemPhotoAddRequired]}
                      onPress={() => addItemPhotoFromCamera(item.id)}
                      onLongPress={() => addItemPhotoFromLibrary(item.id)}
                      activeOpacity={0.7}
                    >
                      <Ionicons
                        name="camera-outline"
                        size={20}
                        color={needsPhoto ? colors.statusFail : colors.accent}
                      />
                    </TouchableOpacity>
                  </View>

                  {needsPhoto && (
                    <Text style={styles.itemPhotoRequired}>
                      {t('inspection.itemPhotoRequired')}
                    </Text>
                  )}

                  {/* Per-item note */}
                  <TextInput
                    style={styles.itemNoteInput}
                    placeholder={t('inspection.itemNotesPlaceholder')}
                    placeholderTextColor={colors.textTertiary}
                    value={itemNote}
                    onChangeText={(v) => setItemNote(item.id, v)}
                  />
                </>
              )}
            </View>
          );
        })}

        {/* Photo section */}
        {checklistItems.length > 0 && (
          <View style={styles.photoSection}>
            <View style={styles.formSectionHeader}>
              <View style={styles.formSectionIcon}>
                <Ionicons name="document-attach-outline" size={19} color={colors.accent} />
              </View>
              <View style={styles.formSectionCopy}>
                <Text style={styles.photoSectionTitle}>{t('inspection.evidenceTitle')}</Text>
              </View>
              <View style={styles.optionalBadge}>
                <Text style={styles.optionalBadgeText}>{t('inspection.optional')}</Text>
              </View>
            </View>
            {visibleFailCount > 0 && (
              <Text style={styles.failCountText}>
                {t('inspection.failCount').replace('{count}', String(visibleFailCount))}
              </Text>
            )}

            <View style={styles.photoButtons}>
              <TouchableOpacity style={styles.photoBtn} onPress={takePhoto} activeOpacity={0.7}>
                <Ionicons name="camera-outline" size={20} color={colors.accent} style={{ marginRight: 6 }} />
                <Text style={styles.photoBtnText}>{t('inspection.takePhoto')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.photoBtn} onPress={pickPhoto} activeOpacity={0.7}>
                <Ionicons name="images-outline" size={20} color={colors.accent} style={{ marginRight: 6 }} />
                <Text style={styles.photoBtnText}>{t('inspection.pickPhoto')}</Text>
              </TouchableOpacity>
            </View>

            {photos.length > 0 && (
              <View style={styles.photoGrid}>
                {photos.map((uri, idx) => (
                  <View key={idx} style={styles.photoThumb}>
                    <Image source={{ uri }} style={styles.photoImage} />
                    <TouchableOpacity
                      style={styles.photoRemove}
                      onPress={() => removePhoto(idx)}
                    >
                      <Ionicons name="close" size={14} color={colors.white} />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}
          </View>
        )}

        {/* Mileage section */}
        <View style={styles.mileageSection}>
          <View style={styles.formSectionHeader}>
            <View style={styles.formSectionIcon}>
              <Ionicons name="speedometer-outline" size={19} color={colors.accent} />
            </View>
            <View style={styles.formSectionCopy}>
              <Text style={styles.mileageSectionTitle}>{t('inspection.mileageRecordTitle')}</Text>
            </View>
            <View style={styles.requiredBadge}>
              <Text style={styles.requiredBadgeText}>{t('inspection.required')}</Text>
            </View>
          </View>
          <Text style={styles.fieldLabel}>{t('inspection.currentMileage')}</Text>
          <TextInput
            style={[styles.mileageInput, !mileageValid && mileage.length > 0 && styles.mileageInputInvalid]}
            placeholder={t('inspection.mileagePlaceholder')}
            placeholderTextColor={colors.textTertiary}
            value={mileage}
            onChangeText={(v) => setMileage(v.replace(/[^0-9]/g, ''))}
            keyboardType="number-pad"
            maxLength={9}
          />
          <Text style={styles.mileageHint}>
            {t('inspection.odometerPhoto')}
            <Text style={styles.mileageRequiredMark}> *</Text>
          </Text>
          <View style={styles.odometerPhotoRow}>
            {odometerPhoto ? (
              <View style={styles.odometerPhotoThumb}>
                <Image source={{ uri: odometerPhoto }} style={styles.odometerPhotoImage} />
                <TouchableOpacity
                  style={styles.odometerPhotoRemove}
                  onPress={() => setOdometerPhoto(null)}
                >
                  <Ionicons name="close" size={14} color={colors.white} />
                </TouchableOpacity>
              </View>
            ) : (
              <>
                <TouchableOpacity style={styles.photoBtn} onPress={takeOdometerPhoto} activeOpacity={0.7}>
                  <Ionicons name="camera-outline" size={20} color={colors.accent} style={{ marginRight: 6 }} />
                  <Text style={styles.photoBtnText}>{t('inspection.takePhoto')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.photoBtn} onPress={pickOdometerPhoto} activeOpacity={0.7}>
                  <Ionicons name="images-outline" size={20} color={colors.accent} style={{ marginRight: 6 }} />
                  <Text style={styles.photoBtnText}>{t('inspection.pickPhoto')}</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>

        {/* Final question: is the vehicle usable? (drives the Out of Service card) */}
        <View style={styles.usableSection}>
          <View style={styles.formSectionHeader}>
            <View style={styles.formSectionIcon}>
              <Ionicons name="shield-checkmark-outline" size={19} color={colors.accent} />
            </View>
            <View style={styles.formSectionCopy}>
              <Text style={styles.usableSectionTitle}>{t('inspection.readinessTitle')}</Text>
            </View>
            <View style={styles.requiredBadge}>
              <Text style={styles.requiredBadgeText}>{t('inspection.required')}</Text>
            </View>
          </View>
          <Text style={styles.fieldLabel}>{t('inspection.vehicleUsable')}</Text>
          <View style={styles.usableRow}>
            <TouchableOpacity
              style={[styles.usableBtn, vehicleUsable === true && styles.usableBtnYes]}
              onPress={() => setVehicleUsable(true)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={t('inspection.vehicleUsableYes')}
              accessibilityState={{ selected: vehicleUsable === true }}
            >
              <Text style={[styles.usableText, vehicleUsable === true && styles.toggleTextActive]}>
                {t('inspection.vehicleUsableYes')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.usableBtn, vehicleUsable === false && styles.usableBtnNo]}
              onPress={() => setVehicleUsable(false)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={t('inspection.vehicleUsableNo')}
              accessibilityState={{ selected: vehicleUsable === false }}
            >
              <Text style={[styles.usableText, vehicleUsable === false && styles.toggleTextActive]}>
                {t('inspection.vehicleUsableNo')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Notes section */}
        <View style={styles.notesSection}>
          <View style={styles.formSectionHeader}>
            <View style={styles.formSectionIcon}>
              <Ionicons name="create-outline" size={19} color={colors.accent} />
            </View>
            <View style={styles.formSectionCopy}>
              <Text style={styles.notesSectionTitle}>{t('inspection.notes')}</Text>
            </View>
            <View style={styles.optionalBadge}>
              <Text style={styles.optionalBadgeText}>{t('inspection.optional')}</Text>
            </View>
          </View>
          <TextInput
            style={styles.notesInput}
            placeholder={t('inspection.notesPlaceholder')}
            placeholderTextColor={colors.textTertiary}
            value={notes}
            onChangeText={setNotes}
            multiline
            numberOfLines={3}
            textAlignVertical="top"
          />
        </View>

        <View style={{ height: 132 }} />
      </ScrollView>

      {/* Fixed submit button */}
      <View style={styles.submitBar}>
        {editMode && existingInspectionId && (
          <TouchableOpacity
            style={styles.clearBtn}
            onPress={handleClearInspection}
            activeOpacity={0.7}
          >
            <Ionicons name="trash-outline" size={16} color={colors.accent} style={{ marginRight: 4 }} />
            <Text style={styles.clearBtnText}>{t('inspection.clearInspection')}</Text>
          </TouchableOpacity>
        )}
        <View style={styles.submitStatusRow}>
          <View style={[styles.submitStatusIcon, canSubmit && styles.submitStatusIconReady]}>
            <Ionicons
              name={canSubmit ? 'checkmark' : 'hourglass-outline'}
              size={12}
              color={canSubmit ? colors.white : colors.textSecondary}
            />
          </View>
          <Text style={[styles.submitStatusText, canSubmit && styles.submitStatusTextReady]}>
            {canSubmit
              ? t('inspection.readyToSubmit')
              : t('inspection.requirementsRemaining').replace('{count}', String(remainingRequirements))}
          </Text>
          <Text style={styles.submitStatusCount}>{answeredCount}/{checklistItems.length}</Text>
        </View>
        <TouchableOpacity
          style={[
            styles.submitBtn,
            !hasFailures && styles.submitBtnPass,
            !canSubmit && styles.submitBtnDisabled,
          ]}
          onPress={handleSubmit}
          disabled={!canSubmit}
          activeOpacity={0.8}
        >
          {submitting ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <Text style={styles.submitBtnText}>
              {editMode
                ? t('inspection.updateInspection')
                : hasFailures
                ? t('inspection.submitFail')
                : t('inspection.submitPass')}
            </Text>
          )}
        </TouchableOpacity>
      </View>
      </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F1F4F6' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background },
  errorText: { fontSize: 16, color: colors.textSecondary },

  // Read-only state
  readOnlyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
  },
  readOnlyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: spacing.xs,
  },
  readOnlyName: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.accent,
    marginBottom: spacing.lg,
  },
  readOnlyBackBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.accent,
    paddingVertical: 12,
    paddingHorizontal: spacing.lg,
    borderRadius: borderRadius.md,
  },
  readOnlyBackText: {
    color: colors.white,
    fontSize: 15,
    fontWeight: '600',
  },

  // Edit badge
  editBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: 'auto',
    backgroundColor: 'rgba(255,255,255,0.14)',
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: borderRadius.full,
  },
  editBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.white,
  },

  // Vehicle header
  vehicleHeader: {
    paddingTop: 10,
    paddingBottom: 8,
    paddingHorizontal: spacing.md,
    backgroundColor: '#172B3A',
  },
  vehicleIdentityRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  vehicleIdentity: {
    flex: 1,
  },
  plateNumber: {
    fontSize: 21,
    lineHeight: 26,
    fontWeight: '900',
    letterSpacing: 0.3,
    color: colors.white,
  },
  vehicleMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    marginTop: 1,
  },
  vehicleMetaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 2,
  },
  vehicleMetaDivider: {
    width: 1,
    height: 12,
    marginHorizontal: spacing.sm,
    marginTop: 3,
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  fleetText: {
    fontSize: 12,
    color: '#C8D3DC',
    fontWeight: '600',
  },
  dateText: {
    fontSize: 12,
    color: '#98A9B6',
    fontWeight: '600',
  },
  completionStamp: {
    minWidth: 54,
    height: 46,
    marginLeft: 10,
    paddingHorizontal: 8,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.09)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  completionNumber: {
    fontSize: 14,
    fontWeight: '900',
    color: colors.white,
  },
  completionLabel: {
    fontSize: 8,
    fontWeight: '700',
    color: '#AFC0CC',
  },
  headerProgressTrack: {
    height: 3,
    marginTop: 7,
    borderRadius: borderRadius.full,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  headerProgressFill: {
    height: '100%',
    borderRadius: borderRadius.full,
    backgroundColor: colors.primary,
  },

  // Frequency toggle
  frequencySection: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  frequencyRow: {
    flexDirection: 'row',
    padding: 3,
    borderRadius: borderRadius.md,
    gap: 3,
    backgroundColor: '#EEF2F4',
  },
  frequencyBtn: {
    flex: 1,
    minHeight: 32,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 9,
  },
  frequencyBtnActive: {
    backgroundColor: colors.white,
    ...shadows.sm,
  },
  frequencyText: {
    fontSize: 12,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  frequencyTextActive: {
    color: '#172B3A',
    fontWeight: '800',
  },

  // Carryover banner
  carryoverBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    padding: spacing.sm,
    borderRadius: borderRadius.md,
    backgroundColor: statusColors.fail.bg,
  },
  carryoverText: {
    flex: 1,
    fontSize: 13,
    color: colors.accent,
    fontWeight: '600',
  },

  // Vehicle usable question
  usableSection: {
    padding: 12,
    marginTop: 8,
    marginHorizontal: spacing.md,
    backgroundColor: colors.white,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: '#E1E7EA',
    ...shadows.sm,
  },
  usableSectionTitle: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '800',
    color: '#172B3A',
  },
  usableRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  usableBtn: {
    flex: 1,
    minHeight: 46,
    paddingVertical: 12,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#F8FAFA',
    alignItems: 'center',
    justifyContent: 'center',
  },
  usableBtnYes: {
    backgroundColor: colors.statusPass,
    borderColor: colors.statusPass,
  },
  usableBtnNo: {
    backgroundColor: colors.statusFail,
    borderColor: colors.statusFail,
  },
  usableText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textSecondary,
  },

  // Notes
  notesSection: {
    padding: 12,
    marginTop: 8,
    marginHorizontal: spacing.md,
    backgroundColor: colors.white,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: '#E1E7EA',
    ...shadows.sm,
  },
  notesSectionTitle: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '800',
    color: '#172B3A',
  },

  // Mileage / odometer
  mileageSection: {
    padding: 12,
    marginTop: 8,
    marginHorizontal: spacing.md,
    backgroundColor: colors.white,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: '#E1E7EA',
    ...shadows.sm,
  },
  mileageSectionTitle: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '800',
    color: '#172B3A',
  },
  mileageRequiredMark: {
    color: colors.statusFail,
    fontWeight: '700',
  },
  mileageInput: {
    borderWidth: 1,
    borderColor: '#D8E0E4',
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 13,
    fontSize: 17,
    fontWeight: '700',
    color: colors.textPrimary,
    backgroundColor: '#F8FAFA',
    marginBottom: spacing.md,
  },
  mileageInputInvalid: {
    borderColor: colors.statusFail,
  },
  mileageHint: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textSecondary,
    marginBottom: spacing.sm,
  },
  odometerPhotoRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
  },
  odometerPhotoThumb: {
    width: 120,
    height: 90,
    borderRadius: borderRadius.sm,
    overflow: 'hidden',
    position: 'relative',
  },
  odometerPhotoImage: {
    width: 120,
    height: 90,
    resizeMode: 'cover',
  },
  odometerPhotoRemove: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  notesInput: {
    borderWidth: 1,
    borderColor: '#D8E0E4',
    borderRadius: borderRadius.md,
    padding: 12,
    fontSize: 14,
    color: colors.textPrimary,
    backgroundColor: '#F8FAFA',
    minHeight: 72,
  },

  // Formal form section heading
  formSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  formSectionIcon: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
    backgroundColor: colors.accent + '0D',
  },
  formSectionCopy: {
    flex: 1,
  },
  fieldLabel: {
    marginBottom: 7,
    fontSize: 12,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  optionalBadge: {
    marginLeft: spacing.sm,
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: borderRadius.full,
    backgroundColor: '#F0F3F5',
  },
  optionalBadgeText: {
    fontSize: 9,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  requiredBadge: {
    marginLeft: spacing.sm,
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: borderRadius.full,
    backgroundColor: statusColors.fail.bg,
  },
  requiredBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    color: colors.statusFail,
  },

  // Checklist
  scrollArea: { flex: 1 },
  scrollContent: { paddingBottom: spacing.md },
  zoneContentHeader: {
    minHeight: 58,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: '#F7F9FA',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  zoneContentEyebrow: {
    fontSize: 9,
    fontWeight: '800',
    color: colors.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.7,
  },
  zoneContentTitle: {
    marginTop: 2,
    fontSize: 14,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  zoneContentCount: {
    minWidth: 48,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: borderRadius.full,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  zoneContentCountNumber: {
    fontSize: 13,
    fontWeight: '900',
    color: colors.accent,
  },
  zoneContentCountLabel: {
    fontSize: 8,
    fontWeight: '700',
    color: colors.textTertiary,
  },
  emptyZone: {
    margin: spacing.md,
    padding: spacing.xl,
    alignItems: 'center',
    borderRadius: borderRadius.md,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
  },
  emptyZoneText: {
    marginTop: spacing.sm,
    fontSize: 12,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  checkCard: {
    marginHorizontal: spacing.md,
    marginTop: 7,
    paddingHorizontal: 10,
    paddingVertical: 9,
    backgroundColor: colors.white,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderLeftWidth: 4,
    borderColor: '#E1E7EA',
    borderLeftColor: '#C8D1D6',
    ...shadows.sm,
  },
  checkCardPass: {
    borderLeftColor: colors.statusPass,
  },
  checkCardFail: {
    borderLeftColor: colors.statusFail,
  },
  checkCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  checkLabelWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 8,
  },
  itemOrderBadge: {
    width: 27,
    height: 27,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
    backgroundColor: '#EEF2F4',
  },
  itemOrderBadgePass: {
    backgroundColor: colors.statusPass,
  },
  itemOrderBadgeFail: {
    backgroundColor: colors.statusFail,
  },
  itemOrderText: {
    fontSize: 10,
    fontWeight: '900',
    color: colors.textSecondary,
  },
  itemOrderTextSelected: {
    color: colors.white,
  },
  checkLabelCopy: {
    flex: 1,
  },
  checkLabel: {
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  indicatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
  },
  indicatorChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: colors.inputBackground,
  },
  indicatorText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.accent,
  },
  itemPhotoRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#EDF0F2',
  },
  itemPhotoThumb: {
    width: 56,
    height: 56,
    borderRadius: borderRadius.sm,
    overflow: 'hidden',
    position: 'relative',
  },
  itemPhotoImage: { width: 56, height: 56, resizeMode: 'cover' },
  itemPhotoRemove: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemPhotoAdd: {
    width: 56,
    height: 56,
    borderRadius: borderRadius.sm,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.inputBackground,
  },
  itemPhotoAddRequired: {
    borderColor: colors.statusFail,
    backgroundColor: statusColors.fail.bg,
  },
  itemPhotoRequired: {
    fontSize: 12,
    color: colors.statusFail,
    marginTop: 6,
    fontWeight: '600',
  },
  itemNoteInput: {
    marginTop: spacing.sm,
    borderWidth: 1,
    borderColor: '#D8E0E4',
    borderRadius: borderRadius.sm,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: colors.textPrimary,
    backgroundColor: '#F8FAFA',
  },

  // Toggle buttons
  toggleRow: {
    flexDirection: 'row',
    gap: 4,
  },
  toggleBtn: {
    minWidth: 66,
    minHeight: 40,
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: borderRadius.sm,
    borderWidth: 1,
    borderColor: '#D8E0E4',
    backgroundColor: '#F8FAFA',
    alignItems: 'center',
    justifyContent: 'center',
  },
  togglePass: {
    backgroundColor: colors.statusPass,
    borderColor: colors.statusPass,
  },
  toggleFail: {
    backgroundColor: colors.statusFail,
    borderColor: colors.statusFail,
  },
  toggleText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  toggleTextActive: {
    color: colors.white,
  },

  // Photo section
  photoSection: {
    padding: 12,
    marginTop: 8,
    marginHorizontal: spacing.md,
    backgroundColor: colors.white,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: '#E1E7EA',
    ...shadows.sm,
  },
  photoSectionTitle: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '800',
    color: '#172B3A',
  },
  failCountText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.statusFail,
    marginTop: -3,
    marginBottom: 12,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: borderRadius.sm,
    backgroundColor: statusColors.fail.bg,
  },
  photoButtons: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  photoBtn: {
    flex: 1,
    flexDirection: 'row',
    minHeight: 44,
    paddingVertical: 11,
    borderRadius: borderRadius.md,
    backgroundColor: '#F8FAFA',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#D8E0E4',
  },
  photoBtnText: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '600',
  },
  photoGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  photoThumb: {
    width: 80,
    height: 80,
    borderRadius: borderRadius.sm,
    overflow: 'hidden',
    position: 'relative',
  },
  photoImage: {
    width: 80,
    height: 80,
    resizeMode: 'cover',
  },
  photoRemove: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Submit bar
  submitBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: spacing.md,
    paddingTop: 10,
    paddingBottom: spacing.lg,
    backgroundColor: colors.white,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    ...shadows.lg,
  },
  submitStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  submitStatusIcon: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 7,
    backgroundColor: '#EEF2F4',
  },
  submitStatusIconReady: {
    backgroundColor: colors.statusPass,
  },
  submitStatusText: {
    flex: 1,
    fontSize: 11,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  submitStatusTextReady: {
    color: statusColors.pass.text,
  },
  submitStatusCount: {
    marginLeft: spacing.sm,
    fontSize: 11,
    fontWeight: '800',
    color: '#172B3A',
  },
  submitBtn: {
    backgroundColor: colors.accent,
    minHeight: 52,
    paddingVertical: 15,
    borderRadius: borderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitBtnPass: {
    backgroundColor: colors.statusPass,
  },
  submitBtnDisabled: {
    backgroundColor: '#AEB8BE',
  },
  clearBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    marginBottom: spacing.sm,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.accent + '40',
    backgroundColor: colors.accent + '08',
  },
  clearBtnText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: '600',
  },
  submitBtnText: {
    color: colors.white,
    fontSize: 17,
    fontWeight: '700',
  },
});
