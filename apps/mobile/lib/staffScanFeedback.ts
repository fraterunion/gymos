import { ApiError } from '@/lib/api/errors';
import { fetchPublicSchedule } from '@/lib/api/publicScheduleApi';
import { scheduledClassTitle } from '@/lib/classUtils';
import { buildScheduleQueryRange, formatClassTime } from '@/lib/datetime';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';

export type StaffScanSuccessDetails = {
  memberName: string;
  className: string;
  classStartTime: string;
  checkedInAt: string;
};

export function staffScanErrorCopy(error: unknown): { title: string; message: string } {
  if (!(error instanceof ApiError)) {
    return {
      title: 'Error de red',
      message: 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.',
    };
  }

  const raw = error.message;
  const m = raw.toLowerCase();

  if (m.includes('already checked in')) {
    return {
      title: 'Ya registrado',
      message: 'Este miembro ya hizo check-in para esta clase.',
    };
  }

  if (
    m.includes('already used') ||
    m.includes('expired') ||
    m.includes('invalid qr') ||
    m.includes('invalid or expired')
  ) {
    return {
      title: 'Código QR expirado o inválido',
      message: 'Pide al miembro que actualice su código QR desde la pantalla de reservas e inténtalo de nuevo.',
    };
  }

  if (m.includes('time window') || m.includes('not available outside')) {
    return {
      title: 'Ventana de check-in cerrada',
      message: 'El check-in abre 15 minutos antes de la clase y cierra 30 minutos después de que inicia.',
    };
  }

  if (error.status === 403) {
    return {
      title: 'Sin autorización',
      message: 'Tu cuenta no tiene permiso para registrar miembros en este estudio.',
    };
  }

  if (error.status === 401) {
    return {
      title: 'Sin autorización',
      message: 'Tu sesión puede haber expirado. Inicia sesión de nuevo e intenta escanear otra vez.',
    };
  }

  if (error.status >= 500) {
    return {
      title: 'Error de red',
      message: 'El servicio del estudio no está disponible por el momento. Inténtalo de nuevo en un momento.',
    };
  }

  return {
    title: 'Check-in fallido',
    message: userFacingApiMessage(error, 'No pudimos completar este check-in. Inténtalo de nuevo.'),
  };
}

export async function resolveStaffScanClassDetails(
  scheduledClassId: string,
  studioSlug: string,
  timeZone: string,
): Promise<{ className: string; classStartTime: string }> {
  const { from, to } = buildScheduleQueryRange();
  try {
    const classes = await fetchPublicSchedule(studioSlug, from, to);
    const cls = classes.find((c) => c.id === scheduledClassId);
    return {
      className: scheduledClassTitle(scheduledClassId, classes),
      classStartTime: cls ? formatClassTime(cls.startsAt, timeZone) : '—',
    };
  } catch {
    return {
      className: 'Clase programada',
      classStartTime: '—',
    };
  }
}
