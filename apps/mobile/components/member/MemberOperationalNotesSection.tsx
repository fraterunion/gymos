import { useCallback, useState } from 'react';
import { ActivityIndicator, Text, TextInput, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { BrandButton } from '@/components/BrandButton';
import { useBranding } from '@/contexts/BrandingContext';
import {
  createMemberOperationalNote,
  noteAuthorName,
  type MemberOperationalNoteDto,
} from '@/lib/api/memberOperationalNotesApi';
import { formatProfileDateTime } from '@/lib/memberProfileHelpers';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';
import { getColors, type ThemeColors } from '@/constants/Theme';

const CARD_BG = '#141416';

function cardStyle(C: ThemeColors) {
  return {
    backgroundColor: CARD_BG,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: C.separator,
    padding: 24,
  } as const;
}

function NoteCard({ note, index }: { note: MemberOperationalNoteDto; index: number }) {
  const C = getColors();

  return (
    <Animated.View
      entering={FadeInDown.delay(Math.min(index * 30, 150)).duration(320)}
      style={{
        borderBottomWidth: 1,
        borderBottomColor: C.separator,
        paddingVertical: 16,
      }}
    >
      <Text style={{ fontSize: 15, lineHeight: 22, color: C.text }}>{note.body}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
        <Text style={{ fontSize: 12, fontWeight: '600', color: C.textSub }}>{noteAuthorName(note)}</Text>
        <Text style={{ fontSize: 12, color: C.textMute }}>·</Text>
        <Text style={{ fontSize: 12, color: C.textMute }}>{formatProfileDateTime(note.createdAt)}</Text>
      </View>
    </Animated.View>
  );
}

type Props = {
  studioId: string;
  memberUserId: string;
  notes: MemberOperationalNoteDto[] | null;
  notesLoading: boolean;
  notesError: string | null;
  canCreate: boolean;
  onNotesChanged: (notes: MemberOperationalNoteDto[]) => void;
  onRetry: () => void;
  animationDelay?: number;
};

export function MemberOperationalNotesSection({
  studioId,
  memberUserId,
  notes,
  notesLoading,
  notesError,
  canCreate,
  onNotesChanged,
  onRetry,
  animationDelay = 120,
}: Props) {
  const C = getColors();
  const { primaryColor } = useBranding();

  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState(false);

  const trimmed = draft.trim();
  const canSubmit = canCreate && trimmed.length > 0 && !submitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    setSubmitSuccess(false);
    try {
      const created = await createMemberOperationalNote(studioId, memberUserId, trimmed);
      setDraft('');
      setSubmitSuccess(true);
      onNotesChanged([created, ...(notes ?? [])]);
    } catch (e) {
      setSubmitError(userFacingApiMessage(e, 'No se pudo guardar la nota'));
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, memberUserId, notes, onNotesChanged, studioId, trimmed]);

  return (
    <>
      <Text
        style={{
          fontSize: 11,
          fontWeight: '700',
          letterSpacing: 1.2,
          textTransform: 'uppercase',
          color: C.textMute,
          marginBottom: 14,
          marginTop: 28,
        }}
      >
        Notas internas
      </Text>

      <Animated.View entering={FadeInDown.delay(animationDelay).duration(380)} style={cardStyle(C)}>
        <Text style={{ fontSize: 13, lineHeight: 19, color: C.textMute, marginBottom: 16 }}>
          Solo visible para el equipo. El miembro no ve estas notas.
        </Text>

        {notesLoading ? (
          <ActivityIndicator color={primaryColor} style={{ marginVertical: 24 }} />
        ) : notesError ? (
          <View style={{ gap: 12 }}>
            <Text style={{ fontSize: 14, lineHeight: 20, color: '#FCA5A5' }}>{notesError}</Text>
            <BrandButton label="Reintentar" accentColor={primaryColor} variant="ghost" onPress={onRetry} />
          </View>
        ) : notes?.length ? (
          notes.map((note, i) => <NoteCard key={note.id} note={note} index={i} />)
        ) : (
          <Text style={{ fontSize: 14, color: C.textMute, lineHeight: 20, paddingVertical: 8 }}>
            Sin notas internas
          </Text>
        )}

        {canCreate ? (
          <View
            style={{
              marginTop: 20,
              paddingTop: 20,
              borderTopWidth: 1,
              borderTopColor: C.separator,
              gap: 12,
            }}
          >
            <Text
              style={{
                fontSize: 11,
                fontWeight: '700',
                letterSpacing: 0.8,
                textTransform: 'uppercase',
                color: C.textMute,
              }}
            >
              Agregar nota
            </Text>
            <TextInput
              value={draft}
              onChangeText={(text) => {
                setDraft(text);
                setSubmitSuccess(false);
                setSubmitError(null);
              }}
              placeholder="Contexto operativo, seguimiento, preferencias…"
              placeholderTextColor={C.textMute}
              multiline
              maxLength={5000}
              editable={!submitting}
              style={{
                minHeight: 96,
                borderRadius: 16,
                borderWidth: 1,
                borderColor: C.separator,
                backgroundColor: '#1A1A1C',
                paddingHorizontal: 16,
                paddingVertical: 14,
                fontSize: 15,
                lineHeight: 22,
                color: C.text,
                textAlignVertical: 'top',
              }}
            />
            {submitError ? (
              <Text style={{ fontSize: 13, color: '#FCA5A5', lineHeight: 18 }}>{submitError}</Text>
            ) : null}
            {submitSuccess ? (
              <Text style={{ fontSize: 13, color: C.positive, lineHeight: 18 }}>Nota guardada</Text>
            ) : null}
            <BrandButton
              label={submitting ? 'Guardando…' : 'Guardar nota'}
              accentColor={primaryColor}
              onPress={() => void handleSubmit()}
              disabled={!canSubmit}
            />
          </View>
        ) : (
          <Text style={{ fontSize: 13, color: C.textMute, marginTop: 16, lineHeight: 19 }}>
            Solo lectura — no puedes agregar notas con tu rol.
          </Text>
        )}
      </Animated.View>
    </>
  );
}
