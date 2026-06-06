import { Text, View } from 'react-native';

import { statusConfig } from '@/lib/membershipStatus';

type Props = {
  status: string;
  cancelAtPeriodEnd: boolean;
};

export function MembershipStatusPill({ status, cancelAtPeriodEnd }: Props) {
  const cfg = statusConfig(status, cancelAtPeriodEnd);

  return (
    <View
      style={{
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: cfg.bg,
        borderRadius: 100,
        paddingVertical: 5,
        paddingHorizontal: 10,
      }}
    >
      <View
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: cfg.dotColor,
          marginRight: 6,
        }}
      />
      <Text
        style={{
          fontSize: 11,
          fontWeight: '700',
          letterSpacing: 0.6,
          textTransform: 'uppercase',
          color: cfg.textColor,
        }}
      >
        {cfg.label}
      </Text>
    </View>
  );
}
