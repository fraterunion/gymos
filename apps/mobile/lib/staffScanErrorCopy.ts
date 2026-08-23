/**
 * Pure Front Desk scan/walk-in error copy — no ApiError import so node --test can run it.
 *
 * MEMBERSHIP_EXPIRED must win over the generic "expired" QR branch: walk-in refusals
 * for members without a subscription use that code and must never look like a bad QR.
 */
export function resolveStaffScanErrorCopy(
  message: string,
  status: number,
): { title: string; message: string } {
  const raw = message;
  const m = raw.toLowerCase();

  if (m.includes('already checked in')) {
    return {
      title: 'Ya registrado',
      message: 'Este miembro ya hizo check-in para esta clase.',
    };
  }

  if (/MEMBERSHIP_EXPIRED/i.test(raw) || /membres[ií]a no est[aá] vigente/i.test(raw)) {
    return {
      title: 'Membresía no vigente',
      message: 'Este miembro no tiene una membresía activa. Revisa su estado de pago.',
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
      message:
        'Pide al miembro que actualice su código QR desde la pantalla de reservas e inténtalo de nuevo.',
    };
  }

  if (
    m.includes('time window') ||
    m.includes('not available outside') ||
    m.includes('not yet available')
  ) {
    return {
      title: 'Ventana de check-in cerrada',
      message:
        'El check-in abre 15 minutos antes de la clase y cierra 30 minutos después de que inicia.',
    };
  }

  if (status === 403) {
    return {
      title: 'Sin autorización',
      message: 'Tu cuenta no tiene permiso para registrar miembros en este estudio.',
    };
  }

  if (status === 401) {
    return {
      title: 'Sin autorización',
      message: 'Tu sesión puede haber expirado. Inicia sesión de nuevo e intenta escanear otra vez.',
    };
  }

  if (status >= 500) {
    return {
      title: 'Error de red',
      message:
        'El servicio del estudio no está disponible por el momento. Inténtalo de nuevo en un momento.',
    };
  }

  return {
    title: 'Check-in fallido',
    message: 'No pudimos completar este check-in. Inténtalo de nuevo.',
  };
}
