/** Official ARES weekly class themes for schedule filtering. */

export const ARES_CLASS_FILTER_ALL = 'all';

export type AresClassFilter = {
  id: string;
  label: string;
};

export const ARES_CLASS_FILTERS: AresClassFilter[] = [
  { id: ARES_CLASS_FILTER_ALL, label: 'Todos' },
  { id: 'Legs + HIIT', label: 'Legs + HIIT' },
  { id: 'Pull', label: 'Pull' },
  { id: 'Push', label: 'Push' },
  { id: 'Full Body + Core', label: 'Full Body + Core' },
  { id: 'Legs Strength', label: 'Legs Strength' },
  { id: 'Street Bars', label: 'Street Bars' },
  { id: 'Upperbody', label: 'Upperbody' },
  { id: 'Full Body', label: 'Full Body' },
];

export function matchesAresClassFilter(className: string, filterId: string): boolean {
  if (filterId === ARES_CLASS_FILTER_ALL) return true;
  return className.trim() === filterId;
}
