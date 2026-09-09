import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Modal, Pressable, Text, useWindowDimensions, View } from 'react-native';

import { BrandButton } from '@/components/BrandButton';
import { getColors } from '@/constants/Theme';

export type BookingConfirmedModalProps = {
  visible: boolean;
  /** Studio-branded app name, so the arrival hint reads correctly for any tenant. */
  appDisplayName: string;
  accentColor: string;
  /** MM-5: e.g. "Usará 1 crédito de Booty Lab" — only set when a scarce credit was consumed. */
  chargeNote?: string | null;
  onDismiss: () => void;
};

const CARD_MAX_WIDTH = 420;

/**
 * Confirmation shown after a reservation succeeds. Deliberately has no QR and no code:
 * a reservation is not a credential. It points the member at Mi Pase, which is the one
 * permanent thing Front Desk scans, no matter how many classes they book.
 */
export function BookingConfirmedModal({
  visible,
  appDisplayName,
  accentColor,
  chargeNote,
  onDismiss,
}: BookingConfirmedModalProps) {
  const C = getColors();
  const { width: screenWidth } = useWindowDimensions();
  const cardWidth = Math.min(screenWidth * 0.9, CARD_MAX_WIDTH);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onDismiss}
      statusBarTranslucent
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cerrar confirmación"
        onPress={onDismiss}
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
            alignItems: 'center',
          }}
        >
          <View
            style={{
              width: 64,
              height: 64,
              borderRadius: 32,
              backgroundColor: 'rgba(52,211,153,0.14)',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 20,
            }}
          >
            <FontAwesome name="check" size={28} color={C.positive} />
          </View>

          <Text
            accessibilityRole="header"
            style={{
              fontSize: 26,
              fontWeight: '800',
              letterSpacing: -0.7,
              color: C.text,
              textAlign: 'center',
              marginBottom: 10,
            }}
          >
            Clase reservada
          </Text>

          <Text
            style={{
              fontSize: 15,
              color: C.textSub,
              lineHeight: 23,
              textAlign: 'center',
              marginBottom: 6,
            }}
          >
            Tu reserva ya aparece en Mis reservas.
          </Text>

          {chargeNote ? (
            <Text
              style={{
                fontSize: 14,
                fontWeight: '600',
                color: C.text,
                lineHeight: 21,
                textAlign: 'center',
                marginBottom: 12,
              }}
            >
              {chargeNote}
            </Text>
          ) : null}

          <Text
            style={{
              fontSize: 14,
              color: C.textMute,
              lineHeight: 21,
              textAlign: 'center',
              marginBottom: 24,
            }}
          >
            Al llegar, presenta Mi Pase desde {appDisplayName} o Apple Wallet.
          </Text>

          <View style={{ alignSelf: 'stretch' }}>
            <BrandButton label="Listo" accentColor={accentColor} onPress={onDismiss} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
