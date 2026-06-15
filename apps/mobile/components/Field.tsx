import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useState } from 'react';
import { Pressable, Text, TextInput, type TextInputProps, type TextStyle, View } from 'react-native';

import { getColors } from '@/constants/Theme';

type Props = TextInputProps & {
  label: string;
  error?: string | null;
  helperText?: string | null;
  /** Shows eye / eye-off toggle inside the input (right-aligned). */
  showPasswordToggle?: boolean;
};

export function Field({
  label,
  error,
  helperText,
  showPasswordToggle = false,
  style,
  secureTextEntry,
  ...rest
}: Props) {
  const C = getColors();
  const [passwordVisible, setPasswordVisible] = useState(false);
  const isSecure = showPasswordToggle ? !passwordVisible : secureTextEntry;

  return (
    <View style={{ marginBottom: 18, width: '100%' }}>
      <Text
        style={{
          marginBottom: 8,
          fontSize: 11,
          fontWeight: '700',
          letterSpacing: 0.6,
          textTransform: 'uppercase',
          color: C.textMute,
        }}
      >
        {label}
      </Text>
      <View style={{ position: 'relative', justifyContent: 'center' }}>
        <TextInput
          placeholderTextColor={C.textMute}
          secureTextEntry={isSecure}
          style={[
            {
              borderRadius: 14,
              borderWidth: 1,
              borderColor: error ? C.negative : C.separator,
              backgroundColor: '#1A1A1C',
              paddingHorizontal: 16,
              paddingVertical: 14,
              paddingRight: showPasswordToggle ? 48 : 16,
              fontSize: 16,
              color: C.text,
              letterSpacing: -0.1,
            },
            style as TextStyle,
          ]}
          {...rest}
        />
        {showPasswordToggle ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={passwordVisible ? 'Hide password' : 'Show password'}
            hitSlop={8}
            onPress={() => setPasswordVisible((v) => !v)}
            style={{
              position: 'absolute',
              right: 4,
              top: 0,
              bottom: 0,
              width: 44,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <FontAwesome
              name={passwordVisible ? 'eye-slash' : 'eye'}
              size={17}
              color="rgba(255,255,255,0.45)"
            />
          </Pressable>
        ) : null}
      </View>
      {error ? (
        <Text style={{ marginTop: 6, fontSize: 13, color: C.negative, lineHeight: 18 }}>
          {error}
        </Text>
      ) : helperText ? (
        <Text style={{ marginTop: 6, fontSize: 13, color: C.textMute, lineHeight: 18 }}>
          {helperText}
        </Text>
      ) : null}
    </View>
  );
}
