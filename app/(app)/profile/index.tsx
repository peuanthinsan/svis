import { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  TextInput,
  Alert,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { colors, spacing, borderRadius, shadows } from '../../../constants/theme';
import { useI18n } from '../../../lib/i18n-context';
import { useAuth } from '../../../lib/auth-context';

export default function ProfileScreen() {
  const { user, signOut, changePassword, updateProfile } = useAuth();
  const { t, locale, setLocale } = useI18n();

  const [showNameEdit, setShowNameEdit] = useState(false);
  const [firstName, setFirstName] = useState(user?.firstName ?? '');
  const [lastName, setLastName] = useState(user?.lastName ?? '');
  const [savingName, setSavingName] = useState(false);

  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [savingPw, setSavingPw] = useState(false);

  const displayName = user ? `${user.firstName} ${user.lastName}` : '';
  const roleLabel = user?.role === 'vehicle_owner' ? t('profile.vehicleOwner') : user?.role
    ? user.role.charAt(0).toUpperCase() + user.role.slice(1)
    : '';
  const initials = `${user?.firstName?.[0] ?? ''}${user?.lastName?.[0] ?? ''}`.toUpperCase();

  async function handleSaveName() {
    if (!firstName.trim() || (user?.role !== 'vehicle_owner' && !lastName.trim())) return;
    setSavingName(true);
    try {
      await updateProfile(firstName.trim(), lastName.trim());
      Alert.alert('', t('profile.nameSaved'));
      setShowNameEdit(false);
    } catch (err: any) {
      Alert.alert(t('general.error'), err.message);
    } finally {
      setSavingName(false);
    }
  }

  async function handleChangePassword() {
    if (newPw !== confirmPw) {
      Alert.alert('', t('profile.passwordMismatch'));
      return;
    }
    if (!currentPw || !newPw) return;

    setSavingPw(true);
    try {
      await changePassword(currentPw, newPw);
      Alert.alert('', t('profile.passwordChanged'));
      setCurrentPw('');
      setNewPw('');
      setConfirmPw('');
      setShowPasswordForm(false);
    } catch (err: any) {
      Alert.alert(t('general.error'), err.message || t('general.error'));
    } finally {
      setSavingPw(false);
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
      {/* User info */}
      <View style={styles.infoCard}>
        <View style={styles.profileSummary}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials || 'SV'}</Text>
          </View>
          <View style={styles.profileSummaryText}>
            <Text style={styles.profileName} numberOfLines={1}>{displayName}</Text>
            <Text style={styles.profileMeta} numberOfLines={1}>
              {roleLabel}{user?.companyName ? ` · ${user.companyName}` : ''}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.editButton}
            onPress={() => {
              setFirstName(user?.firstName ?? '');
              setLastName(user?.lastName ?? '');
              setShowNameEdit(!showNameEdit);
            }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="pencil-outline" size={16} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>

        {showNameEdit && (
          <View style={styles.nameEditSection}>
            <View style={styles.nameRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>{t('profile.firstName')}</Text>
                <TextInput
                  style={styles.nameInput}
                  value={firstName}
                  onChangeText={setFirstName}
                  placeholder={t('profile.firstName')}
                  placeholderTextColor={colors.textTertiary}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>{t('profile.lastName')}</Text>
                <TextInput
                  style={styles.nameInput}
                  value={lastName}
                  onChangeText={setLastName}
                  placeholder={t('profile.lastName')}
                  placeholderTextColor={colors.textTertiary}
                />
              </View>
            </View>
            <TouchableOpacity
              style={[styles.saveNameBtn, (!firstName.trim() || !lastName.trim()) && styles.buttonDisabled]}
              onPress={handleSaveName}
              disabled={savingName || !firstName.trim() || !lastName.trim()}
              activeOpacity={0.8}
            >
              {savingName ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <Text style={styles.saveNameBtnText}>{t('profile.save')}</Text>
              )}
            </TouchableOpacity>
          </View>
        )}

        <View style={styles.infoDivider} />
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>{t('profile.company')}</Text>
          <Text style={styles.infoValue}>{user?.companyName}</Text>
        </View>
        {user?.fleetId ? (
          <>
            <View style={styles.infoDivider} />
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>{t('profile.fleet')}</Text>
              <Text style={styles.infoValue}>{user.fleetId}</Text>
            </View>
          </>
        ) : null}
      </View>

      {/* Language toggle */}
      <View style={styles.card}>
        <Text style={styles.cardLabel}>{t('profile.language')}</Text>
        <View style={styles.langRow}>
          <TouchableOpacity
            style={[styles.langOption, locale === 'th' && styles.langOptionActive]}
            onPress={() => setLocale('th')}
            activeOpacity={0.7}
          >
            <Text style={[styles.langOptionText, locale === 'th' && styles.langOptionTextActive]}>TH</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.langOption, locale === 'en' && styles.langOptionActive]}
            onPress={() => setLocale('en')}
            activeOpacity={0.7}
          >
            <Text style={[styles.langOptionText, locale === 'en' && styles.langOptionTextActive]}>EN</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Change Password */}
      <View style={styles.card}>
        <TouchableOpacity
          style={styles.cardHeaderTouchable}
          onPress={() => setShowPasswordForm(!showPasswordForm)}
          activeOpacity={0.7}
        >
          <Text style={styles.cardLabel}>{t('profile.changePassword')}</Text>
          <Ionicons name={showPasswordForm ? 'chevron-up' : 'chevron-down'} size={20} color={colors.textSecondary} />
        </TouchableOpacity>

        {showPasswordForm && (
          <View style={styles.passwordForm}>
            <View style={styles.inputWrapper}>
              <Ionicons name="key-outline" size={18} color={colors.textTertiary} style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder={t('profile.currentPassword')}
                placeholderTextColor={colors.textTertiary}
                secureTextEntry
                value={currentPw}
                onChangeText={setCurrentPw}
                autoCapitalize="none"
              />
            </View>
            <View style={styles.inputWrapper}>
              <Ionicons name="lock-open-outline" size={18} color={colors.textTertiary} style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder={t('profile.newPassword')}
                placeholderTextColor={colors.textTertiary}
                secureTextEntry
                value={newPw}
                onChangeText={setNewPw}
                autoCapitalize="none"
              />
            </View>
            <View style={styles.inputWrapper}>
              <Ionicons name="checkmark-circle-outline" size={18} color={colors.textTertiary} style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder={t('profile.confirmPassword')}
                placeholderTextColor={colors.textTertiary}
                secureTextEntry
                value={confirmPw}
                onChangeText={setConfirmPw}
                autoCapitalize="none"
              />
            </View>
            <TouchableOpacity
              style={[styles.saveButton, (!currentPw || !newPw || !confirmPw) && styles.buttonDisabled]}
              onPress={handleChangePassword}
              disabled={savingPw || !currentPw || !newPw || !confirmPw}
              activeOpacity={0.8}
            >
              {savingPw ? (
                <ActivityIndicator color={colors.onPrimary} />
              ) : (
                <Text style={styles.saveButtonText}>{t('profile.save')}</Text>
              )}
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Logout */}
      <TouchableOpacity style={styles.logoutButton} onPress={() => signOut()} activeOpacity={0.8}>
        <Ionicons name="log-out-outline" size={18} color={colors.statusFail} />
        <Text style={styles.logoutText}>{t('profile.logout')}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  scrollContent: { padding: 12, paddingBottom: spacing.xl },
  // Info card
  infoCard: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.md,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.sm,
  },
  profileSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: 12,
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    marginRight: 10,
  },
  avatarText: { fontSize: 15, fontWeight: '800', color: colors.onPrimary },
  profileSummaryText: { flex: 1 },
  profileName: { fontSize: 17, fontWeight: '700', color: colors.textPrimary },
  profileMeta: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  editButton: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: borderRadius.sm,
    backgroundColor: colors.inputBackground,
    borderWidth: 1,
    borderColor: colors.border,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 9,
  },
  infoDivider: {
    height: 1,
    backgroundColor: colors.border,
  },
  infoLabel: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  infoValue: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  // Name edit
  nameEditSection: {
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
  },
  nameRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  fieldLabel: {
    fontSize: 11,
    color: colors.textTertiary,
    marginBottom: 4,
  },
  nameInput: {
    backgroundColor: colors.inputBackground,
    borderRadius: borderRadius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    fontSize: 15,
    color: colors.textPrimary,
  },
  saveNameBtn: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius.sm,
    paddingVertical: spacing.sm + 2,
    alignItems: 'center',
  },
  saveNameBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.onPrimary,
  },
  // Cards
  card: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.md,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.sm,
  },
  cardHeaderTouchable: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: spacing.sm,
  },
  // Language
  langRow: {
    flexDirection: 'row',
    backgroundColor: colors.inputBackground,
    borderRadius: borderRadius.sm,
    padding: 4,
  },
  langOption: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: borderRadius.sm,
  },
  langOptionActive: {
    backgroundColor: colors.primary,
  },
  langOptionText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  langOptionTextActive: {
    color: colors.onPrimary,
    fontWeight: '700',
  },
  // Password
  passwordForm: { marginTop: spacing.md, gap: spacing.sm },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.inputBackground,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  inputIcon: {
    marginRight: spacing.sm,
  },
  input: {
    flex: 1,
    paddingVertical: 14,
    fontSize: 15,
    color: colors.textPrimary,
  },
  saveButton: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius.md,
    padding: 13,
    alignItems: 'center',
    marginTop: spacing.xs,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  saveButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.onPrimary,
  },
  // Logout
  logoutButton: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.statusFail + '55',
    padding: 13,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  logoutText: { color: colors.statusFail, fontSize: 14, fontWeight: '700' },
});
