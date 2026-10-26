import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  TouchableOpacity,
  Modal,
  TextInput,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { colors, spacing, borderRadius, shadows, statusColors } from '../../../constants/theme';
import { useI18n } from '../../../lib/i18n-context';
import { apiFetch } from '../../../lib/api';
import { useDebounce } from '../../../lib/useDebounce';

type Role = 'driver' | 'supervisor' | 'admin' | 'vehicle_owner';

type User = {
  id: string;
  username: string;
  first_name: string;
  last_name: string;
  role: Role;
  fleet_id: string | null;
  created_at?: string;
};

type FormState = {
  username: string;
  firstName: string;
  lastName: string;
  role: Role;
  fleetId: string;
  password: string;
};

type OwnerVehicle = {
  id: string;
  plate_number: string;
  fleet_id: string;
  vehicle_type: string;
  is_active?: boolean;
};

const ROLES: Role[] = ['driver', 'supervisor', 'admin', 'vehicle_owner'];

const ROLE_COLORS: Record<string, { bg: string; text: string }> = {
  driver: { bg: colors.primary + '30', text: colors.textPrimary },
  supervisor: { bg: statusColors.pass.bg, text: statusColors.pass.text },
  admin: { bg: colors.accent + '20', text: colors.accent },
  vehicle_owner: { bg: colors.primary + '15', text: colors.textPrimary },
};

const EMPTY_FORM: FormState = {
  username: '',
  firstName: '',
  lastName: '',
  role: 'driver',
  fleetId: '',
  password: '',
};

function isVehicleCatalog(value: unknown): value is OwnerVehicle[] {
  return Array.isArray(value) && value.every((vehicle) => vehicle && typeof vehicle.id === 'string'
    && typeof vehicle.plate_number === 'string' && typeof vehicle.fleet_id === 'string'
    && typeof vehicle.vehicle_type === 'string');
}

/** Fetch every catalog page before allowing a new/converting owner's selection to be saved. */
export async function loadMobileOwnerSelection(
  user: Pick<User, 'id' | 'role'> | null,
  fetcher: (path: string) => Promise<any> = apiFetch,
  isCurrent: () => boolean = () => true,
): Promise<{ vehicles: OwnerVehicle[]; selectedVehicleIds: string[] }> {
  const assertCurrent = () => { if (!isCurrent()) throw new Error('Vehicle selection request superseded'); };
  assertCurrent();
  if (user?.role === 'vehicle_owner') {
    const data = await fetcher(`/api/admin/users/${user.id}/vehicles`);
    assertCurrent();
    if (!data || !isVehicleCatalog(data.vehicles) || !Array.isArray(data.selectedVehicleIds)
      || data.selectedVehicleIds.some((id: unknown) => typeof id !== 'string'
        || !data.vehicles.some((vehicle: OwnerVehicle) => vehicle.id === id))) {
      throw new Error('Invalid vehicle selection response');
    }
    return { vehicles: data.vehicles, selectedVehicleIds: [...new Set<string>(data.selectedVehicleIds)] };
  }

  const vehicles = new Map<string, OwnerVehicle>();
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    assertCurrent();
    const page = await fetcher(`/api/admin/vehicles?limit=${pageSize}&offset=${offset}`);
    assertCurrent();
    if (!isVehicleCatalog(page)) throw new Error('Invalid vehicle catalog response');
    const previousSize = vehicles.size;
    for (const vehicle of page) vehicles.set(vehicle.id, vehicle);
    if (page.length < pageSize) break;
    if (vehicles.size === previousSize) throw new Error('Vehicle catalog pagination did not advance');
  }
  return { vehicles: [...vehicles.values()], selectedVehicleIds: [] };
}

export function mobileOwnerSelectionCanSave(role: Role, ready: boolean, loading: boolean, error: string | null) {
  return role !== 'vehicle_owner' || (ready && !loading && !error);
}

export function buildMobileUserPayload(form: FormState, selectedVehicleIds: string[], editing: boolean) {
  const body: Record<string, string | string[]> = {
    firstName: form.firstName.trim(), lastName: form.lastName.trim(), role: form.role,
    fleetId: form.role === 'vehicle_owner' ? '' : form.fleetId.trim(),
  };
  if (!editing) body.username = form.username.trim();
  if (!editing || form.password.trim()) body.password = form.password.trim();
  if (form.role === 'vehicle_owner') body.vehicleIds = [...selectedVehicleIds];
  return body;
}

export default function UsersManagementScreen() {
  const { t } = useI18n();

  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [hasMore, setHasMore] = useState(true);
  const offsetRef = useRef(0);
  const debouncedSearch = useDebounce(search, 300);

  // Modal state
  const [modalVisible, setModalVisible] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [ownerVehicles, setOwnerVehicles] = useState<OwnerVehicle[]>([]);
  const [selectedVehicleIds, setSelectedVehicleIds] = useState<string[]>([]);
  const [ownerLoading, setOwnerLoading] = useState(false);
  const [ownerReady, setOwnerReady] = useState(false);
  const [ownerError, setOwnerError] = useState<string | null>(null);
  const [ownerSearch, setOwnerSearch] = useState('');
  const [ownerVisibleLimit, setOwnerVisibleLimit] = useState(100);
  const ownerLoadGeneration = useRef(0);

  const selectedVehicles = useMemo(() => new Set(selectedVehicleIds), [selectedVehicleIds]);
  const filteredOwnerVehicles = useMemo(() => {
    const query = ownerSearch.trim().toLowerCase();
    return ownerVehicles.filter((vehicle) => `${vehicle.plate_number} ${vehicle.fleet_id}`.toLowerCase().includes(query));
  }, [ownerVehicles, ownerSearch]);
  const canSaveOwnerSelection = mobileOwnerSelectionCanSave(form.role, ownerReady, ownerLoading, ownerError);

  const loadOwnerSelection = useCallback(async () => {
    const generation = ++ownerLoadGeneration.current;
    const isCurrent = () => ownerLoadGeneration.current === generation;
    setOwnerLoading(true);
    setOwnerReady(false);
    setOwnerError(null);
    try {
      const selection = await loadMobileOwnerSelection(editingUser, apiFetch, isCurrent);
      if (!isCurrent()) return;
      setOwnerVehicles(selection.vehicles);
      setSelectedVehicleIds(selection.selectedVehicleIds);
      setOwnerReady(true);
    } catch {
      if (isCurrent()) setOwnerError(t('owner.loadFailed'));
    } finally {
      if (isCurrent()) setOwnerLoading(false);
    }
  }, [editingUser?.id, editingUser?.role, t]);

  useEffect(() => {
    if (modalVisible && form.role === 'vehicle_owner') void loadOwnerSelection();
    return () => { ownerLoadGeneration.current += 1; };
  }, [modalVisible, form.role, loadOwnerSelection]);

  const PAGE_LIMIT = 100;

  const fetchUsers = useCallback(async (reset = false) => {
    try {
      setError(null);
      const currentOffset = reset ? 0 : offsetRef.current;
      const params = new URLSearchParams();
      params.set('limit', String(PAGE_LIMIT));
      params.set('offset', String(currentOffset));
      if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());
      const data = await apiFetch(`/api/admin/users?${params.toString()}`);
      const fetched: User[] = Array.isArray(data) ? data : [];
      if (reset) {
        setUsers(fetched);
        offsetRef.current = fetched.length;
      } else {
        setUsers((prev) => {
          const existingIds = new Set(prev.map(u => u.id));
          return [...prev, ...fetched.filter(u => !existingIds.has(u.id))];
        });
        offsetRef.current = currentOffset + fetched.length;
      }
      setHasMore(fetched.length >= PAGE_LIMIT);
    } catch (err: any) {
      setError(err.message || t('general.error'));
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
    }
  }, [debouncedSearch]);

  useEffect(() => {
    setLoading(true);
    setUsers([]);
    offsetRef.current = 0;
    setHasMore(true);
    fetchUsers(true);
  }, [debouncedSearch]);

  const onRefresh = () => {
    setRefreshing(true);
    setUsers([]);
    offsetRef.current = 0;
    setHasMore(true);
    fetchUsers(true);
  };

  const loadMore = () => {
    if (!hasMore || loading || loadingMore) return;
    setLoadingMore(true);
    fetchUsers(false);
  };

  const resetOwnerSelection = () => {
    ownerLoadGeneration.current += 1;
    setOwnerVehicles([]);
    setSelectedVehicleIds([]);
    setOwnerReady(false);
    setOwnerLoading(false);
    setOwnerError(null);
    setOwnerSearch('');
    setOwnerVisibleLimit(100);
  };

  const openAdd = () => {
    resetOwnerSelection();
    setEditingUser(null);
    setForm(EMPTY_FORM);
    setModalVisible(true);
  };

  const openEdit = (user: User) => {
    resetOwnerSelection();
    setEditingUser(user);
    setForm({
      username: user.username,
      firstName: user.first_name,
      lastName: user.last_name,
      role: user.role,
      fleetId: user.fleet_id ?? '',
      password: '',
    });
    setModalVisible(true);
  };

  const closeModal = () => {
    resetOwnerSelection();
    setModalVisible(false);
    setEditingUser(null);
    setForm(EMPTY_FORM);
  };

  const handleSave = async () => {
    const { username, firstName, lastName, role, password } = form;

    if (saving || !canSaveOwnerSelection) return;

    if (!firstName.trim() || (role !== 'vehicle_owner' && !lastName.trim()) || !role) {
      Alert.alert(t('general.error'), t('admin.requiredUserDetails'));
      return;
    }
    if (!editingUser && (!username.trim() || !password.trim())) {
      Alert.alert(t('general.error'), t('admin.requiredCredentials'));
      return;
    }

    setSaving(true);
    try {
      const body = buildMobileUserPayload(form, selectedVehicleIds, Boolean(editingUser));
      if (editingUser) {
        const updated = await apiFetch(`/api/admin/users/${editingUser.id}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
        setUsers((prev) => prev.map((u) => (u.id === editingUser.id ? { ...u, ...updated } : u)));
        closeModal();
        Alert.alert('', t('admin.users.updated'));
      } else {
        const created = await apiFetch('/api/admin/users', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        setUsers((prev) => [created, ...prev]);
        closeModal();
        Alert.alert('', t('admin.users.created'));
      }
    } catch (err: any) {
      Alert.alert(t('general.error'), err.message || t('general.error'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (user: User) => {
    Alert.alert(
      t('admin.users.deleteConfirm'),
      `${user.first_name} ${user.last_name} (${user.username})`,
      [
        { text: t('admin.cancel'), style: 'cancel' },
        {
          text: t('admin.delete'),
          style: 'destructive',
          onPress: async () => {
            try {
              await apiFetch(`/api/admin/users/${user.id}`, { method: 'DELETE' });
              setUsers((prev) => prev.filter((u) => u.id !== user.id));
              Alert.alert('', t('admin.users.deleted'));
            } catch (err: any) {
              Alert.alert(t('general.error'), err.message || t('general.error'));
            }
          },
        },
      ]
    );
  };

  const renderItem = ({ item }: { item: User }) => {
    const roleStyle = ROLE_COLORS[item.role] ?? ROLE_COLORS.driver;
    return (
      <TouchableOpacity
        style={styles.userRow}
        onPress={() => openEdit(item)}
        activeOpacity={0.7}
      >
        {/* Avatar */}
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>
            {(item.first_name[0] ?? '?').toUpperCase()}
          </Text>
        </View>

        {/* Info */}
        <View style={styles.userInfo}>
          <Text style={styles.userName} numberOfLines={1}>
            {item.first_name} {item.last_name}
          </Text>
          <Text style={styles.userUsername} numberOfLines={1}>
            @{item.username}
            {item.fleet_id ? `  ·  ${item.fleet_id}` : ''}
          </Text>
        </View>

        {/* Role badge */}
        <View style={[styles.roleBadge, { backgroundColor: roleStyle.bg }]}>
          <Text style={[styles.roleText, { color: roleStyle.text }]}>
            {item.role === 'vehicle_owner' ? t('profile.vehicleOwner') : item.role}
          </Text>
        </View>

        {/* Delete */}
        <TouchableOpacity
          style={styles.deleteBtn}
          onPress={() => handleDelete(item)}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="trash-outline" size={18} color={colors.accent} />
        </TouchableOpacity>
      </TouchableOpacity>
    );
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.loadingText}>{t('general.loading')}</Text>
      </View>
    );
  }

  return (
    <>
      <View style={styles.container}>
        {/* Search + Add header row */}
        <View style={styles.headerRow}>
          <View style={styles.searchWrap}>
            <Ionicons name="search-outline" size={16} color={colors.textTertiary} style={styles.searchIcon} />
            <TextInput
              style={styles.searchInput}
              value={search}
              onChangeText={setSearch}
              placeholder={t('admin.search')}
              placeholderTextColor={colors.textTertiary}
              clearButtonMode="while-editing"
              autoCorrect={false}
              autoCapitalize="none"
            />
          </View>
          <TouchableOpacity style={styles.addButton} onPress={openAdd} activeOpacity={0.8}>
            <Ionicons name="person-add-outline" size={18} color={colors.onPrimary} />
          </TouchableOpacity>
        </View>

        {error ? (
          <View style={styles.errorSection}>
            <Ionicons name="alert-circle-outline" size={48} color={colors.accent} style={{ marginBottom: spacing.md }} />
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity
              style={styles.retryButton}
              onPress={() => { setLoading(true); fetchUsers(); }}
              activeOpacity={0.7}
            >
              <Text style={styles.retryText}>{t('general.retry')}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <FlatList
            data={users}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            contentContainerStyle={styles.listContent}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            ListEmptyComponent={
              <View style={styles.emptyWrap}>
                <Ionicons name="people-outline" size={48} color={colors.textTertiary} style={{ marginBottom: spacing.sm }} />
                <Text style={styles.emptyText}>{t('admin.noResults')}</Text>
              </View>
            }
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
            }
            onEndReachedThreshold={0.5}
            onEndReached={() => { if (hasMore && !loading) loadMore(); }}
            ListFooterComponent={loadingMore ? <ActivityIndicator style={styles.footerLoader} color={colors.primary} /> : null}
            initialNumToRender={15}
            maxToRenderPerBatch={10}
            windowSize={10}
          />
        )}
      </View>

      {/* Add / Edit Modal */}
      <Modal
        visible={modalVisible}
        transparent
        statusBarTranslucent
        animationType="fade"
        onRequestClose={() => { if (!saving) closeModal(); }}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={styles.modalCard}>
            {/* Header */}
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {editingUser ? t('admin.users.edit') : t('admin.users.add')}
              </Text>
              <TouchableOpacity onPress={closeModal} disabled={saving} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              {/* Username — only on create */}
              {!editingUser && (
                <>
                  <Text style={styles.fieldLabel}>{t('admin.users.username')}</Text>
                  <TextInput
                    style={styles.textInput}
                    value={form.username}
                    onChangeText={(v) => setForm((f) => ({ ...f, username: v }))}
                    placeholder="username"
                    placeholderTextColor={colors.textTertiary}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </>
              )}

              {/* First name */}
              <Text style={styles.fieldLabel}>{t(form.role === 'vehicle_owner' ? 'owner.customerName' : 'admin.users.firstName')}</Text>
              <TextInput
                style={styles.textInput}
                value={form.firstName}
                onChangeText={(v) => setForm((f) => ({ ...f, firstName: v }))}
                placeholder={t(form.role === 'vehicle_owner' ? 'owner.customerName' : 'admin.users.firstName')}
                placeholderTextColor={colors.textTertiary}
              />

              {/* Last name */}
              <Text style={styles.fieldLabel}>{t(form.role === 'vehicle_owner' ? 'owner.optionalLastName' : 'admin.users.lastName')}</Text>
              <TextInput
                style={styles.textInput}
                value={form.lastName}
                onChangeText={(v) => setForm((f) => ({ ...f, lastName: v }))}
                placeholder={t(form.role === 'vehicle_owner' ? 'owner.optionalLastName' : 'admin.users.lastName')}
                placeholderTextColor={colors.textTertiary}
              />

              {/* Role picker */}
              <Text style={styles.fieldLabel}>{t('admin.users.role')}</Text>
              <View style={styles.roleRow}>
                {ROLES.map((r) => {
                  const active = form.role === r;
                  return (
                    <TouchableOpacity
                      key={r}
                      style={[styles.roleChip, active && styles.roleChipActive]}
                      onPress={() => {
                        if (r === 'vehicle_owner' && form.role !== r) setOwnerReady(false);
                        setForm((f) => ({ ...f, role: r }));
                      }}
                      disabled={saving}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: active, disabled: saving }}
                      activeOpacity={0.75}
                    >
                      <Text style={[styles.roleChipText, active && styles.roleChipTextActive]}>
                        {r === 'vehicle_owner' ? t('profile.vehicleOwner') : r.charAt(0).toUpperCase() + r.slice(1)}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {form.role === 'vehicle_owner' ? (
                <View style={styles.ownerSection}>
                  <Text style={styles.fieldLabel}>{t('owner.assignedVehicles')}</Text>
                  <Text style={styles.ownerHint}>{t('owner.readOnly')} {t('owner.fleetUnchanged')}</Text>
                  {ownerLoading ? <ActivityIndicator style={styles.ownerLoader} color={colors.primary} /> : null}
                  {ownerError ? (
                    <View>
                      <Text style={styles.errorText}>{ownerError}</Text>
                      <TouchableOpacity style={styles.retryButton} onPress={() => void loadOwnerSelection()} disabled={saving}>
                        <Text style={styles.retryText}>{t('general.retry')}</Text>
                      </TouchableOpacity>
                    </View>
                  ) : null}
                  {ownerReady && !ownerLoading && !ownerError ? (
                    <>
                      <Text style={styles.ownerCount}>{t('owner.selectedCount').replace('{count}', String(selectedVehicleIds.length))}</Text>
                      <TextInput
                        style={styles.textInput}
                        value={ownerSearch}
                        onChangeText={(value) => { setOwnerSearch(value); setOwnerVisibleLimit(100); }}
                        placeholder={t('owner.searchVehicles')}
                        placeholderTextColor={colors.textTertiary}
                        accessibilityLabel={t('owner.searchVehicles')}
                        autoCorrect={false}
                        autoCapitalize="none"
                      />
                      <ScrollView style={styles.ownerList} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                        {filteredOwnerVehicles.slice(0, ownerVisibleLimit).map((vehicle) => {
                          const selected = selectedVehicles.has(vehicle.id);
                          return (
                            <TouchableOpacity
                              key={vehicle.id}
                              style={styles.ownerVehicle}
                              accessibilityRole="checkbox"
                              accessibilityState={{ checked: selected, disabled: saving }}
                              accessibilityLabel={`${vehicle.plate_number}, ${vehicle.fleet_id}`}
                              disabled={saving}
                              onPress={() => setSelectedVehicleIds((previous) => previous.includes(vehicle.id)
                                ? previous.filter((id) => id !== vehicle.id) : [...previous, vehicle.id])}
                            >
                              <Ionicons name={selected ? 'checkbox' : 'square-outline'} size={24} color={selected ? colors.textPrimary : colors.textTertiary} />
                              <View style={styles.ownerVehicleInfo}>
                                <Text style={styles.ownerPlate}>{vehicle.plate_number}</Text>
                                <Text style={styles.ownerHint}>{vehicle.fleet_id} · {vehicle.vehicle_type}{vehicle.is_active === false ? ` · ${t('owner.inactiveVehicle')}` : ''}</Text>
                              </View>
                            </TouchableOpacity>
                          );
                        })}
                        {!filteredOwnerVehicles.length ? <Text style={styles.ownerHint}>{t('admin.noResults')}</Text> : null}
                        {filteredOwnerVehicles.length > ownerVisibleLimit ? (
                          <TouchableOpacity style={styles.ownerMore} onPress={() => setOwnerVisibleLimit((count) => count + 100)}>
                            <Text style={styles.ownerPlate}>{t('admin.users.loadMore')}</Text>
                          </TouchableOpacity>
                        ) : null}
                      </ScrollView>
                      <Text style={styles.ownerHint}>{t('owner.showingVehicles')
                        .replace('{shown}', String(Math.min(filteredOwnerVehicles.length, ownerVisibleLimit)))
                        .replace('{total}', String(filteredOwnerVehicles.length))}</Text>
                      {!selectedVehicleIds.length ? <Text style={styles.ownerEmpty}>{t('owner.noSelection')}</Text> : null}
                    </>
                  ) : null}
                </View>
              ) : (
                <>
                  <Text style={styles.fieldLabel}>{t('admin.users.fleet')}</Text>
                  <TextInput
                    style={styles.textInput}
                    value={form.fleetId}
                    onChangeText={(v) => setForm((f) => ({ ...f, fleetId: v }))}
                    placeholder="e.g. BKK01"
                    placeholderTextColor={colors.textTertiary}
                    autoCapitalize="characters"
                    autoCorrect={false}
                  />
                </>
              )}

              {/* Password */}
              <Text style={styles.fieldLabel}>
                {editingUser ? t('admin.users.resetPassword') : t('admin.users.password')}
              </Text>
              <TextInput
                style={styles.textInput}
                value={form.password}
                onChangeText={(v) => setForm((f) => ({ ...f, password: v }))}
                placeholder={editingUser ? t('admin.users.resetPassword') : t('admin.users.password')}
                placeholderTextColor={colors.textTertiary}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
            </ScrollView>

            {/* Actions */}
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={closeModal}
                activeOpacity={0.7}
                disabled={saving}
              >
                <Text style={styles.cancelText}>{t('admin.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.saveButton, (saving || !canSaveOwnerSelection) && styles.saveButtonDisabled]}
                onPress={handleSave}
                activeOpacity={0.8}
                disabled={saving || !canSaveOwnerSelection}
              >
                {saving ? (
                  <ActivityIndicator size="small" color={colors.onPrimary} />
                ) : (
                  <Text style={styles.saveText}>{t('admin.save')}</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

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
  // Header row
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  searchWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.inputBackground,
    borderRadius: borderRadius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm,
  },
  searchIcon: {
    marginRight: spacing.xs,
  },
  searchInput: {
    flex: 1,
    height: 40,
    fontSize: 15,
    color: colors.textPrimary,
  },
  addButton: {
    width: 40,
    height: 40,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.sm,
  },
  footerLoader: {
    paddingVertical: spacing.md,
  },
  // List
  listContent: {
    padding: spacing.md,
    paddingBottom: spacing.xl,
  },
  separator: {
    height: 1,
    backgroundColor: colors.border,
    marginLeft: 68,
  },
  userRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.white,
    borderRadius: borderRadius.md,
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.sm,
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.primary + '30',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.sm,
  },
  avatarText: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  userInfo: {
    flex: 1,
    marginRight: spacing.sm,
  },
  userName: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: 2,
  },
  userUsername: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  roleBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: borderRadius.full,
    marginRight: spacing.sm,
  },
  roleText: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'capitalize',
  },
  deleteBtn: {
    padding: spacing.xs,
  },
  emptyWrap: {
    alignItems: 'center',
    paddingVertical: spacing.xl * 2,
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: 15,
  },
  // Error
  errorSection: {
    alignItems: 'center',
    padding: spacing.lg,
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
  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  modalCard: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    maxHeight: '85%',
    ...shadows.lg,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textSecondary,
    marginBottom: spacing.xs,
  },
  textInput: {
    backgroundColor: colors.inputBackground,
    borderRadius: borderRadius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 4,
    fontSize: 15,
    color: colors.textPrimary,
    marginBottom: spacing.md,
  },
  // Role picker row
  roleRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  roleChip: {
    flexGrow: 1,
    flexBasis: '45%',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm + 2,
    borderRadius: borderRadius.sm,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
  },
  roleChipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  roleChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  roleChipTextActive: {
    color: colors.onPrimary,
  },
  ownerSection: { marginBottom: spacing.md },
  ownerHint: { fontSize: 12, color: colors.textSecondary, lineHeight: 18 },
  ownerCount: { fontSize: 13, fontWeight: '600', color: colors.textPrimary, marginVertical: spacing.sm },
  ownerLoader: { marginVertical: spacing.md },
  ownerList: { maxHeight: 260, borderWidth: 1, borderColor: colors.border, borderRadius: borderRadius.sm, marginBottom: spacing.xs },
  ownerVehicle: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.sm, minHeight: 52, borderBottomWidth: 1, borderBottomColor: colors.border },
  ownerVehicleInfo: { flex: 1 },
  ownerPlate: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  ownerMore: { padding: spacing.md, alignItems: 'center' },
  ownerEmpty: { fontSize: 12, color: colors.accent, marginTop: spacing.sm },
  // Actions
  modalActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: spacing.sm + 4,
    borderRadius: borderRadius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  cancelText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  saveButton: {
    flex: 1,
    paddingVertical: spacing.sm + 4,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.primary,
    alignItems: 'center',
  },
  saveButtonDisabled: {
    opacity: 0.6,
  },
  saveText: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.onPrimary,
  },
});
