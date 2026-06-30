import { apiRequest } from '@/lib/api/client';

export type MemberOperationalNoteDto = {
  id: string;
  studioId: string;
  memberUserId: string;
  authorUserId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  author: {
    id: string;
    firstName: string;
    lastName: string;
  };
};

export async function fetchMemberOperationalNotes(
  studioId: string,
  memberUserId: string,
  limit = 30,
): Promise<MemberOperationalNoteDto[]> {
  return apiRequest<MemberOperationalNoteDto[]>(
    `/studios/${studioId}/members/${memberUserId}/operational-notes?limit=${limit}`,
    { method: 'GET' },
  );
}

export async function createMemberOperationalNote(
  studioId: string,
  memberUserId: string,
  body: string,
): Promise<MemberOperationalNoteDto> {
  return apiRequest<MemberOperationalNoteDto>(
    `/studios/${studioId}/members/${memberUserId}/operational-notes`,
    {
      method: 'POST',
      body: JSON.stringify({ body }),
    },
  );
}

export function noteAuthorName(note: MemberOperationalNoteDto): string {
  return `${note.author.firstName} ${note.author.lastName}`.trim() || 'Staff';
}
