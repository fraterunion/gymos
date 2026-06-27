export type AvatarPalette = {
  bg: string;
  text: string;
  ring: string;
};

const AVATAR_PALETTE: AvatarPalette[] = [
  { bg: '#2A2A2E', text: '#E4E4E7', ring: 'rgba(228,228,231,0.18)' },
  { bg: 'rgba(16,185,129,0.22)', text: '#6EE7B7', ring: 'rgba(110,231,183,0.22)' },
  { bg: 'rgba(59,130,246,0.22)', text: '#93C5FD', ring: 'rgba(147,197,253,0.22)' },
  { bg: 'rgba(168,85,247,0.22)', text: '#C4B5FD', ring: 'rgba(196,181,253,0.22)' },
  { bg: 'rgba(249,115,22,0.22)', text: '#FDBA74', ring: 'rgba(253,186,116,0.22)' },
];

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function staffAvatarPalette(seed: string): AvatarPalette {
  const index = hashString(seed) % AVATAR_PALETTE.length;
  return AVATAR_PALETTE[index]!;
}

export function staffInitials(firstName: string, lastName?: string | null): string {
  const first = firstName?.trim() ?? '';
  const last = lastName?.trim() ?? '';
  if (first && last) {
    return `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase();
  }
  if (first) return first[0]!.toUpperCase();
  if (last) return last[0]!.toUpperCase();
  return '?';
}
