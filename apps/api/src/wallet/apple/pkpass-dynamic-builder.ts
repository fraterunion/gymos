import { createHash } from 'node:crypto';
import type { WalletPassDisplay, WalletPassDisplayField } from '../access/wallet-access-display';
import { PASS_FORMAT_VERSION } from './apple-wallet.constants';

export type DynamicPkpassInput = {
  passTypeIdentifier: string;
  teamIdentifier: string;
  /** Same serial as the member's static pass (the WalletCredential id): same Wallet identity. */
  serialNumber: string;
  organizationName: string;
  memberName: string;
  /** The full "gymos:v1:<raw>" value — byte-identical to the static pass's barcode. */
  barcodeMessage: string;
  backgroundColorRgb: string;
  foregroundColorRgb: string;
  labelColorRgb: string;
  supportEmail: string | null;
  termsUrl: string | null;
  hasLogoImage: boolean;
  /** HTTPS base URL of the PassKit web service (Wallet appends /v1/...). */
  webServiceURL: string;
  /** Per-pass secret; never changes for the life of the pass. */
  authenticationToken: string;
  display: WalletPassDisplay;
};

type PassField = { key: string; label: string; value: string };

export type DynamicPassJson = {
  formatVersion: number;
  passTypeIdentifier: string;
  teamIdentifier: string;
  serialNumber: string;
  organizationName: string;
  description: string;
  logoText?: string;
  webServiceURL: string;
  authenticationToken: string;
  voided?: true;
  generic: {
    headerFields: PassField[];
    primaryFields: PassField[];
    secondaryFields: PassField[];
    auxiliaryFields: PassField[];
    backFields: PassField[];
  };
  barcodes: Array<{ format: string; message: string; messageEncoding: string }>;
  backgroundColor: string;
  foregroundColor: string;
  labelColor: string;
};

function field(f: WalletPassDisplayField): PassField {
  return { key: f.key, label: f.label, value: f.value };
}

/**
 * Pure. A dynamic pass is the static pass plus a PassKit web service and a state display:
 *
 * - SAME serialNumber and SAME barcode as the static pass — the identity and the QR the front
 *   desk scans never change; only the informational fields do.
 * - The header (the only part visible while the card is stacked) carries the membership STATE
 *   ("VIGENTE", "VENCIDA", ...), never "ACCESO": access is decided at the desk.
 * - `voided` is set only when the display says so (a revoked credential). A lapsed membership
 *   leaves the pass un-voided: it is still the member's identity at the desk.
 * - No expirationDate / relevantDate / locations: nothing makes Wallet hide or surface the pass
 *   by time or place in this stage.
 * - No changeMessage: content updates are silent (no lock-screen notification) in this stage.
 *
 * Field budget for a generic pass with a square (QR) barcode: secondary + auxiliary <= 4.
 */
export function buildDynamicPassJson(input: DynamicPkpassInput): DynamicPassJson {
  const { display } = input;

  const backFields: PassField[] = [
    ...display.details.map(field),
    {
      key: 'about',
      label: 'MEMBRESÍA',
      value: `Este pase identifica tu membresía en ${input.organizationName}.`,
    },
    { key: 'disclaimer', label: 'ACCESO', value: 'El acceso se confirma en recepción.' },
  ];
  if (input.supportEmail) {
    backFields.push({ key: 'support', label: 'SOPORTE', value: input.supportEmail });
  }
  if (input.termsUrl) {
    backFields.push({ key: 'terms', label: 'TÉRMINOS', value: input.termsUrl });
  }

  const secondaryFields = [display.plan, display.validity].filter((f): f is WalletPassDisplayField => f !== null).map(field);
  const auxiliaryFields = display.scope ? [field(display.scope)] : [];

  return {
    formatVersion: PASS_FORMAT_VERSION,
    passTypeIdentifier: input.passTypeIdentifier,
    teamIdentifier: input.teamIdentifier,
    serialNumber: input.serialNumber,
    organizationName: input.organizationName,
    description: `${input.organizationName} — Pase de miembro`,
    ...(input.hasLogoImage ? {} : { logoText: input.organizationName }),
    webServiceURL: input.webServiceURL,
    authenticationToken: input.authenticationToken,
    ...(display.voided ? { voided: true as const } : {}),
    generic: {
      headerFields: [field(display.status)],
      primaryFields: [{ key: 'name', label: 'MIEMBRO', value: input.memberName }],
      secondaryFields,
      auxiliaryFields,
      backFields,
    },
    barcodes: [{ format: 'PKBarcodeFormatQR', message: input.barcodeMessage, messageEncoding: 'iso-8859-1' }],
    backgroundColor: input.backgroundColorRgb,
    foregroundColor: input.foregroundColorRgb,
    labelColor: input.labelColorRgb,
  };
}

/**
 * Deterministic content identity of a pass bundle: pass.json bytes plus every packaged asset,
 * by name. Two builds with equal hashes present identically on the device, regardless of the
 * (time-stamped, therefore never byte-identical) PKCS#7 signature. Used to decide whether a
 * rebuild is a real change that deserves a new version and a push.
 */
export function computePassContentHash(passJson: Buffer, images: Record<string, Buffer>): string {
  const hash = createHash('sha256');
  hash.update('pass.json\u0000').update(passJson);
  for (const name of Object.keys(images).sort()) {
    hash.update(`\u0000${name}\u0000`).update(images[name]!);
  }
  return hash.digest('hex');
}
