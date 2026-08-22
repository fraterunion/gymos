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
};

export type PassJson = {
  formatVersion: number;
  passTypeIdentifier: string;
  teamIdentifier: string;
  serialNumber: string;
  organizationName: string;
  description: string;
  generic: {
    primaryFields: Array<{ key: string; label: string; value: string }>;
    secondaryFields: Array<{ key: string; label: string; value: string }>;
    backFields: Array<{ key: string; label: string; value: string }>;
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
 */
export function buildPassJson(input: PkpassInput): PassJson {
  const backFields: PassJson['generic']['backFields'] = [
    { key: 'disclaimer', label: 'ACCESO', value: 'El acceso se confirma en recepción.' },
  ];
  if (input.supportEmail) {
    backFields.push({ key: 'support', label: 'SOPORTE', value: input.supportEmail });
  }
  if (input.termsUrl) {
    backFields.push({ key: 'terms', label: 'TÉRMINOS', value: input.termsUrl });
  }

  const secondaryFields: PassJson['generic']['secondaryFields'] = input.planName
    ? [{ key: 'plan', label: 'PLAN', value: input.planName }]
    : [];

  return {
    formatVersion: PASS_FORMAT_VERSION,
    passTypeIdentifier: input.passTypeIdentifier,
    teamIdentifier: input.teamIdentifier,
    serialNumber: input.serialNumber,
    organizationName: input.organizationName,
    description: `${input.organizationName} — Pase de miembro`,
    generic: {
      primaryFields: [{ key: 'name', label: 'MIEMBRO', value: input.memberName }],
      secondaryFields,
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
