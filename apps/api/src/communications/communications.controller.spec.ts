import type { Request, Response } from 'express';
import { CommunicationsService } from './communications.service';
import { EmailUnsubscribeController } from './communications.controller';

describe('EmailUnsubscribeController (scanner-safe)', () => {
  const validateUnsubscribeToken = jest.fn();
  const unsubscribe = jest.fn().mockResolvedValue({ ok: true });
  const controller = new EmailUnsubscribeController({
    validateUnsubscribeToken,
    unsubscribe,
  } as unknown as CommunicationsService);

  const response = () => {
    const res = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      type: jest.fn().mockReturnThis(),
    };
    return res;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET renders a confirmation page and never records suppression', () => {
    const res = response();
    controller.unsubscribeGet('signed.token', res as unknown as Response);
    expect(validateUnsubscribeToken).toHaveBeenCalledWith('signed.token');
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    const html = res.send.mock.calls[0][0] as string;
    expect(html).toContain('method="POST"');
    expect(html).toContain('Confirmar baja');
    expect(html).not.toContain('Baja confirmada');
  });

  it('invalid GET token is rejected before the confirmation screen', () => {
    validateUnsubscribeToken.mockImplementationOnce(() => {
      throw new Error('invalid token');
    });
    const res = response();
    expect(() => controller.unsubscribeGet('bad', res as unknown as Response)).toThrow('invalid token');
    expect(res.send).not.toHaveBeenCalled();
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it('one-click POST suppresses once and returns JSON', async () => {
    const res = response();
    await controller.unsubscribePost(
      'signed.token', undefined,
      { headers: { accept: '*/*' } } as Request,
      res as unknown as Response,
    );
    expect(unsubscribe).toHaveBeenCalledWith('signed.token');
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('browser form POST confirms the action with a readable page', async () => {
    const res = response();
    await controller.unsubscribePost(
      'signed.token', undefined,
      { headers: { accept: 'text/html,application/xhtml+xml' } } as Request,
      res as unknown as Response,
    );
    expect(unsubscribe).toHaveBeenCalledWith('signed.token');
    expect(res.type).toHaveBeenCalledWith('html');
    expect(res.send.mock.calls[0][0]).toContain('Baja confirmada');
  });
});
