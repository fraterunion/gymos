import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BrandButton } from '@/components/BrandButton';
import { TAB_BAR_CLEARANCE } from '@/components/FloatingTabBar';
import { LoadRetryPanel, ScreenLoader } from '@/components/StudioScreenChrome';
import { useBranding } from '@/contexts/BrandingContext';
import {
  MemberRow,
  SpotlightSearch,
  StaffScreenHeader,
  TabStrip,
} from '@/components/staff/StaffPrimitives';
import { getColors, Space } from '@/constants/Theme';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import {
  fetchStaff,
  type StaffMemberDto,
  type StaffRole,
} from '@/lib/api/staffApi';
import {
  formatStaffRoleLabel,
} from '@/lib/staffLabels';
import { canAccessTeamTab, canManageTeam } from '@/lib/staffRole';
import { canAccessMembersDirectory } from '@/lib/memberProfilePermissions';
import { membersDirectoryHref } from '@/lib/memberProfileRoutes';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';

type RoleFilter = 'ALL' | StaffRole;

const ROLE_FILTERS: { id: RoleFilter; label: string }[] = [
  { id: 'ALL', label: 'Todos' },
  { id: 'INSTRUCTOR', label: 'Coaches' },
  { id: 'FRONT_DESK', label: 'Recepción' },
  { id: 'OWNER', label: 'Dueños' },
  { id: 'ADMIN', label: 'Admin' },
  { id: 'STAFF', label: 'Staff' },
];

export default function StaffTeamScreen() {
  const router = useRouter();
  const C = getColors();
  const { primaryColor } = useBranding();
  const { matched, refetch } = useMemberStudio();
  const studioId = matched?.studio.id;
  const role = matched?.role;
  const canManage = canManageTeam(role);

  const [staff, setStaff] = useState<StaffMemberDto[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('ALL');

  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipFilterReload = useRef(true);

  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => {
      if (searchTimeout.current) clearTimeout(searchTimeout.current);
    };
  }, [search]);

  useFocusEffect(
    useCallback(() => {
      if (!canAccessTeamTab(role)) {
        router.replace('/(app)/(staff-tabs)/profile' as Href);
      }
    }, [role, router]),
  );

  const load = useCallback(
    async (isRefresh = false) => {
      if (!studioId || !canAccessTeamTab(role)) return;
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const res = await fetchStaff(studioId, {
          limit: 100,
          ...(debouncedSearch ? { search: debouncedSearch } : {}),
          ...(roleFilter !== 'ALL' ? { role: roleFilter } : {}),
        });
        setStaff(Array.isArray(res.data) ? res.data : []);
        setTotal(typeof res.total === 'number' ? res.total : 0);
      } catch (e) {
        setError(userFacingApiMessage(e, 'No pudimos cargar tu equipo. Desliza hacia abajo para actualizar e inténtalo de nuevo.'));
        if (!isRefresh) {
          setStaff([]);
          setTotal(0);
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
        setLoadedOnce(true);
      }
    },
    [studioId, role, debouncedSearch, roleFilter],
  );

  useFocusEffect(
    useCallback(() => {
      if (studioId && canAccessTeamTab(role)) void load();
    }, [studioId, role, load]),
  );

  useEffect(() => {
    if (!loadedOnce || !studioId || !canAccessTeamTab(role)) return;
    if (skipFilterReload.current) {
      skipFilterReload.current = false;
      return;
    }
    void load();
  }, [debouncedSearch, roleFilter, loadedOnce, studioId, role, load]);

  if (!canAccessTeamTab(role)) {
    return <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} />;
  }

  if (!studioId) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <LoadRetryPanel
          message="No pudimos cargar tu estudio. Revisa tu conexión e inténtalo de nuevo."
          onRetry={() => void refetch()}
        />
      </SafeAreaView>
    );
  }

  if (loading && !loadedOnce) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <ScreenLoader />
      </SafeAreaView>
    );
  }

  if (error && staff.length === 0) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <LoadRetryPanel message={error} onRetry={() => void load()} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['left', 'right', 'top']}>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: Space.screenH, paddingBottom: TAB_BAR_CLEARANCE }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor="rgba(255,255,255,0.35)" />
        }
        keyboardShouldPersistTaps="handled"
      >
        <StaffScreenHeader title="Equipo" />

        {canManage ? (
          <View style={{ marginBottom: Space.sp3 }}>
            <BrandButton
              label="Agregar staff"
              accentColor={primaryColor}
              onPress={() => router.push('/(app)/staff-member/add' as Href)}
            />
          </View>
        ) : null}

        {/* Members directory entry — open row, no card chrome */}
        {canAccessMembersDirectory(role) && role === 'STAFF' ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push(membersDirectoryHref())}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: Space.sp2,
              paddingVertical: Space.sp2,
              marginBottom: Space.sp2,
              borderBottomWidth: 1,
              borderBottomColor: C.separator,
              opacity: pressed ? 0.88 : 1,
            })}
          >
            <FontAwesome name="users" size={16} color={C.text} style={{ width: 20 }} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, fontWeight: '600', color: C.text, letterSpacing: -0.3 }}>Miembros</Text>
              <Text style={{ fontSize: 13, color: C.textMute, marginTop: 2 }}>Directorio del estudio</Text>
            </View>
            <FontAwesome name="chevron-right" size={12} color={C.textMute} />
          </Pressable>
        ) : null}

        <SpotlightSearch
          value={search}
          onChangeText={setSearch}
          placeholder="Buscar por nombre o correo…"
        />

        {/* Text tab strip — GymOS signature via shared TabStrip component */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 4 }}
        >
          <TabStrip<RoleFilter>
            options={ROLE_FILTERS}
            value={roleFilter}
            onChange={setRoleFilter}
            style={{ marginBottom: 0 }}
          />
        </ScrollView>
        <View style={{ height: 1, backgroundColor: C.separator, marginBottom: Space.sp3 }} />

        {error ? <Text style={{ fontSize: 13, color: C.textSub, marginBottom: Space.sp1 }}>{error}</Text> : null}

        {total > 0 ? (
          <Text style={{ fontSize: 12, color: C.textMute, marginBottom: Space.sp2 }}>
            {total} miembro{total !== 1 ? 's' : ''}
          </Text>
        ) : null}

        {/* Staff list — no bordered container wrapper */}
        {staff.length === 0 ? (
          <View style={{ paddingTop: Space.sp3, paddingBottom: Space.sp4 }}>
            <Text style={{ fontSize: 17, fontWeight: '600', color: C.text }}>
              No se encontraron miembros.
            </Text>
            <Text style={{ fontSize: 14, color: C.textSub, marginTop: 6, lineHeight: 21 }}>
              {debouncedSearch || roleFilter !== 'ALL'
                ? 'Ajusta tu búsqueda o filtro.'
                : 'El directorio del equipo está vacío.'}
            </Text>
          </View>
        ) : (
          staff.map((member, index) => {
            const { user, staffProfile, role: memberRole } = member;
            const isActive = staffProfile ? staffProfile.isActive : true;
            const initials = `${user.firstName?.[0] ?? ''}${user.lastName?.[0] ?? ''}`.toUpperCase();
            // Role + status as plain subtitle text — no pill chrome
            const roleLabel = formatStaffRoleLabel(memberRole);
            const statusLabel = isActive ? '' : ' · Inactivo';
            return (
              <MemberRow
                key={member.membershipId}
                initials={initials || '?'}
                name={`${user.firstName} ${user.lastName}`}
                subtitle={`${roleLabel}${statusLabel}`}
                trailing={
                  <FontAwesome
                    name="chevron-right"
                    size={12}
                    color={isActive ? C.textMute : C.separator}
                  />
                }
                index={index}
                onPress={() => router.push(`/(app)/staff-member/${member.userId}` as Href)}
              />
            );
          })
        )}

        {!canManage ? (
          <Text style={{ fontSize: 12, color: C.textMute, textAlign: 'center', marginTop: 32, lineHeight: 18 }}>
            Los cambios del equipo los administran OWNER y ADMIN.
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
