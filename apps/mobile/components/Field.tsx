import { Text, TextInput, type TextInputProps, View } from 'react-native';

type Props = TextInputProps & {
  label: string;
  error?: string | null;
};

export function Field({ label, error, className, ...rest }: Props) {
  return (
    <View className="mb-4 w-full">
      <Text className="mb-2 text-sm font-medium text-neutral-600 dark:text-neutral-400">{label}</Text>
      <TextInput
        placeholderTextColor="#737373"
        className={`rounded-xl border bg-white px-4 py-3.5 text-base text-neutral-900 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 ${
          error ? 'border-red-400' : 'border-neutral-200 dark:border-neutral-700'
        } ${className ?? ''}`}
        {...rest}
      />
      {error ? <Text className="mt-1.5 text-sm text-red-500">{error}</Text> : null}
    </View>
  );
}
