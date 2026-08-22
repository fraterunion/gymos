import { PASS_FORMAT_VERSION } from './apple-wallet.constants';

export type PkpassInput = {
  passTypeIdentifier: string;
  teamIdentifier: string;
  serialNumber: string;
  organizationName: string;
  memberName: string;
  planName: string | null;
  /** The full "gymos:v1:<raw>" value — never a bare userId/studioId/PII. */
  barcodeMessage: string;
  backgroundColorRgb: string;
  foregroundColorRgb: string;
  labelColorRgb: string;
  supportEmail: string | null;
  termsUrl: string | null;
  /** True when the bundle ships a real `logo.png`. Drives `logoText`: Wallet renders the two
   *  side by side, so a studio with brand artwork must not also repeat its name as text. */
  hasLogoImage: boolean;
};

type PassField = { key: string; label: string; value: string };

export type PassJson = {
  formatVersion: number;
  passTypeIdentifier: string;
  teamIdentifier: string;
  serialNumber: string;
  organizationName: string;
  description: string;
  logoText?: string;
  generic: {
    headerFields: PassField[];
    primaryFields: PassField[];
    secondaryFields: PassField[];
    backFields: PassField[];
  };
  barcodes: Array<{ format: string; message: string; messageEncoding: string }>;
  backgroundColor: string;
  foregroundColor: string;
  labelColor: string;
};

/**
 * Pure — no signing, no I/O. Deliberately omits webServiceURL/authenticationToken
 * (Option A+: static pass, no APNs) and locations/beacons (no relevance features this
 * phase). The pass never claims current access — see the disclaimer backField.
 *
 * Field placement is driven by what iOS Wallet keeps visible while the pass sits COLLAPSED
 * beneath another card in the stack: only the logo (image or `logoText`) and the header
 * fields. Everything else — primary, secondary, back — is revealed just on tap. The plan
 * therefore lives in `headerFields` rather than `secondaryFields`, so a member glancing at a
 * stacked Wallet sees the club and their membership tier without opening anything.
 */
export function buildPassJson(input: PkpassInput): PassJson {
  const backFields: PassField[] = [
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

  // A member with no active plan keeps a fully valid identity credential — the header simply
  // carries nothing rather than asserting a status the membership data doesn't support.
  const headerFields: PassField[] = input.planName
    ? [{ key: 'plan', label: 'PLAN', value: input.planName }]
    : [];

  return {
    formatVersion: PASS_FORMAT_VERSION,
    passTypeIdentifier: input.passTypeIdentifier,
    teamIdentifier: input.teamIdentifier,
    serialNumber: input.serialNumber,
    organizationName: input.organizationName,
    description: `${input.organizationName} — Pase de miembro`,
    ...(input.hasLogoImage ? {} : { logoText: input.organizationName }),
    generic: {
      headerFields,
      primaryFields: [{ key: 'name', label: 'MIEMBRO', value: input.memberName }],
      secondaryFields: [],
      backFields,
    },
    barcodes: [{ format: 'PKBarcodeFormatQR', message: input.barcodeMessage, messageEncoding: 'iso-8859-1' }],
    backgroundColor: input.backgroundColorRgb,
    foregroundColor: input.foregroundColorRgb,
    labelColor: input.labelColorRgb,
  };
}

/** "rgb(10,10,10)" -> [10,10,10]. Throws on anything else — branding always produces this exact shape. */
export function parseRgbFunction(rgbFn: string): [number, number, number] {
  const match = /^rgb\((\d{1,3}),(\d{1,3}),(\d{1,3})\)$/.exec(rgbFn.trim());
  if (!match) {
    throw new Error(`Invalid rgb() function: ${rgbFn}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
