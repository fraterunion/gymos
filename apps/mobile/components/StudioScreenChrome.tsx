import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { BrandButton } from '@/components/BrandButton';
import { useBranding } from '@/contexts/BrandingContext';

type Props = {
  message: string;
  onRetry: () => void;
};

export function LoadRetryPanel({ message, onRetry }: Props) {
  const { primaryColor } = useBranding();
  return (
    <View className="flex-1 justify-center bg-neutral-50 px-8 dark:bg-neutral-950">
      <Text className="text-center text-base leading-6 text-neutral-600 dark:text-neutral-400">{message}</Text>
      <View className="mt-8">
        <BrandButton label="Try again" accentColor={primaryColor} onPress={() => void onRetry()} />
      </View>
    </View>
  );
}

export function ScreenLoader() {
  return (
    <View className="flex-1 items-center justify-center bg-neutral-50 dark:bg-neutral-950">
      <ActivityIndicator size="large" />
    </View>
  );
}

export function SkeletonBlock({ className }: { className?: string }) {
  return <View className={`rounded-xl bg-neutral-200/80 dark:bg-neutral-800/80 ${className ?? 'h-16 w-full'}`} />;
}

export function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="mb-3 mt-8 text-xs font-semibold uppercase tracking-wider text-neutral-500 first:mt-0 dark:text-neutral-400">
      {children}
    </Text>
  );
}

export function EmptyHint({ title, body }: { title: string; body: string }) {
  return (
    <View className="rounded-2xl border border-dashed border-neutral-300 bg-white/60 px-5 py-8 dark:border-neutral-700 dark:bg-neutral-900/40">
      <Text className="text-center text-base font-medium text-neutral-800 dark:text-neutral-100">{title}</Text>
      <Text className="mt-2 text-center text-sm leading-5 text-neutral-500 dark:text-neutral-400">{body}</Text>
    </View>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { primaryColor } = useBranding();
  return (
    <View className="mb-4 flex-row items-center justify-between rounded-xl border border-red-200 bg-red-50 px-4 py-3 dark:border-red-900/50 dark:bg-red-950/40">
      <Text className="mr-3 flex-1 text-sm text-red-800 dark:text-red-200">{message}</Text>
      <Pressable accessibilityRole="button" onPress={() => void onRetry()} hitSlop={8}>
        <Text className="text-sm font-semibold" style={{ color: primaryColor }}>
          Retry
        </Text>
      </Pressable>
    </View>
  );
}
