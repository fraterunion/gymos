import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { TAB_BAR_CLEARANCE } from '@/components/FloatingTabBar';
import { getColors, Space, type ThemeColors } from '@/constants/Theme';

function cardStyle(C: ThemeColors) {
  return {
    backgroundColor: '#141416',
    borderRadius: 28,
    borderWidth: 1,
    borderColor: C.separator,
    padding: 24,
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

export default function StaffTodayScreen() {
  const C = getColors();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['left', 'right', 'top']}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: Space.screenH,
          paddingBottom: TAB_BAR_CLEARANCE,
        }}
      >
        {/* Header */}
        <Animated.View entering={FadeInDown.duration(450)} style={{ paddingTop: 28, paddingBottom: 24 }}>
          <Text
            style={{
              fontSize: 38,
              fontWeight: '800',
              letterSpacing: -1.3,
              color: C.text,
              lineHeight: 44,
            }}
          >
            Today
          </Text>
          <Text
            style={{
              fontSize: 15,
              color: C.textSub,
              lineHeight: 22,
              marginTop: 10,
              letterSpacing: -0.1,
            }}
          >
            Monitor today&apos;s classes and attendance.
          </Text>
        </Animated.View>

        {/* Roster placeholder */}
        <Animated.View entering={FadeInDown.delay(80).duration(420)}>
          <View style={[cardStyle(C), { alignItems: 'center', paddingVertical: 36 }]}>
            <Text
              style={{
                fontSize: 17,
                fontWeight: '700',
                letterSpacing: -0.3,
                color: C.text,
                textAlign: 'center',
                marginBottom: 6,
              }}
            >
              Today&apos;s roster is coming next.
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
              Class rosters and live attendance will appear here.
            </Text>
          </View>
        </Animated.View>

        {/* Upcoming classes */}
        <Animated.View entering={FadeInDown.delay(120).duration(420)}>
          <SectionLabel>Upcoming classes</SectionLabel>
          <View style={cardStyle(C)}>
            <Text style={{ fontSize: 14, color: C.textSub, lineHeight: 21 }}>
              The next classes on today&apos;s schedule will show here.
            </Text>
          </View>
        </Animated.View>

        {/* Recent check-ins */}
        <Animated.View entering={FadeInDown.delay(160).duration(420)}>
          <SectionLabel>Recent check-ins</SectionLabel>
          <View style={cardStyle(C)}>
            <Text style={{ fontSize: 14, color: C.textSub, lineHeight: 21 }}>
              Members you check in will appear here in real time.
            </Text>
          </View>
        </Animated.View>
      </ScrollView>
    </SafeAreaView>
  );
}
