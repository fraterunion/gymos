/**
 * Campaign-only sender identity. Mass email from the Communications module may use a
 * studio-specific From / Reply-To — for ARES: "ARES Training Club <fernando@arestrainingclub.com>"
 * with replies going to Fernando — while transactional mail (password recovery and every other
 * platform email) keeps the platform sender (EMAIL_FROM_ADDRESS / EMAIL_FROM_NAME). Nothing here
 * is read by TransactionalEmailService.
 *
 * EMAIL_CAMPAIGN_SENDERS is a JSON object keyed by studio slug:
 *   {"ares-fitness":{"fromName":"ARES Training Club",
 *                    "fromAddress":"fernando@arestrainingclub.com",
 *                    "replyTo":"fernando@arestrainingclub.com"}}
 *
 * Fail closed. A studio listed with an invalid entry, or whose fromAddress is outside the
 * platform's verified sending domain (the domain of EMAIL_FROM_ADDRESS, already verified with the
 * provider for transactional mail), cannot confirm or send campaigns; unparseable JSON blocks every
 * studio. A studio that is not listed keeps the previous behaviour: platform address, studio
 * display name, studio support email as Reply-To.
 */

export type CampaignSender =
  | { kind: 'CONFIGURED'; from: { email: string; name: string }; replyTo: string }
  | { kind: 'PLATFORM_DEFAULT' }
  | { kind: 'INVALID'; error: string };

const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
// A display name ends up inside the From header: refuse anything that could break out of it.
const UNSAFE_NAME = /[<>"\r\n\\]/;

const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1).toLowerCase();

export function resolveCampaignSender(
  studioSlug: string,
  rawConfig: string | undefined | null,
  platformFromAddress: string,
): CampaignSender {
  const raw = (rawConfig ?? '').trim();
  if (!raw) return { kind: 'PLATFORM_DEFAULT' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'INVALID', error: 'EMAIL_CAMPAIGN_SENDERS no es un JSON válido.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'INVALID', error: 'EMAIL_CAMPAIGN_SENDERS debe ser un objeto por slug de estudio.' };
  }
  const entry = (parsed as Record<string, unknown>)[studioSlug];
  if (entry === undefined) return { kind: 'PLATFORM_DEFAULT' };
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { kind: 'INVALID', error: `Remitente de campañas inválido para ${studioSlug}.` };
  }
  const { fromName, fromAddress, replyTo } = entry as Record<string, unknown>;
  const name = typeof fromName === 'string' ? fromName.trim() : '';
  const address = typeof fromAddress === 'string' ? fromAddress.trim() : '';
  const reply = typeof replyTo === 'string' && replyTo.trim() ? replyTo.trim() : address;
  if (!name || name.length > 100 || UNSAFE_NAME.test(name)) {
    return { kind: 'INVALID', error: 'El nombre del remitente de campañas es inválido.' };
  }
  if (!EMAIL.test(address) || !EMAIL.test(reply)) {
    return { kind: 'INVALID', error: 'La dirección del remitente o de respuesta de campañas es inválida.' };
  }
  const verifiedDomain = EMAIL.test(platformFromAddress) ? domainOf(platformFromAddress) : '';
  if (!verifiedDomain || domainOf(address) !== verifiedDomain) {
    return {
      kind: 'INVALID',
      error: `El remitente de campañas debe usar el dominio verificado de envío (${verifiedDomain || 'sin configurar'}).`,
    };
  }
  return { kind: 'CONFIGURED', from: { email: address, name }, replyTo: reply };
}
