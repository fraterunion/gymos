import { Text, View } from 'react-native';

export function LowSpotsBadge({ label }: { label: string }) {
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        marginTop: 8,
        paddingVertical: 4,
        paddingHorizontal: 10,
        borderRadius: 100,
        backgroundColor: 'rgba(245,158,11,0.14)',
        borderWidth: 1,
        borderColor: 'rgba(245,158,11,0.35)',
      }}
    >
      <Text
        style={{
          fontSize: 11,
          fontWeight: '700',
          letterSpacing: 0.4,
          textTransform: 'uppercase',
          color: '#FBBF24',
        }}
      >
        {label}
      </Text>
    </View>
  );
}
