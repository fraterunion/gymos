import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BrandButton } from '@/components/BrandButton';
import { Skeleton } from '@/components/StudioScreenChrome';
import { StaffAvatar } from '@/components/StaffAvatar';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import {
  fetchMembers,
  memberDisplayName,
  type MemberListItem,
} from '@/lib/api/membersDirectoryApi';
import { canAccessMembersDirectory } from '@/lib/memberProfilePermissions';
import {
  memberProfileHref,
  staffSalesHref,
} from '@/lib/memberProfileRoutes';
import { statusConfig } from '@/lib/membershipStatus';
import { canAccessSales } from '@/lib/salesPermissions';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';
import { getColors, Radius, Space, type ThemeColors } from '@/constants/Theme';

const PAGE_SIZE = 30;

function cardStyle(C: ThemeColors) {
  return {
    backgroundColor: C.surface1,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: C.separator,
    padding: 20,
  } as const;
}

function StatusPill({ label, bg, textColor }: { label: string; bg: string; textColor: string }) {
  return (
    <View
      style={{
        borderRadius: 999,
        paddingHorizontal: 10,
        paddingVertical: 5,
        backgroundColor: bg,
      }}
    >
      <Text style={{ fontSize: 11, fontWeight: '700', color: textColor }}>{label}</Text>
    </View>
  );
}

function membershipPill(member: MemberListItem) {
  const sub = member.subscription;
  if (!sub) {
    const C = getColors();
    return { label: 'Sin membresía', bg: 'rgba(255,255,255,0.06)', textColor: C.textMute };
  }
  const cfg = statusConfig(sub.status, sub.cancelAtPeriodEnd);
  return { label: cfg.label, bg: cfg.bg, textColor: cfg.textColor };
}

function MemberDirectoryRow({
  member,
  index,
  canSales,
  onOpenProfile,
  onStartSale,
}: {
  member: MemberListItem;
  index: number;
  canSales: boolean;
  onOpenProfile: () => void;
  onStartSale: () => void;
}) {
  const C = getColors();
  const pill = membershipPill(member);

  return (
    <Animated.View entering={FadeInDown.delay(Math.min(index * 32, 160)).duration(300)}>
      <View
        style={[
          cardStyle(C),
          {
            marginBottom: 12,
            flexDirection: 'row',
            alignItems: 'center',
          },
        ]}
      >
        <Pressable
          accessibilityRole="button"
          onPress={onOpenProfile}
          style={({ pressed }) => ({
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            opacity: pressed ? 0.92 : 1,
          })}
        >
          <StaffAvatar
            userId={member.user.id}
            firstName={member.user.firstName}
            lastName={member.user.lastName}
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
              {memberDisplayName(member)}
            </Text>
            <Text style={{ fontSize: 13, color: C.textMute, marginTop: 4 }} numberOfLines={1}>
              {member.user.email}
            </Text>
            {member.user.phone ? (
              <Text style={{ fontSize: 13, color: C.textMute, marginTop: 2 }} numberOfLines={1}>
                {member.user.phone}
              </Text>
            ) : null}
            <View style={{ marginTop: 10 }}>
              <StatusPill label={pill.label} bg={pill.bg} textColor={pill.textColor} />
            </View>
          </View>
          <FontAwesome name="chevron-right" size={12} color="rgba(255,255,255,0.28)" />
        </Pressable>
        {canSales ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Iniciar venta"
            onPress={onStartSale}
            hitSlop={10}
            style={{ padding: 12, marginLeft: 4 }}
          >
            <FontAwesome name="shopping-cart" size={18} color={C.textSub} />
          </Pressable>
        ) : null}
      </View>
    </Animated.View>
  );
}

function RowSkeleton() {
  const C = getColors();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 12,
        padding: 20,
        borderRadius: Radius.card,
        backgroundColor: C.surface1,
        borderWidth: 1,
        borderColor: C.separator,
      }}
    >
      <Skeleton width={52} height={52} radius={26} style={{ marginRight: 14 }} />
      <View style={{ flex: 1, gap: 8 }}>
        <Skeleton width="65%" height={18} />
        <Skeleton width="80%" height={13} />
        <Skeleton width={100} height={24} radius={12} />
      </View>
    </View>
  );
}

export default function MembersDirectoryScreen() {
  const router = useRouter();
  const C = getColors();
  const { primaryColor } = useBranding();
  const { matched } = useMemberStudio();
  const studioId = matched?.studio.id ?? '';
  const role = matched?.role ?? null;

  const allowed = canAccessMembersDirectory(role);
  const canSales = canAccessSales(role);

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [members, setMembers] = useState<MemberListItem[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);

  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);

  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => {
      if (searchTimeout.current) clearTimeout(searchTimeout.current);
    };
  }, [search]);

  const loadPage = useCallback(
    async (opts: { page: number; append: boolean; isRefresh?: boolean }) => {
      if (!studioId || !allowed) return;

      if (opts.append) {
        setLoadingMore(true);
      } else if (opts.isRefresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(null);

      try {
        const res = await fetchMembers(studioId, {
          role: 'MEMBER',
          search: debouncedSearch || undefined,
          page: opts.page,
          limit: PAGE_SIZE,
          sortBy: debouncedSearch ? 'name' : 'joinDate',
          sortDir: debouncedSearch ? 'asc' : 'desc',
        });
        setHasMore(opts.page * PAGE_SIZE < res.total);
        setPage(opts.page);
        setMembers((prev) => (opts.append ? [...prev, ...res.data] : res.data));
      } catch (e) {
        setError(userFacingApiMessage(e, 'No pudimos cargar los miembros'));
        if (!opts.append) {
          setMembers([]);
        }
      } finally {
        setLoading(false);
        setLoadingMore(false);
        setRefreshing(false);
        setLoadedOnce(true);
      }
    },
    [allowed, debouncedSearch, studioId],
  );

  useEffect(() => {
    if (!allowed || !studioId) return;
    void loadPage({ page: 1, append: false });
  }, [allowed, debouncedSearch, loadPage, studioId]);

  const onRefresh = useCallback(() => {
    void loadPage({ page: 1, append: false, isRefresh: true });
  }, [loadPage]);

  const onEndReached = useCallback(() => {
    if (loading || loadingMore || refreshing || !hasMore) return;
    void loadPage({ page: page + 1, append: true });
  }, [hasMore, loadPage, loading, loadingMore, page, refreshing]);

  if (!allowed) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <View style={{ flex: 1, justifyContent: 'center', padding: Space.screenH }}>
          <Text style={{ fontSize: 20, fontWeight: '800', color: C.text, marginBottom: 12 }}>
            Sin acceso
          </Text>
          <Text style={{ fontSize: 15, lineHeight: 22, color: C.textSub, marginBottom: 28 }}>
            Tu rol no tiene permiso para ver el directorio de miembros.
          </Text>
          <BrandButton label="Volver" accentColor={primaryColor} onPress={() => router.back()} />
        </View>
      </SafeAreaView>
    );
  }

  const showInitialLoader = loading && !loadedOnce;
  const showEmpty =
    loadedOnce && !loading && !refreshing && members.length === 0 && !error;

  const listHeader = (
    <View style={{ paddingBottom: 8 }}>
      <Animated.View entering={FadeInDown.duration(300)} style={{ paddingTop: 8, paddingBottom: 20 }}>
        <Text
          style={{
            fontSize: 36,
            fontWeight: '800',
            letterSpacing: -1.3,
            color: C.text,
            lineHeight: 40,
          }}
        >
          Miembros
        </Text>
        <Text style={{ fontSize: 16, lineHeight: 24, color: C.textSub, marginTop: 10, letterSpacing: -0.2 }}>
          Busca clientes del estudio y abre su perfil.
        </Text>
      </Animated.View>

      <TextInput
        value={search}
        onChangeText={setSearch}
        placeholder="Nombre o correo…"
        placeholderTextColor={C.textMute}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        clearButtonMode="while-editing"
        style={{
          backgroundColor: C.surface1,
          borderWidth: 1,
          borderColor: C.separator,
          borderRadius: Radius.button,
          paddingHorizontal: Space.sp2,
          paddingVertical: 12,
          fontSize: 16,
          color: C.text,
          marginBottom: 16,
        }}
      />

      {error && members.length === 0 ? (
        <View
          style={{
            marginBottom: 16,
            borderRadius: 16,
            borderWidth: 1,
            borderColor: 'rgba(239,68,68,0.35)',
            backgroundColor: 'rgba(239,68,68,0.08)',
            padding: 16,
          }}
        >
          <Text style={{ fontSize: 14, lineHeight: 20, color: '#FCA5A5', marginBottom: 12 }}>{error}</Text>
          <BrandButton
            label="Reintentar"
            accentColor={primaryColor}
            variant="ghost"
            onPress={() => void loadPage({ page: 1, append: false })}
          />
        </View>
      ) : null}

      {!showInitialLoader && members.length > 0 ? (
        <Text style={{ fontSize: 12, color: C.textMute, marginBottom: 12 }}>
          {members.length}
          {hasMore ? '+' : ''} miembro{members.length !== 1 ? 's' : ''}
          {debouncedSearch ? ` · “${debouncedSearch}”` : ''}
        </Text>
      ) : null}

      {showInitialLoader ? (
        <View style={{ marginTop: 4 }}>
          <RowSkeleton />
          <RowSkeleton />
          <RowSkeleton />
          <RowSkeleton />
        </View>
      ) : null}
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['bottom']}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: Space.screenH,
          paddingVertical: 12,
          borderBottomWidth: 1,
          borderBottomColor: C.separator,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Atrás"
          onPress={() => router.back()}
          hitSlop={12}
          style={{ padding: 8, marginRight: 8 }}
        >
          <FontAwesome name="chevron-left" size={18} color={C.text} />
        </Pressable>
        <Text style={{ flex: 1, fontSize: 17, fontWeight: '700', color: C.text }}>Directorio</Text>
      </View>

      <FlatList
        data={showInitialLoader ? [] : members}
        keyExtractor={(item) => item.user.id}
        renderItem={({ item, index }) => (
          <MemberDirectoryRow
            member={item}
            index={index}
            canSales={canSales}
            onOpenProfile={() =>
              router.push(memberProfileHref(item.user.id, { from: 'directory' }))
            }
            onStartSale={() =>
              router.push(
                staffSalesHref({ memberUserId: item.user.id, initialStep: 2, from: 'directory' }),
              )
            }
          />
        )}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={
          showEmpty ? (
            <View style={[cardStyle(C), { alignItems: 'center', paddingVertical: 36, marginTop: 8 }]}>
              <Text
                style={{
                  fontSize: 17,
                  fontWeight: '700',
                  color: C.text,
                  textAlign: 'center',
                  marginBottom: 8,
                }}
              >
                {debouncedSearch ? 'Sin resultados' : 'Aún no hay miembros'}
              </Text>
              <Text style={{ fontSize: 14, color: C.textSub, textAlign: 'center', lineHeight: 21 }}>
                {debouncedSearch
                  ? 'Prueba con otro nombre o correo.'
                  : 'Los clientes registrados aparecerán aquí.'}
              </Text>
            </View>
          ) : null
        }
        ListFooterComponent={
          loadingMore ? (
            <ActivityIndicator color={primaryColor} style={{ marginVertical: 20 }} />
          ) : null
        }
        contentContainerStyle={{
          paddingHorizontal: Space.screenH,
          paddingBottom: 48,
        }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="rgba(255,255,255,0.35)" />
        }
        onEndReached={onEndReached}
        onEndReachedThreshold={0.4}
        keyboardShouldPersistTaps="handled"
      />
    </SafeAreaView>
  );
}
