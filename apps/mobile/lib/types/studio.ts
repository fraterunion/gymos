export type MyStudioRow = {
  studio: {
    id: string;
    name: string;
    slug: string;
    timezone: string;
  };
  role: string;
};

export type ClassTemplateSummary = {
  id: string;
  name: string;
  durationMinutes: number;
  description: string | null;
  defaultCapacity: number;
  color: string | null;
};

export type InstructorSummary = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
};

export type ScheduledClassDto = {
  id: string;
  studioId: string;
  startsAt: string;
  endsAt: string;
  capacity: number;
  status: string;
  instructorId: string | null;
  classTemplateId: string;
  classTemplate: ClassTemplateSummary;
  instructor: InstructorSummary | null;
};

export type BookingWithClass = {
  id: string;
  studioId: string;
  scheduledClassId: string;
  userId: string;
  status: string;
  scheduledClass: {
    id: string;
    studioId: string;
    startsAt: string;
    endsAt: string;
    capacity: number;
    status: string;
    instructorId: string | null;
    classTemplateId: string;
  };
};

export type MyWaitlistEntry = {
  id: string;
  studioId: string;
  scheduledClassId: string;
  status: string;
  position: number;
  queueRank: number | null;
  waitingCountForClass: number;
  createdAt: string;
  scheduledClass: {
    id: string;
    studioId: string;
    startsAt: string;
    endsAt: string;
    capacity: number;
    status: string;
    instructorId: string | null;
    classTemplateId: string;
  };
};

export type BookingCancelResponse = {
  cancelled: boolean;
  promotion: {
    performed: true;
    bookingId: string;
    waitlistEntryId: string;
    userId: string;
  } | null;
};

export type WaitlistJoinResponse = {
  id: string;
  studioId: string;
  scheduledClassId: string;
  status: string;
  position: number;
  createdAt: string;
};
