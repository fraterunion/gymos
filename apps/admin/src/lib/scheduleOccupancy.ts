/** Occupancy labels for Calendar cards and session drawer (Spanish ARES). */

export type OccupancyTone = "normal" | "near" | "full" | "waitlist";

export function formatOccupancyLabel(
  booked: number,
  capacity: number,
  waitlist = 0,
): { label: string; tone: OccupancyTone } {
  if (booked >= capacity) {
    if (waitlist > 0) {
      return {
        label: `${booked}/${capacity} · +${waitlist} en espera`,
        tone: "waitlist",
      };
    }
    return { label: `${booked}/${capacity} · Llena`, tone: "full" };
  }
  if (booked >= Math.max(1, capacity - 2)) {
    return { label: `${booked}/${capacity} reservados`, tone: "near" };
  }
  return { label: `${booked}/${capacity} reservados`, tone: "normal" };
}

export function occupancyToneClass(tone: OccupancyTone): string {
  switch (tone) {
    case "near":
      return "text-amber-700";
    case "full":
      return "text-zinc-600";
    case "waitlist":
      return "text-indigo-700";
    default:
      return "text-zinc-400";
  }
}

export function formatRosterStatus(
  operationalStatus: "RESERVED" | "ATTENDED" | "WALK_IN",
  checkedInAt: string | null,
  tz: string,
): string {
  if (operationalStatus === "ATTENDED" || operationalStatus === "WALK_IN") {
    const time = checkedInAt
      ? new Intl.DateTimeFormat("es-MX", {
          timeZone: tz,
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date(checkedInAt))
      : null;
    return time ? `Asistió · ${time}` : "Asistió";
  }
  return "Reservado";
}

export function formatClassStatusLabel(status: string): string {
  switch (status) {
    case "SCHEDULED":
      return "Programada";
    case "CANCELLED":
      return "Cancelada";
    case "COMPLETED":
      return "Completada";
    default:
      return status;
  }
}
