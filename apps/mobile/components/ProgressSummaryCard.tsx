import { Pressable, Text, View } from 'react-native';

import { getColors } from '@/constants/Theme';
import type { MemberProgressDto } from '@/lib/api/progressApi';

type Props = {
  progress: MemberProgressDto;
  onViewProgress: () => void;
};

function Stat({ value, label }: { value: string; label: string }) {
  const C = getColors();
  return (
    <View style={{ flex: 1, alignItems: 'center' }}>
      <Text
        style={{
          fontSize: 26,
          fontWeight: '800',
          letterSpacing: -0.8,
          color: C.text,
          lineHeight: 30,
        }}
      >
        {value}
      </Text>
      <Text
        style={{
          fontSize: 10,
          fontWeight: '700',
          letterSpacing: 0.7,
          textTransform: 'uppercase',
          color: C.textMute,
          marginTop: 4,
        }}
      >
        {label}
      </Text>
    </View>
  );
}

export function ProgressSummaryCard({ progress, onViewProgress }: Props) {
  const C = getColors();

  return (
    <View
      style={{
        backgroundColor: '#141416',
        borderRadius: 24,
        borderWidth: 1,
        borderColor: C.separator,
        padding: 24,
      }}
    >
      <Text
        style={{
          fontSize: 11,
          fontWeight: '700',
          letterSpacing: 1.1,
          textTransform: 'uppercase',
          color: C.textMute,
          marginBottom: 20,
        }}
      >
        Tu entrenamiento
      </Text>

      <View style={{ flexDirection: 'row' }}>
        <Stat value={String(progress.totalCheckIns)} label="Check-ins" />
        <Stat value={String(progress.monthCheckIns)} label="Este mes" />
        <Stat
          value={`${progress.currentStreak}w`}
          label="Racha"
        />
      </View>

      {progress.favoriteClass ? (
        <View
          style={{
            marginTop: 20,
            paddingTop: 16,
            borderTopWidth: 1,
            borderTopColor: C.separator,
          }}
        >
          <Text style={{ fontSize: 12, color: C.textMute, marginBottom: 3 }}>
            Clase favorita
          </Text>
          <Text
            style={{
              fontSize: 15,
              fontWeight: '600',
              color: C.text,
              letterSpacing: -0.2,
            }}
          >
            {progress.favoriteClass.name}
          </Text>
        </View>
      ) : null}

      <Pressable
        accessibilityRole="button"
        onPress={onViewProgress}
        hitSlop={8}
        style={{ marginTop: 18 }}
      >
        <Text
          style={{
            fontSize: 15,
            fontWeight: '600',
            color: C.text,
            letterSpacing: -0.2,
          }}
        >
          Ver progreso →
        </Text>
      </Pressable>
    </View>
  );
}
