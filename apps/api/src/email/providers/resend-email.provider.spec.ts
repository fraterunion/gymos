import { ResendEmailProvider } from './resend-email.provider';

describe('ResendEmailProvider request', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('sends the From display name, Reply-To, unsubscribe headers and idempotency key exactly', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'resend-msg-1' }) });
    global.fetch = fetchMock as unknown as typeof fetch;
    const provider = new ResendEmailProvider({ apiKey: 're_test_key', endpoint: 'https://resend.invalid/emails' });
    const result = await provider.send({
      to: 'member@example.test',
      from: { email: 'fernando@arestrainingclub.com', name: 'ARES Training Club' },
      replyTo: 'fernando@arestrainingclub.com',
      subject: 'Aviso',
      html: '<p>Hola</p>',
      text: 'Hola',
      idempotencyKey: 'campaign-recipient:rec-1',
      headers: { 'List-Unsubscribe': '<https://api.example.test/u?token=t>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      tags: { type: 'campaign' },
    });
    expect(result).toEqual({ providerMessageId: 'resend-msg-1', delivered: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('https://resend.invalid/emails');
    expect(init.headers['Idempotency-Key']).toBe('campaign-recipient:rec-1');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body['from']).toBe('ARES Training Club <fernando@arestrainingclub.com>');
    expect(body['reply_to']).toBe('fernando@arestrainingclub.com');
    expect(body['to']).toEqual(['member@example.test']);
    expect(body['headers']).toEqual({
      'List-Unsubscribe': '<https://api.example.test/u?token=t>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('omits reply_to when none is given and surfaces provider errors', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'domain is not verified' });
    global.fetch = fetchMock as unknown as typeof fetch;
    const provider = new ResendEmailProvider({ apiKey: 're_test_key', endpoint: 'https://resend.invalid/emails' });
    await expect(
      provider.send({ to: 'a@example.test', from: { email: 'no-reply@example.test' }, subject: 's', html: 'h', text: 't' }),
    ).rejects.toThrow('Resend responded 403: domain is not verified');
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as Record<string, unknown>;
    expect(body['from']).toBe('no-reply@example.test');
    expect(body).not.toHaveProperty('reply_to');
  });
});
