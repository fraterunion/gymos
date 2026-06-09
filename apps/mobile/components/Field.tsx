import { Text, TextInput, type TextInputProps, type TextStyle, View } from 'react-native';

import { getColors } from '@/constants/Theme';

type Props = TextInputProps & {
  label: string;
  error?: string | null;
};

export function Field({ label, error, style, ...rest }: Props) {
  const C = getColors();

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
      <TextInput
        placeholderTextColor={C.textMute}
        style={[
          {
            borderRadius: 14,
            borderWidth: 1,
            borderColor: error ? C.negative : C.separator,
            backgroundColor: '#1A1A1C',
            paddingHorizontal: 16,
            paddingVertical: 14,
            fontSize: 16,
            color: C.text,
            letterSpacing: -0.1,
          },
          style as TextStyle,
        ]}
        {...rest}
      />
      {error ? (
        <Text style={{ marginTop: 6, fontSize: 13, color: C.negative, lineHeight: 18 }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
