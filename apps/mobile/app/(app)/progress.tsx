import { Redirect } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useFocusEffect } from 'expo-router';

import { LoadRetryPanel, ScreenLoader } from '@/components/StudioScreenChrome';
import { useAuth } from '@/contexts/AuthContext';
import { useBranding } from '@/contexts/BrandingContext';
import { useMemberStudio } from '@/contexts/MemberStudioContext';
import {
  fetchLeaderboard,
  fetchMyProgress,
  type LeaderboardDto,
  type MemberProgressDto,
} from '@/lib/api/progressApi';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';
import { getColors, Space } from '@/constants/Theme';

const CARD_BG = '#141416';

function cardStyle(C: ReturnType<typeof getColors>) {
  return {
    backgroundColor: CARD_BG,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: C.separator,
  } as const;
}

function SectionLabel({ children }: { children: string }) {
  const C = getColors();
  return (
    <Text
      style={{
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 1.2,
        textTransform: 'uppercase',
        color: C.textMute,
        marginBottom: 14,
        marginTop: 32,
      }}
    >
      {children}
    </Text>
  );
}

function HeroStat({ value, label }: { value: string; label: string }) {
  const C = getColors();
  return (
    <View
      style={{
        ...cardStyle(C),
        flexBasis: '48%',
        flexGrow: 1,
        paddingVertical: 20,
        paddingHorizontal: 18,
        alignItems: 'center',
      }}
    >
      <Text
        style={{
          fontSize: 32,
          fontWeight: '800',
          letterSpacing: -1.0,
          color: C.text,
          lineHeight: 36,
        }}
      >
        {value}
      </Text>
      <Text
        style={{
          fontSize: 10,
          fontWeight: '700',
          letterSpacing: 0.8,
          textTransform: 'uppercase',
          color: C.textMute,
          marginTop: 6,
          textAlign: 'center',
        }}
      >
        {label}
      </Text>
    </View>
  );
}

function formatActivityDate(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
  }).format(new Date(iso));
}

export default function ProgressScreen() {
  const C = getColors();
  const { user } = useAuth();
  const { primaryColor } = useBranding();
  const { matched } = useMemberStudio();
  const studioId = matched?.studio.id;

  const [progress, setProgress] = useState<MemberProgressDto | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (!studioId) return;
      setError(null);
      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);

      const [progressResult, leaderboardResult] = await Promise.allSettled([
        fetchMyProgress(studioId),
        fetchLeaderboard(studioId, 'month'),
      ]);

      if (progressResult.status === 'fulfilled') {
        setProgress(progressResult.value);
      } else {
        setError(
          userFacingApiMessage(
            progressResult.reason,
            'Could not load your progress. Pull to refresh.',
          ),
        );
      }

      // Leaderboard is non-blocking — the screen renders without it.
      if (leaderboardResult.status === 'fulfilled') {
        setLeaderboard(leaderboardResult.value);
      } else if (__DEV__) {
        console.warn('[Progress] fetchLeaderboard failed:', leaderboardResult.reason);
      }

      setLoading(false);
      setRefreshing(false);
    },
    [studioId],
  );

  useFocusEffect(
    useCallback(() => {
      void load(progress ? 'refresh' : 'initial');
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [load]),
  );

  if (!user) {
    return <Redirect href="/(app)/(tabs)" />;
  }

  if (loading && !progress) return <ScreenLoader />;
  if (error && !progress) {
    return <LoadRetryPanel message={error} onRetry={() => void load('initial')} />;
  }
  if (!progress) return <ScreenLoader />;

  const isEmpty = progress.totalCheckIns === 0;
  const maxBreakdown = progress.classBreakdown[0]?.count ?? 0;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['bottom', 'left', 'right']}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: Space.screenH, paddingBottom: 40 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load('refresh')}
            tintColor={primaryColor}
          />
        }
      >
        <Animated.View entering={FadeInDown.duration(400)} style={{ paddingTop: 24, marginBottom: 8 }}>
          <Text
            style={{
              fontSize: 38,
              fontWeight: '800',
              letterSpacing: -1.3,
              color: C.text,
              lineHeight: 44,
            }}
          >
            Progress
          </Text>
        </Animated.View>

        {isEmpty ? (
          <Animated.View entering={FadeInDown.delay(60).duration(420)}>
            <View
              style={{
                ...cardStyle(C),
                padding: 36,
                marginTop: 24,
                alignItems: 'center',
              }}
            >
              <View
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 28,
                  backgroundColor: 'rgba(255,255,255,0.06)',
                  borderWidth: 1,
                  borderColor: C.separator,
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: 20,
                }}
              >
                <Text style={{ fontSize: 22, color: C.textMute }}>▲</Text>
              </View>
              <Text
                style={{
                  fontSize: 20,
                  fontWeight: '800',
                  letterSpacing: -0.4,
                  color: C.text,
                  textAlign: 'center',
                  marginBottom: 10,
                }}
              >
                Your progress starts with your first check-in.
              </Text>
              <Text
                style={{
                  fontSize: 14,
                  color: C.textSub,
                  lineHeight: 21,
                  textAlign: 'center',
                  maxWidth: 260,
                }}
              >
                Book a class and check in to start tracking your training.
              </Text>
            </View>
          </Animated.View>
        ) : (
          <>
            {/* ── Hero stats ── */}
            <Animated.View
              entering={FadeInDown.delay(60).duration(420)}
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                gap: 10,
                marginTop: 16,
              }}
            >
              <HeroStat value={String(progress.totalCheckIns)} label="Total check-ins" />
              <HeroStat value={String(progress.monthCheckIns)} label="This month" />
              <HeroStat value={`${progress.currentStreak}w`} label="Current streak" />
              <HeroStat value={`${progress.bestStreak}w`} label="Best streak" />
            </Animated.View>

            {/* ── Favorite class ── */}
            {progress.favoriteClass ? (
              <Animated.View entering={FadeInDown.delay(120).duration(420)}>
                <SectionLabel>Favorite class</SectionLabel>
                <View style={{ ...cardStyle(C), overflow: 'hidden' }}>
                  <View style={{ height: 3, backgroundColor: primaryColor }} />
                  <View style={{ padding: 24 }}>
                    <Text
                      style={{
                        fontSize: 24,
                        fontWeight: '800',
                        letterSpacing: -0.6,
                        color: C.text,
                        marginBottom: 6,
                      }}
                    >
                      {progress.favoriteClass.name}
                    </Text>
                    <Text style={{ fontSize: 14, color: C.textSub }}>
                      {progress.favoriteClass.count} check-ins all time
                    </Text>
                  </View>
                </View>
              </Animated.View>
            ) : null}

            {/* ── Class breakdown ── */}
            {progress.classBreakdown.length > 0 ? (
              <Animated.View entering={FadeInDown.delay(160).duration(420)}>
                <SectionLabel>Class breakdown</SectionLabel>
                <View style={{ ...cardStyle(C), padding: 22, gap: 16 }}>
                  {progress.classBreakdown.map((item) => (
                    <View key={item.templateId}>
                      <View
                        style={{
                          flexDirection: 'row',
                          justifyContent: 'space-between',
                          marginBottom: 7,
                        }}
                      >
                        <Text
                          numberOfLines={1}
                          style={{
                            flex: 1,
                            fontSize: 14,
                            fontWeight: '600',
                            color: C.text,
                            letterSpacing: -0.2,
                            marginRight: 12,
                          }}
                        >
                          {item.className}
                        </Text>
                        <Text style={{ fontSize: 13, color: C.textSub }}>{item.count}</Text>
                      </View>
                      <View
                        style={{
                          height: 5,
                          borderRadius: 3,
                          backgroundColor: 'rgba(255,255,255,0.07)',
                          overflow: 'hidden',
                        }}
                      >
                        <View
                          style={{
                            height: '100%',
                            borderRadius: 3,
                            width: `${maxBreakdown > 0 ? (item.count / maxBreakdown) * 100 : 0}%`,
                            backgroundColor: primaryColor,
                          }}
                        />
                      </View>
                    </View>
                  ))}
                </View>
              </Animated.View>
            ) : null}

            {/* ── Recent activity ── */}
            {progress.recentActivity.length > 0 ? (
              <Animated.View entering={FadeInDown.delay(200).duration(420)}>
                <SectionLabel>Recent activity</SectionLabel>
                <View style={{ ...cardStyle(C), paddingHorizontal: 22 }}>
                  {progress.recentActivity.map((item, i) => (
                    <View
                      key={`${item.date}-${i}`}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingVertical: 14,
                        borderBottomWidth: i === progress.recentActivity.length - 1 ? 0 : 1,
                        borderBottomColor: C.separator,
                      }}
                    >
                      <View style={{ width: 56 }}>
                        <Text
                          style={{
                            fontSize: 12,
                            fontWeight: '700',
                            color: C.textMute,
                            letterSpacing: 0.2,
                          }}
                        >
                          {formatActivityDate(item.date, progress.period.timezone)}
                        </Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text
                          numberOfLines={1}
                          style={{
                            fontSize: 15,
                            fontWeight: '600',
                            color: C.text,
                            letterSpacing: -0.2,
                          }}
                        >
                          {item.className}
                        </Text>
                        {item.coachName ? (
                          <Text style={{ fontSize: 12, color: C.textMute, marginTop: 2 }}>
                            {item.coachName}
                          </Text>
                        ) : null}
                      </View>
                    </View>
                  ))}
                </View>
              </Animated.View>
            ) : null}
          </>
        )}

        {/* ── Leaderboard ── */}
        {leaderboard && leaderboard.top.length > 0 ? (
          <Animated.View entering={FadeInDown.delay(240).duration(420)}>
            <SectionLabel>This month's leaderboard</SectionLabel>
            <View style={{ ...cardStyle(C), paddingHorizontal: 22 }}>
              {leaderboard.top.map((entry, i) => {
                const isMe = leaderboard.me.rank === entry.rank;
                return (
                  <View
                    key={entry.rank}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      paddingVertical: 14,
                      borderBottomWidth: i === leaderboard.top.length - 1 ? 0 : 1,
                      borderBottomColor: C.separator,
                    }}
                  >
                    <Text
                      style={{
                        width: 28,
                        fontSize: 15,
                        fontWeight: '800',
                        color: isMe ? primaryColor : C.textMute,
                      }}
                    >
                      {entry.rank}
                    </Text>
                    <View
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 18,
                        backgroundColor: 'rgba(255,255,255,0.07)',
                        borderWidth: 1,
                        borderColor: C.separator,
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginRight: 12,
                      }}
                    >
                      <Text
                        style={{
                          fontSize: 12,
                          fontWeight: '700',
                          color: C.textSub,
                          letterSpacing: 0.5,
                        }}
                      >
                        {entry.initials}
                      </Text>
                    </View>
                    <Text
                      numberOfLines={1}
                      style={{
                        flex: 1,
                        fontSize: 15,
                        fontWeight: isMe ? '700' : '500',
                        color: C.text,
                        letterSpacing: -0.2,
                      }}
                    >
                      {entry.displayName}
                      {isMe ? '  ·  You' : ''}
                    </Text>
                    <Text style={{ fontSize: 14, fontWeight: '600', color: C.textSub }}>
                      {entry.checkIns}
                    </Text>
                  </View>
                );
              })}
            </View>

            {leaderboard.me.rank === null && leaderboard.me.checkIns > 0 ? (
              <Text style={{ fontSize: 13, color: C.textMute, marginTop: 12 }}>
                You have {leaderboard.me.checkIns} check-in
                {leaderboard.me.checkIns === 1 ? '' : 's'} this month. Keep going to reach the
                top 5.
              </Text>
            ) : null}
          </Animated.View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
