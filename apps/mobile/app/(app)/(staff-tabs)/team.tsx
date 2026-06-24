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

import { TAB_BAR_CLEARANCE } from '@/components/FloatingTabBar';
import { LoadRetryPanel, ScreenLoader } from '@/components/StudioScreenChrome';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import {
  fetchStaff,
  type StaffMemberDto,
  type StaffRole,
} from '@/lib/api/staffApi';
import { canAccessTeamTab } from '@/lib/staffRole';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';
import { getColors, Space, type ThemeColors } from '@/constants/Theme';

type RoleFilter = 'ALL' | StaffRole;

const ROLE_FILTERS: { id: RoleFilter; label: string }[] = [
  { id: 'ALL', label: 'Todos' },
  { id: 'OWNER', label: 'Propietarios' },
  { id: 'ADMIN', label: 'Administradores' },
  { id: 'STAFF', label: 'Staff' },
  { id: 'INSTRUCTOR', label: 'Entrenadores' },
];

const ROLE_LABELS: Record<StaffRole, string> = {
  OWNER: 'Propietario',
  ADMIN: 'Administrador',
  STAFF: 'Staff',
  INSTRUCTOR: 'Coach',
};

const ROLE_COLORS: Record<StaffRole, { bg: string; text: string }> = {
  OWNER: { bg: 'rgba(245,158,11,0.18)', text: '#FCD34D' },
  ADMIN: { bg: 'rgba(139,92,246,0.18)', text: '#C4B5FD' },
  STAFF: { bg: 'rgba(20,184,166,0.18)', text: '#5EEAD4' },
  INSTRUCTOR: { bg: 'rgba(56,189,248,0.18)', text: '#7DD3FC' },
};

const STAFF_TYPE_LABELS: Record<string, string> = {
  COACH: 'Coach',
  FRONT_DESK: 'Recepción',
  MANAGER: 'Gerente',
  OPERATIONS: 'Operaciones',
  OTHER: 'Otro',
};

function cardStyle(C: ThemeColors) {
  return {
    backgroundColor: '#141416',
    borderRadius: 28,
    borderWidth: 1,
    borderColor: C.separator,
    padding: 20,
  } as const;
}

function memberInitials(firstName: string, lastName: string): string {
  return `${firstName?.[0] ?? ''}${lastName?.[0] ?? ''}`.toUpperCase() || '?';
}

function formatStaffType(staffType: string | undefined): string {
  if (!staffType) return '—';
  return STAFF_TYPE_LABELS[staffType] ?? staffType;
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
  const roleStyle = ROLE_COLORS[role];

  return (
    <Animated.View entering={FadeInDown.delay(Math.min(index * 40, 200)).duration(420)}>
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => [
          cardStyle(C),
          { marginBottom: 12, opacity: pressed ? 0.92 : 1 },
        ]}
      >
        <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
          <View
            style={{
              width: 48,
              height: 48,
              borderRadius: 24,
              backgroundColor: '#1E1E22',
              borderWidth: 1,
              borderColor: C.separator,
              alignItems: 'center',
              justifyContent: 'center',
              marginRight: 14,
            }}
          >
            <Text style={{ fontSize: 16, fontWeight: '800', color: C.text }}>
              {memberInitials(user.firstName, user.lastName)}
            </Text>
          </View>
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
            <Text
              style={{ fontSize: 13, color: C.textMute, marginTop: 3 }}
              numberOfLines={1}
            >
              {user.email}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
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
                  {ROLE_LABELS[role]}
                </Text>
              </View>
              {staffProfile ? (
                <View
                  style={{
                    backgroundColor: 'rgba(255,255,255,0.08)',
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
                      color: C.textSub,
                    }}
                  >
                    {formatStaffType(staffProfile.staffType)}
                  </Text>
                </View>
              ) : null}
              <View
                style={{
                  backgroundColor: isActive ? 'rgba(16,185,129,0.15)' : 'rgba(255,255,255,0.06)',
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
                    color: isActive ? '#6EE7B7' : C.textMute,
                  }}
                >
                  {isActive ? 'Activo' : 'Inactivo'}
                </Text>
              </View>
            </View>
            {member.assignedClassesCount > 0 ? (
              <Text style={{ fontSize: 12, color: C.textMute, marginTop: 10 }}>
                {member.assignedClassesCount}{' '}
                {member.assignedClassesCount === 1 ? 'clase próxima' : 'clases próximas'}
              </Text>
            ) : null}
          </View>
        </View>
      </Pressable>
    </Animated.View>
  );
}

export default function StaffTeamScreen() {
  const router = useRouter();
  const C = getColors();
  const { matched, refetch } = useMemberStudio();
  const studioId = matched?.studio.id;
  const role = matched?.role;

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
        setStaff(res.data);
        setTotal(res.total);
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
            Administra tu equipo de coaching y operaciones.
          </Text>
        </Animated.View>

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
          Crea y edita miembros del equipo desde el panel de administración web.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}
