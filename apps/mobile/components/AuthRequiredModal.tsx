import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Modal, Pressable, Text, useWindowDimensions, View } from 'react-native';

import { getColors } from '@/constants/Theme';

export type AuthRequiredModalProps = {
  visible: boolean;
  title?: string;
  description?: string;
  primaryLabel?: string;
  secondaryLabel?: string;
  onPrimary: () => void;
  onSecondary: () => void;
  onClose: () => void;
};

const DEFAULT_TITLE = 'Create your account';
const DEFAULT_DESCRIPTION =
  'Create an account to book classes, purchase day passes, manage memberships, and track your training.';
const DEFAULT_PRIMARY_LABEL = 'Create Account';
const DEFAULT_SECONDARY_LABEL = 'Log In';

const CARD_MAX_WIDTH = 420;

export function AuthRequiredModal({
  visible,
  title = DEFAULT_TITLE,
  description = DEFAULT_DESCRIPTION,
  primaryLabel = DEFAULT_PRIMARY_LABEL,
  secondaryLabel = DEFAULT_SECONDARY_LABEL,
  onPrimary,
  onSecondary,
  onClose,
}: AuthRequiredModalProps) {
  const C = getColors();
  const { width: screenWidth } = useWindowDimensions();
  const cardWidth = Math.min(screenWidth * 0.9, CARD_MAX_WIDTH);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close dialog"
        onPress={onClose}
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'rgba(0,0,0,0.72)',
          paddingHorizontal: 20,
        }}
      >
        <Pressable
          onPress={() => {}}
          style={{
            width: cardWidth,
            backgroundColor: '#141416',
            borderRadius: 28,
            borderWidth: 1,
            borderColor: C.separator,
            paddingHorizontal: 28,
            paddingTop: 32,
            paddingBottom: 28,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={onClose}
            hitSlop={12}
            style={{
              position: 'absolute',
              top: 16,
              right: 16,
              width: 32,
              height: 32,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 16,
              backgroundColor: 'rgba(255,255,255,0.06)',
            }}
          >
            <FontAwesome name="close" size={14} color={C.textMute} />
          </Pressable>

          <View style={{ alignItems: 'center', marginBottom: 24 }}>
            <View
              style={{
                width: 56,
                height: 56,
                borderRadius: 28,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: 'rgba(255,255,255,0.08)',
                borderWidth: 1,
                borderColor: 'rgba(255,255,255,0.10)',
              }}
            >
              <FontAwesome name="lock" size={24} color={C.text} />
            </View>
          </View>

          <Text
            style={{
              fontSize: 24,
              fontWeight: '800',
              letterSpacing: -0.6,
              color: C.text,
              textAlign: 'center',
              lineHeight: 30,
              marginBottom: 12,
            }}
          >
            {title}
          </Text>

          <Text
            style={{
              fontSize: 15,
              color: C.textSub,
              textAlign: 'center',
              lineHeight: 23,
              letterSpacing: -0.1,
              marginBottom: 28,
            }}
          >
            {description}
          </Text>

          {/* Primary CTA — solid white surface, dark text for guaranteed contrast
              on the dark modal card. Static style (no function) so the white
              background can never be dropped by a style-resolution edge case. */}
          <Pressable
            accessibilityRole="button"
            onPress={onPrimary}
            style={{
              minHeight: 60,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 22,
              backgroundColor: '#FFFFFF',
            }}
          >
            <Text
              style={{
                fontSize: 16,
                fontWeight: '700',
                letterSpacing: -0.2,
                color: '#0A0A0A',
                textAlign: 'center',
              }}
            >
              {primaryLabel}
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            onPress={onSecondary}
            style={({ pressed }) => ({
              minHeight: 60,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 22,
              marginTop: 12,
              borderWidth: 1,
              borderColor: 'rgba(255,255,255,0.75)',
              backgroundColor: pressed ? 'rgba(255,255,255,0.06)' : 'transparent',
            })}
          >
            <Text
              style={{
                fontSize: 16,
                fontWeight: '700',
                letterSpacing: -0.2,
                color: '#FFFFFF',
                textAlign: 'center',
              }}
            >
              {secondaryLabel}
            </Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
