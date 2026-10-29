import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EmailCampaignStatus, EmailRecipientStatus } from '@prisma/client';
import { EMAIL_PROVIDER } from '../email/email-provider';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../sales/audit.service';
import { CommunicationsService } from './communications.service';
import { recipientSnapshotFingerprint } from './campaign-recipients';
import { signUnsubscribeToken } from './unsubscribe-token';

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
  let configGet: jest.Mock;
  let campaignUpdate: jest.Mock;
  let findCampaign: jest.Mock;
  let audienceMembers: Array<{ user: { id: string; email: string; firstName: string; lastName: string } }>;
  let campaignCreate: jest.Mock;
  let storedRecipients: jest.Mock;

  beforeEach(async () => {
    recipients = [
      { ...pending },
      { ...suppressedRecipient },
    ];
    audienceMembers = [{ user: { id: 'user-1', email: 'ada@ares.test', firstName: 'Ada', lastName: 'Lovelace' } }];
    campaignCreate = jest.fn();
    storedRecipients = jest.fn().mockResolvedValue([{ userId: 'user-1', email: 'ada@ares.test' }]);
    send = jest.fn().mockResolvedValue({ providerMessageId: 'msg-1', delivered: true });
    configGet = jest.fn((key: string, fallback?: string) =>
      key === 'EMAIL_UNSUBSCRIBE_URL_BASE' ? 'https://api.ares.example.test' : fallback ?? '',
    );
    campaignUpdate = jest.fn(async ({ data }: { data: Partial<typeof campaign> }) => Object.assign(campaign, data));
    findCampaign = jest.fn().mockResolvedValue(null);
    const prisma = {
      emailCampaignRecipient: {
        findMany: storedRecipients,
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
      studioMembership: {
        findMany: jest.fn(async () => audienceMembers),
      },
      subscription: { findMany: jest.fn().mockResolvedValue([]) },
      emailCampaign: {
        create: campaignCreate,
        findUnique: findCampaign,
        findFirst: jest.fn().mockResolvedValue({ ...campaign, status: EmailCampaignStatus.DRAFT }),
        update: campaignUpdate,
      },
      emailSuppression: {
        findMany: jest.fn().mockResolvedValue([]),
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
        { provide: ConfigService, useValue: {
          get: configGet,
          getOrThrow: () => 'secret',
        } },
        { provide: EMAIL_PROVIDER, useValue: { send } },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(CommunicationsService);
  });

  it('refuses to confirm a marketing campaign without a real HTTPS unsubscribe origin', async () => {
    configGet.mockImplementation((_key: string, fallback?: string) => fallback ?? '');
    await expect(
      service.confirm('studio-1', 'camp-1', 'admin-1', { confirm: true }),
    ).rejects.toThrow('EMAIL_UNSUBSCRIBE_URL_BASE');
    expect(campaignUpdate).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses to confirm campaigns with localhost as unsubscribe origin', async () => {
    configGet.mockImplementation((key: string, fallback?: string) =>
      key === 'EMAIL_UNSUBSCRIBE_URL_BASE' ? 'http://localhost:3001' : fallback ?? '',
    );
    await expect(
      service.confirm('studio-1', 'camp-1', 'admin-1', { confirm: true }),
    ).rejects.toThrow('origen HTTPS público');
    expect(campaignUpdate).not.toHaveBeenCalled();
  });

  it('rejects reusing a campaign key for a different recipient selection', async () => {
    findCampaign.mockResolvedValue({
      ...campaign,
      filters: { planIds: ['basic'] },
      includeUserIds: [],
      excludeUserIds: [],
      allMembers: false,
    });
    await expect(service.create('studio-1', 'admin-1', {
      subject: 'Aviso',
      bodyText: 'Hola <script>',
      idempotencyKey: 'ares-campaign-0001',
      filters: { planIds: ['full'] },
    })).rejects.toThrow('selección de destinatarios');
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects an idempotent campaign replay when the stored snapshot differs', async () => {
    findCampaign.mockResolvedValue({
      ...campaign,
      filters: {},
      includeUserIds: [],
      excludeUserIds: [],
      allMembers: true,
      subject: 'Aviso',
      bodyText: 'Hola <script>',
    });
    await expect(service.create('studio-1', 'admin-1', {
      allMembers: true,
      subject: 'Aviso',
      bodyText: 'Hola <script>',
      idempotencyKey: 'ares-campaign-0001',
      previewFingerprint: recipientSnapshotFingerprint([
        { userId: 'different-user', email: 'different@ares.test' },
      ]),
    })).rejects.toThrow('otros destinatarios');
    expect(storedRecipients).toHaveBeenCalledWith(expect.objectContaining({
      where: { campaignId: 'camp-1' },
    }));
    expect(campaignCreate).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a changed recipient snapshot between preview and create without sending', async () => {
    const before = await service.preview('studio-1', { allMembers: true });
    expect(before.recipientCount).toBe(1);
    audienceMembers = [{ user: { id: 'user-2', email: 'different@ares.test', firstName: 'Grace', lastName: 'Hopper' } }];
    await expect(service.create('studio-1', 'admin-1', {
      allMembers: true,
      subject: 'Aviso',
      bodyText: 'Mensaje',
      idempotencyKey: 'preview-lock-test-1',
      previewFingerprint: before.previewFingerprint,
    })).rejects.toThrow('destinatarios cambiaron');
    expect(campaignCreate).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('validates unsubscribe token without writing suppression', () => {
    const token = signUnsubscribeToken({ studioId: 'studio-1', email: 'ada@ares.test' }, 'secret');
    expect(service.validateUnsubscribeToken(token)).toEqual({
      studioId: 'studio-1', email: 'ada@ares.test',
    });
    expect(() => service.validateUnsubscribeToken('garbage')).toThrow('enlace');
  });

  it('sends once with an idempotency key and skips a suppressed address', async () => {
    await service.deliver('camp-1', { maxSends: 5 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual(expect.objectContaining({
      to: 'ada@ares.test',
      idempotencyKey: 'campaign-recipient:rec-pending',
    }));
    expect(send.mock.calls[0][0].html).toContain('https://api.ares.example.test/api/v1/email/unsubscribe?token=');
    expect(send.mock.calls[0][0].html).not.toContain('localhost');
    expect(send.mock.calls[0][0].html).toContain('&lt;script&gt;');
    expect(send.mock.calls[0][0].html).not.toContain('<script>');
    expect(recipients.find((row) => row.id === 'rec-pending')?.status).toBe(EmailRecipientStatus.SENT);
    expect(recipients.find((row) => row.id === 'rec-suppressed')?.status).toBe(EmailRecipientStatus.SUPPRESSED);
    send.mockClear();
    await service.deliver('camp-1', { maxSends: 5 });
    expect(send).not.toHaveBeenCalled();
  });
});
