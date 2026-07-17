import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';

import { MemberRow } from '@/components/staff/StaffPrimitives';
import { getColors, Radius, Space } from '@/constants/Theme';
import { ApiError } from '@/lib/api/errors';
import { registerManualClassAttendance, type AttendanceSummaryDto } from '@/lib/api/checkInsApi';
import {
  fetchMembers,
  memberDisplayName,
  type MemberListItem,
} from '@/lib/api/membersDirectoryApi';

type Step = 'search' | 'confirm';

function isActiveMember(member: MemberListItem): boolean {
  const status = member.subscription?.status;
  return status === 'ACTIVE' || status === 'TRIALING';
}

function memberInitials(firstName: string, lastName: string): string {
  const a = firstName?.[0] ?? '';
  const b = lastName?.[0] ?? '';
  return `${a}${b}`.toUpperCase() || '?';
}

function friendlyRegisterError(e: unknown): string {
  if (e instanceof ApiError) {
    const m = e.message.toLowerCase();
    if (m.includes('already registered')) return 'Asistencia ya registrada.';
    if (m.includes('inactive')) return 'No se puede registrar asistencia porque la membresía está inactiva.';
    if (m.includes('window') || m.includes('not yet available')) {
      return 'El check-in está fuera de la ventana permitida para esta clase.';
    }
    if (e.status === 403) return 'No tienes permiso para registrar asistencia.';
    return e.message;
  }
  return 'Algo salió mal.';
}

export function RegisterAttendanceModal({
  visible,
  studioId,
  classId,
  reservedUserIds,
  onClose,
  onRegistered,
}: {
  visible: boolean;
  studioId: string;
  classId: string;
  reservedUserIds: Set<string>;
  onClose: () => void;
  onRegistered: (row: AttendanceSummaryDto) => void;
}) {
  const C = getColors();
  const [step, setStep] = useState<Step>('search');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [members, setMembers] = useState<MemberListItem[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selected, setSelected] = useState<MemberListItem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 200);
    return () => clearTimeout(t);
  }, [search, visible]);

  useEffect(() => {
    if (!visible) {
      setStep('search');
      setSearch('');
      setDebouncedSearch('');
      setMembers([]);
      setSelected(null);
      setError(null);
      setSubmitting(false);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible || !studioId) return;
    let cancelled = false;
    const run = async () => {
      setSearchLoading(true);
      setError(null);
      try {
        const res = await fetchMembers(studioId, {
          search: debouncedSearch || undefined,
          role: 'MEMBER',
          sortBy: 'name',
          sortDir: 'asc',
          limit: 50,
        });
        if (cancelled) return;
        setMembers(res.data.filter(isActiveMember));
      } catch (e) {
        if (!cancelled) {
          setMembers([]);
          setError(e instanceof ApiError ? e.message : 'No pudimos buscar miembros.');
        }
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [visible, studioId, debouncedSearch]);

  const hasReservation = useMemo(
    () => (selected ? reservedUserIds.has(selected.user.id) : false),
    [selected, reservedUserIds],
  );

  const selectMember = useCallback((member: MemberListItem) => {
    setSelected(member);
    setStep('confirm');
    setError(null);
  }, []);

  const submit = useCallback(async () => {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      const row = await registerManualClassAttendance(studioId, classId, selected.user.id);
      onRegistered(row);
      onClose();
    } catch (e) {
      setError(friendlyRegisterError(e));
    } finally {
      setSubmitting(false);
    }
  }, [selected, studioId, classId, onRegistered, onClose]);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }}
        onPress={onClose}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            maxHeight: '85%',
            backgroundColor: C.surface2,
            borderTopLeftRadius: Radius.card,
            borderTopRightRadius: Radius.card,
            paddingHorizontal: Space.screenH,
            paddingTop: Space.sp4,
            paddingBottom: Space.sp5,
          }}
        >
          {step === 'search' ? (
            <>
              <Text style={{ fontSize: 20, fontWeight: '700', color: C.text }}>Registrar asistencia</Text>
              <Text style={{ fontSize: 14, color: C.textSub, marginTop: 6, lineHeight: 20 }}>
                Selecciona un miembro que asistió a esta clase.
              </Text>

              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder="Buscar miembros…"
                placeholderTextColor={C.textMute}
                autoFocus
                style={{
                  marginTop: Space.sp4,
                  borderWidth: 1,
                  borderColor: C.separator,
                  borderRadius: Radius.button,
                  paddingHorizontal: Space.sp3,
                  paddingVertical: 12,
                  fontSize: 15,
                  color: C.text,
                  backgroundColor: C.bg,
                }}
              />

              {error ? (
                <Text style={{ marginTop: Space.sp2, fontSize: 13, color: C.negative }}>{error}</Text>
              ) : null}

              <ScrollView style={{ marginTop: Space.sp3, maxHeight: 360 }} keyboardShouldPersistTaps="handled">
                {searchLoading && members.length === 0 ? (
                  <View style={{ paddingVertical: Space.sp5, alignItems: 'center' }}>
                    <ActivityIndicator color={C.textMute} />
                  </View>
                ) : null}
                {!searchLoading && members.length === 0 ? (
                  <Text style={{ textAlign: 'center', color: C.textMute, paddingVertical: Space.sp5 }}>
                    No hay miembros activos.
                  </Text>
                ) : null}
                {members.map((member, index) => (
                  <MemberRow
                    key={member.membershipId}
                    initials={memberInitials(member.user.firstName, member.user.lastName)}
                    name={memberDisplayName(member)}
                    subtitle={member.subscription?.planName ?? member.user.email}
                    index={index}
                    onPress={() => selectMember(member)}
                  />
                ))}
              </ScrollView>

              <Pressable
                accessibilityRole="button"
                onPress={onClose}
                style={{
                  marginTop: Space.sp4,
                  paddingVertical: 14,
                  borderRadius: Radius.button,
                  borderWidth: 1,
                  borderColor: C.separator,
                  alignItems: 'center',
                }}
              >
                <Text style={{ fontSize: 15, fontWeight: '600', color: C.textSub }}>Cancelar</Text>
              </Pressable>
            </>
          ) : selected ? (
            <>
              <Text style={{ fontSize: 20, fontWeight: '700', color: C.text }}>
                {memberDisplayName(selected)}
              </Text>
              <Text style={{ fontSize: 14, color: C.textSub, marginTop: 6 }}>
                {selected.subscription?.planName ?? 'Membresía activa'}
              </Text>
              <Text style={{ fontSize: 15, color: C.text, marginTop: Space.sp4, lineHeight: 22 }}>
                {hasReservation
                  ? 'Este miembro ya tiene una reservación.'
                  : 'Este miembro no tiene reservación para esta clase.'}{' '}
                ¿Registrar asistencia?
              </Text>

              {error ? (
                <Text style={{ marginTop: Space.sp3, fontSize: 13, color: C.negative }}>{error}</Text>
              ) : null}

              <View style={{ flexDirection: 'row', gap: Space.sp2, marginTop: Space.sp5 }}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    setStep('search');
                    setSelected(null);
                    setError(null);
                  }}
                  disabled={submitting}
                  style={{
                    flex: 1,
                    paddingVertical: 14,
                    borderRadius: Radius.button,
                    borderWidth: 1,
                    borderColor: C.separator,
                    alignItems: 'center',
                    opacity: submitting ? 0.5 : 1,
                  }}
                >
                  <Text style={{ fontSize: 15, fontWeight: '600', color: C.textSub }}>Cancelar</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void submit()}
                  disabled={submitting}
                  style={{
                    flex: 1,
                    paddingVertical: 14,
                    borderRadius: Radius.button,
                    backgroundColor: C.text,
                    alignItems: 'center',
                    opacity: submitting ? 0.5 : 1,
                  }}
                >
                  <Text style={{ fontSize: 15, fontWeight: '700', color: C.bg }}>
                    {submitting ? '…' : 'Registrar asistencia'}
                  </Text>
                </Pressable>
              </View>
            </>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
