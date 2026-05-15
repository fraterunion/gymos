import { useEffect } from 'react';
import { Pressable, Text, useColorScheme, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { BrandButton } from '@/components/BrandButton';
import { useBranding } from '@/contexts/BrandingContext';
import { getColors } from '@/constants/Theme';

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

type SkeletonProps = {
  width?: number | string;
  height?: number;
  radius?: number;
  style?: object;
};

export function Skeleton({ width = '100%', height = 16, radius = 8, style }: SkeletonProps) {
  const scheme = useColorScheme();
  const C = getColors(scheme);
  const opacity = useSharedValue(0.35);

  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.75, { duration: 850, easing: Easing.inOut(Easing.ease) }),
        withTiming(0.35, { duration: 850, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
    );
  }, [opacity]);

  const animStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      style={[
        { width, height, borderRadius: radius, backgroundColor: C.surface3 },
        animStyle,
        style,
      ]}
    />
  );
}

/** @deprecated Use <Skeleton> */
export function SkeletonBlock({ className }: { className?: string }) {
  const scheme = useColorScheme();
  const C = getColors(scheme);
  const opacity = useSharedValue(0.35);
  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.75, { duration: 850, easing: Easing.inOut(Easing.ease) }),
        withTiming(0.35, { duration: 850, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
    );
  }, [opacity]);
  const animStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  // Parse minimal sizing from the className for legacy callers
  const isShort = className?.includes('w-1/2');
  const isTall = className?.includes('h-8') || className?.includes('h-10');
  const height = isTall ? 32 : 16;
  const width = isShort ? '50%' : '100%';

  return (
    <Animated.View
      style={[
        { width, height, borderRadius: 8, backgroundColor: C.surface3, marginBottom: 12 },
        animStyle,
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
// LoadRetryPanel / ScreenLoader
// ---------------------------------------------------------------------------

export function LoadRetryPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { primaryColor } = useBranding();
  return (
    <View className="flex-1 items-center justify-center bg-[#0A0A0A] px-8 dark:bg-[#0A0A0A]">
      <Text
        style={{ textAlign: 'center', fontSize: 15, lineHeight: 22, color: 'rgba(255,255,255,0.45)', marginBottom: 32 }}
      >
        {message}
      </Text>
      <BrandButton label="Try again" accentColor={primaryColor} onPress={() => void onRetry()} />
    </View>
  );
}

export function ScreenLoader() {
  const scheme = useColorScheme();
  const C = getColors(scheme);
  const opacity = useSharedValue(0.2);

  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.6, { duration: 700, easing: Easing.inOut(Easing.ease) }),
        withTiming(0.2, { duration: 700, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
    );
  }, [opacity]);

  const animStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg }}>
      <Animated.View
        style={[
          { width: 32, height: 32, borderRadius: 16, backgroundColor: C.surface3 },
          animStyle,
        ]}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// SectionLabel — editorial, not dashboard
// ---------------------------------------------------------------------------

export function SectionLabel({
  children,
  accent,
}: {
  children: string;
  accent?: string;
}) {
  return (
    <Text
      style={{
        fontSize: 11,
        fontWeight: '600',
        letterSpacing: 0.8,
        textTransform: 'uppercase',
        color: accent ?? 'rgba(255,255,255,0.38)',
        marginBottom: 14,
        marginTop: 32,
      }}
    >
      {children}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// EmptyHint — generous whitespace, no dashed borders
// ---------------------------------------------------------------------------

export function EmptyHint({ title, body }: { title: string; body: string }) {
  const scheme = useColorScheme();
  const C = getColors(scheme);
  return (
    <View style={{ paddingVertical: 40, paddingHorizontal: 8, alignItems: 'center' }}>
      <Text
        style={{
          fontSize: 17,
          fontWeight: '600',
          color: C.text,
          textAlign: 'center',
          letterSpacing: -0.2,
          marginBottom: 10,
        }}
      >
        {title}
      </Text>
      <Text
        style={{
          fontSize: 14,
          lineHeight: 21,
          color: C.textMute,
          textAlign: 'center',
          maxWidth: 260,
        }}
      >
        {body}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// ErrorBanner — inline, not modal
// ---------------------------------------------------------------------------

export function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { primaryColor } = useBranding();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 16,
        paddingHorizontal: 16,
        paddingVertical: 12,
        backgroundColor: 'rgba(248,113,113,0.10)',
        borderRadius: 12,
      }}
    >
      <Text style={{ flex: 1, fontSize: 13, color: '#F87171', marginRight: 12, lineHeight: 19 }}>
        {message}
      </Text>
      <Pressable accessibilityRole="button" onPress={() => void onRetry()} hitSlop={8}>
        <Text style={{ fontSize: 13, fontWeight: '600', color: primaryColor }}>Retry</Text>
      </Pressable>
    </View>
  );
}
