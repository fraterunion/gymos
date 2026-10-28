import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EmailCampaignStatus, EmailRecipientStatus } from '@prisma/client';
import { EMAIL_PROVIDER } from '../email/email-provider';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../sales/audit.service';
import { CommunicationsService } from './communications.service';

describe('CommunicationsService delivery', () => {
  const campaign = {
    id: 'camp-1',
    studioId: 'studio-1',
    subject: 'Aviso',
    bodyText: 'Hola <script>',
    status: EmailCampaignStatus.SENDING,
    allMembers: false,
    recipientCount: 2,
    sentCount: 0,
    failedCount: 0,
    skippedCount: 0,
    confirmedAt: new Date(),
    completedAt: null,
    createdAt: new Date(),
  };
  const pending = {
    id: 'rec-pending',
    campaignId: 'camp-1',
    studioId: 'studio-1',
    userId: 'user-1',
    email: 'ada@ares.test',
    status: EmailRecipientStatus.PENDING,
    error: null as string | null,
    claimedAt: null as Date | null,
    sentAt: null as Date | null,
    providerMessageId: null as string | null,
    createdAt: new Date('2026-10-28T00:00:00.000Z'),
  };
  const suppressedRecipient = {
    ...pending,
    id: 'rec-suppressed',
    userId: 'user-2',
    email: 'gone@ares.test',
    createdAt: new Date('2026-10-28T00:00:01.000Z'),
  };

  let service: CommunicationsService;
  let send: jest.Mock;
  let recipients: Array<typeof pending>;

  beforeEach(async () => {
    recipients = [
      { ...pending },
      { ...suppressedRecipient },
    ];
    send = jest.fn().mockResolvedValue({ providerMessageId: 'msg-1', delivered: true });
    const prisma = {
      emailCampaignRecipient: {
        findFirst: jest.fn(async ({ where }: { where: { status: string } }) =>
          recipients.find((row) => row.campaignId === 'camp-1' && row.status === where.status) ?? null,
        ),
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
          const row = recipients.find((item) => item.id === where.id);
          return row ? { ...row, campaign: { ...campaign }, user: { firstName: 'Ada', lastName: 'Lovelace' } } : null;
        }),
        updateMany: jest.fn(async ({ where, data }: { where: { id?: string; status?: string }; data: Partial<typeof pending> }) => {
          const row = recipients.find((item) => item.id === where.id && item.status === where.status);
          if (!row) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }),
        update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<typeof pending> }) => {
          const row = recipients.find((item) => item.id === where.id);
          if (row) Object.assign(row, data);
          return row;
        }),
        groupBy: jest.fn(async () => {
          const counts = new Map<string, number>();
          for (const row of recipients) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
          return [...counts.entries()].map(([status, count]) => ({ status, _count: { _all: count } }));
        }),
      },
      emailCampaign: {
        update: jest.fn(async ({ data }: { data: Partial<typeof campaign> }) => Object.assign(campaign, data)),
      },
      emailSuppression: {
        findUnique: jest.fn(async ({ where }: { where: { studioId_email: { email: string } } }) =>
          where.studioId_email.email === 'gone@ares.test' ? { reason: 'UNSUBSCRIBE' } : null,
        ),
      },
      studio: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'studio-1', slug: 'ares', name: 'ARES', appName: 'ARES', appDisplayName: 'ARES',
          brandPrimaryColor: null, primaryColor: null, brandLogoUrl: null, logoUrl: null,
          supportEmail: 'desk@ares.test', supportPhone: null,
        }),
      },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        CommunicationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: (_key: string, fallback?: string) => fallback ?? '', getOrThrow: () => 'secret' } },
        { provide: EMAIL_PROVIDER, useValue: { send } },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(CommunicationsService);
  });

  it('sends once with an idempotency key and skips a suppressed address', async () => {
    await service.deliver('camp-1', { maxSends: 5 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual(expect.objectContaining({
      to: 'ada@ares.test',
      idempotencyKey: 'campaign-recipient:rec-pending',
    }));
    expect(send.mock.calls[0][0].html).toContain('&lt;script&gt;');
    expect(send.mock.calls[0][0].html).not.toContain('<script>');
    expect(recipients.find((row) => row.id === 'rec-pending')?.status).toBe(EmailRecipientStatus.SENT);
    expect(recipients.find((row) => row.id === 'rec-suppressed')?.status).toBe(EmailRecipientStatus.SUPPRESSED);
    send.mockClear();
    await service.deliver('camp-1', { maxSends: 5 });
    expect(send).not.toHaveBeenCalled();
  });
});
