import { Text, View } from 'react-native';

import { getColors } from '@/constants/Theme';

type Props = {
  title: string;
  body?: string;
};

export function MemberScheduleEmptyState({ title, body }: Props) {
  const C = getColors();

  return (
    <View style={{ paddingTop: 32, paddingBottom: 16 }}>
      <Text
        style={{
          fontSize: 17,
          fontWeight: '600',
          color: C.text,
          letterSpacing: -0.3,
          lineHeight: 24,
        }}
      >
        {title}
      </Text>
      {body ? (
        <Text style={{ fontSize: 14, color: C.textSub, marginTop: 8, lineHeight: 21 }}>{body}</Text>
      ) : null}
    </View>
  );
}
