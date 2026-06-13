import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Alert, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { BrandButton } from '@/components/BrandButton';
import { TAB_BAR_CLEARANCE } from '@/components/FloatingTabBar';
import { useBranding } from '@/contexts/BrandingContext';
import { getColors, Space } from '@/constants/Theme';

export default function StaffScanScreen() {
  const C = getColors();
  const { primaryColor, appDisplayName } = useBranding();

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
        <Animated.View entering={FadeInDown.duration(450)} style={{ paddingTop: 28, paddingBottom: 28 }}>
          <Text
            style={{
              fontSize: 38,
              fontWeight: '800',
              letterSpacing: -1.3,
              color: C.text,
              lineHeight: 44,
            }}
          >
            Staff Check-in
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
            Scan member QR codes at the front desk.
          </Text>
        </Animated.View>

        {/* Hero card */}
        <Animated.View entering={FadeInDown.delay(80).duration(420)}>
          <View
            style={{
              backgroundColor: '#141416',
              borderRadius: 28,
              borderWidth: 1,
              borderColor: C.separator,
              padding: 28,
              alignItems: 'center',
            }}
          >
            <View
              style={{
                width: 120,
                height: 120,
                borderRadius: 28,
                backgroundColor: 'rgba(255,255,255,0.05)',
                borderWidth: 1,
                borderColor: 'rgba(255,255,255,0.10)',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 24,
              }}
            >
              <FontAwesome name="qrcode" size={56} color={C.text} />
            </View>

            <Text
              style={{
                fontSize: 22,
                fontWeight: '800',
                letterSpacing: -0.5,
                color: C.text,
                textAlign: 'center',
                marginBottom: 8,
              }}
            >
              Ready to scan
            </Text>
            <Text
              style={{
                fontSize: 14,
                color: C.textSub,
                lineHeight: 21,
                textAlign: 'center',
                maxWidth: 260,
                marginBottom: 26,
              }}
            >
              Ask the member to open their booking QR code, then point the camera at it.
            </Text>

            <View style={{ alignSelf: 'stretch' }}>
              <BrandButton
                label="Scan Member QR"
                variant="white"
                accentColor={primaryColor}
                onPress={() => Alert.alert('Scanner coming next', 'QR scanning will be enabled in the next update.')}
              />
            </View>
          </View>
        </Animated.View>

        {/* Trust footer */}
        <Animated.View
          entering={FadeInDown.delay(140).duration(420)}
          style={{ alignItems: 'center', marginTop: 24 }}
        >
          <Text
            style={{
              fontSize: 11,
              letterSpacing: 0.8,
              color: C.textMute,
              textTransform: 'uppercase',
              textAlign: 'center',
            }}
          >
            QR validation is secured by {appDisplayName}.
          </Text>
        </Animated.View>
      </ScrollView>
    </SafeAreaView>
  );
}
