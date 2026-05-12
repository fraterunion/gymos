import { ActivityIndicator, Pressable, Text, type PressableProps } from 'react-native';

type Props = PressableProps & {
  label: string;
  loading?: boolean;
  variant?: 'primary' | 'ghost';
  accentColor: string;
};

export function BrandButton({
  label,
  loading,
  variant = 'primary',
  accentColor,
  disabled,
  className,
  ...rest
}: Props) {
  const isPrimary = variant === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      className={`min-h-[52px] w-full items-center justify-center rounded-2xl px-5 active:opacity-90 ${
        isPrimary ? '' : 'border border-neutral-300 dark:border-neutral-600'
      } ${className ?? ''}`}
      style={
        isPrimary
          ? { backgroundColor: accentColor, opacity: disabled || loading ? 0.55 : 1 }
          : { opacity: disabled || loading ? 0.55 : 1 }
      }
      {...rest}>
      {loading ? (
        <ActivityIndicator color={isPrimary ? '#fff' : accentColor} />
      ) : (
        <Text
          className={`text-base font-semibold ${isPrimary ? 'text-white' : 'text-neutral-900 dark:text-neutral-100'}`}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}
