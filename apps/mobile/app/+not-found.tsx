import { Link, Stack } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: 'Not found' }} />
      <View className="flex-1 items-center justify-center bg-neutral-50 px-6 dark:bg-neutral-950">
        <Text className="text-center text-lg font-medium text-neutral-800 dark:text-neutral-100">
          This screen does not exist.
        </Text>
        <Link href="/" asChild>
          <Pressable className="mt-6">
            <Text className="text-base font-semibold text-neutral-900 underline dark:text-neutral-100">
              Back to start
            </Text>
          </Pressable>
        </Link>
      </View>
    </>
  );
}
