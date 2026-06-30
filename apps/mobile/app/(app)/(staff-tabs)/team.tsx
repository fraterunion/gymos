import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { BrandButton } from '@/components/BrandButton';
import { TAB_BAR_CLEARANCE } from '@/components/FloatingTabBar';
import { StaffAvatar } from '@/components/StaffAvatar';
import { useBranding } from '@/contexts/BrandingContext';
import { LoadRetryPanel, ScreenLoader } from '@/components/StudioScreenChrome';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import {
  fetchStaff,
  type StaffMemberDto,
  type StaffRole,
} from '@/lib/api/staffApi';
import {
  formatStaffRoleLabel,
  getStaffRoleChipStyle,
} from '@/lib/staffLabels';
import { canAccessTeamTab, canManageTeam } from '@/lib/staffRole';
import { canAccessMembersDirectory } from '@/lib/memberProfilePermissions';
import { membersDirectoryHref } from '@/lib/memberProfileRoutes';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';
import { getColors, Space, type ThemeColors } from '@/constants/Theme';

type RoleFilter = 'ALL' | StaffRole;

const ROLE_FILTERS: { id: RoleFilter; label: string }[] = [
  { id: 'ALL', label: 'Todos' },
  { id: 'OWNER', label: 'Dueños' },
  { id: 'ADMIN', label: 'Administradores' },
  { id: 'STAFF', label: 'Staff' },
  { id: 'INSTRUCTOR', label: 'Entrenadores' },
  { id: 'FRONT_DESK', label: 'Recepción' },
];

function cardStyle(C: ThemeColors) {
  return {
    backgroundColor: '#141416',
    borderRadius: 28,
    borderWidth: 1,
    borderColor: C.separator,
    padding: 20,
  } as const;
}

function RoleChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const C = getColors();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={{
        paddingVertical: 8,
        paddingHorizontal: 14,
        borderRadius: 100,
        borderWidth: 1,
        borderColor: selected ? 'rgba(255,255,255,0.35)' : C.separator,
        backgroundColor: selected ? 'rgba(255,255,255,0.12)' : 'transparent',
        marginRight: 8,
      }}
    >
      <Text
        style={{
          fontSize: 12,
          fontWeight: selected ? '700' : '600',
          color: selected ? C.text : C.textSub,
          letterSpacing: 0.2,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function ActiveBadge({ active }: { active: boolean }) {
  const C = getColors();
  return (
    <View
      style={{
        backgroundColor: active ? 'rgba(16,185,129,0.15)' : 'rgba(255,255,255,0.06)',
        borderRadius: 100,
        paddingVertical: 4,
        paddingHorizontal: 8,
      }}
    >
      <Text
        style={{
          fontSize: 10,
          fontWeight: '700',
          letterSpacing: 0.5,
          textTransform: 'uppercase',
          color: active ? '#6EE7B7' : C.textMute,
        }}
      >
        {active ? 'Activo' : 'Inactivo'}
      </Text>
    </View>
  );
}

function StaffCard({
  member,
  index,
  onPress,
}: {
  member: StaffMemberDto;
  index: number;
  onPress: () => void;
}) {
  const C = getColors();
  const { user, staffProfile, role } = member;
  const isActive = staffProfile ? staffProfile.isActive : true;
  const roleStyle = getStaffRoleChipStyle(role);

  return (
    <Animated.View entering={FadeInDown.delay(Math.min(index * 40, 200)).duration(420)}>
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => [
          cardStyle(C),
          {
            marginBottom: 12,
            opacity: pressed ? 0.92 : 1,
            flexDirection: 'row',
            alignItems: 'center',
          },
        ]}
      >
        <StaffAvatar
          userId={user.id}
          firstName={user.firstName}
          lastName={user.lastName}
          photoUrl={staffProfile?.photoUrl}
          size={52}
          style={{ marginRight: 14 }}
        />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            style={{
              fontSize: 17,
              fontWeight: '700',
              letterSpacing: -0.3,
              color: C.text,
            }}
            numberOfLines={1}
          >
            {user.firstName} {user.lastName}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <View
              style={{
                backgroundColor: roleStyle.bg,
                borderRadius: 100,
                paddingVertical: 4,
                paddingHorizontal: 8,
              }}
            >
              <Text
                style={{
                  fontSize: 10,
                  fontWeight: '700',
                  letterSpacing: 0.5,
                  textTransform: 'uppercase',
                  color: roleStyle.text,
                }}
              >
                {formatStaffRoleLabel(role)}
              </Text>
            </View>
            <ActiveBadge active={isActive} />
          </View>
        </View>
        <FontAwesome name="chevron-right" size={14} color="rgba(255,255,255,0.28)" />
      </Pressable>
    </Animated.View>
  );
}

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
      if (isRefresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
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
      if (studioId && canAccessTeamTab(role)) {
        void load();
      }
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

  const showInitialLoader = loading && !loadedOnce;

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

  if (showInitialLoader) {
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
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: Space.screenH,
          paddingBottom: TAB_BAR_CLEARANCE,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load(true)}
            tintColor="rgba(255,255,255,0.4)"
          />
        }
        keyboardShouldPersistTaps="handled"
      >
        <Animated.View entering={FadeInDown.duration(450)} style={{ paddingTop: 28, paddingBottom: 20 }}>
          <Text
            style={{
              fontSize: 38,
              fontWeight: '800',
              letterSpacing: -1.3,
              color: C.text,
              lineHeight: 44,
            }}
          >
            Equipo
          </Text>
          <Text
            style={{
              fontSize: 15,
              color: C.textSub,
              lineHeight: 22,
              marginTop: 10,
              letterSpacing: -0.1,
            }}
          >
            {canManage
              ? 'Administra tu equipo de coaching y operaciones.'
              : 'Consulta tu equipo de coaching y operaciones (solo lectura).'}
          </Text>
        </Animated.View>

        {canManage ? (
          <View style={{ marginBottom: 20 }}>
            <BrandButton
              label="Agregar staff"
              accentColor={primaryColor}
              onPress={() => router.push('/(app)/staff-member/add' as Href)}
            />
          </View>
        ) : null}

        {canAccessMembersDirectory(role) && role === 'STAFF' ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push(membersDirectoryHref())}
            style={[
              cardStyle(C),
              {
                marginBottom: 20,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 14,
              },
            ]}
          >
            <View
              style={{
                width: 44,
                height: 44,
                borderRadius: 14,
                backgroundColor: 'rgba(255,255,255,0.06)',
                borderWidth: 1,
                borderColor: C.separator,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <FontAwesome name="users" size={18} color={C.textSub} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, fontWeight: '700', color: C.text }}>Directorio de miembros</Text>
              <Text style={{ fontSize: 13, color: C.textSub, marginTop: 4, lineHeight: 18 }}>
                Busca clientes del estudio (solo lectura).
              </Text>
            </View>
            <FontAwesome name="chevron-right" size={14} color="rgba(255,255,255,0.28)" />
          </Pressable>
        ) : null}

        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Buscar por nombre o correo…"
          placeholderTextColor={C.textMute}
          autoCapitalize="none"
          autoCorrect={false}
          style={{
            backgroundColor: '#141416',
            borderWidth: 1,
            borderColor: C.separator,
            borderRadius: 16,
            paddingHorizontal: 16,
            paddingVertical: 12,
            fontSize: 15,
            color: C.text,
            marginBottom: 14,
          }}
        />

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 18 }}
        >
          {ROLE_FILTERS.map((f) => (
            <RoleChip
              key={f.id}
              label={f.label}
              selected={roleFilter === f.id}
              onPress={() => setRoleFilter(f.id)}
            />
          ))}
        </ScrollView>

        {error ? (
          <Text style={{ fontSize: 13, color: '#FCA5A5', marginBottom: 12 }}>{error}</Text>
        ) : null}

        <Text style={{ fontSize: 12, color: C.textMute, marginBottom: 16 }}>
          {total} miembro{total !== 1 ? 's' : ''} del equipo
        </Text>

        {staff.length === 0 ? (
          <View style={[cardStyle(C), { alignItems: 'center', paddingVertical: 36 }]}>
            <Text
              style={{
                fontSize: 17,
                fontWeight: '700',
                color: C.text,
                textAlign: 'center',
                marginBottom: 8,
              }}
            >
              No se encontraron miembros del equipo.
            </Text>
            <Text style={{ fontSize: 14, color: C.textSub, textAlign: 'center', lineHeight: 21 }}>
              {debouncedSearch || roleFilter !== 'ALL'
                ? 'Intenta ajustar tu búsqueda o filtros.'
                : 'Tu directorio de equipo está vacío.'}
            </Text>
          </View>
        ) : (
          staff.map((member, index) => (
            <StaffCard
              key={member.membershipId}
              member={member}
              index={index}
              onPress={() =>
                router.push(`/(app)/staff-member/${member.userId}` as Href)
              }
            />
          ))
        )}

        {canManage ? null : (
          <Text
            style={{
              fontSize: 12,
              color: C.textMute,
              textAlign: 'center',
              lineHeight: 18,
              marginTop: 24,
              paddingHorizontal: 12,
            }}
          >
            Los cambios del equipo los administran OWNER y ADMIN.
          </Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
