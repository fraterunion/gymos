import type { WalletPassBranding } from '../wallet-pass-branding.resolver';

export type GenericClassInput = {
  classId: string;
  issuerName: string;
};

/** One class per studio — shared template every member's object references. */
export function buildGenericClass(input: GenericClassInput): Record<string, unknown> {
  return {
    id: input.classId,
    issuerName: input.issuerName,
    reviewStatus: 'UNDER_REVIEW',
  };
}

export type GenericObjectInput = {
  objectId: string;
  classId: string;
  memberName: string;
  planName: string | null;
  barcodeMessage: string;
  branding: WalletPassBranding;
};

/** One object per WalletCredential — the member's actual pass instance. */
export function buildGenericObject(input: GenericObjectInput): Record<string, unknown> {
  const textModulesData = [
    { id: 'disclaimer', header: 'ACCESO', body: 'El acceso se confirma en recepción.' },
  ];

  return {
    id: input.objectId,
    classId: input.classId,
    state: 'ACTIVE',
    cardTitle: { defaultValue: { language: 'es', value: input.branding.organizationName } },
    header: { defaultValue: { language: 'es', value: input.memberName } },
    ...(input.planName
      ? { subheader: { defaultValue: { language: 'es', value: input.planName } } }
      : {}),
    barcode: { type: 'QR_CODE', value: input.barcodeMessage },
    hexBackgroundColor: input.branding.backgroundColorHex,
    textModulesData,
  };
}

export type SaveJwtPayload = {
  iss: string;
  aud: 'google';
  typ: 'savetowallet';
  iat: number;
  payload: { genericObjects: Array<{ id: string }> };
};

export function buildSaveJwtPayload(serviceAccountEmail: string, objectId: string): SaveJwtPayload {
  return {
    iss: serviceAccountEmail,
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor(Date.now() / 1000),
    payload: { genericObjects: [{ id: objectId }] },
  };
}

export function buildClassId(issuerId: string, studioId: string): string {
  return `${issuerId}.studio_${studioId}`;
}

export function buildObjectId(issuerId: string, walletCredentialId: string): string {
  return `${issuerId}.credential_${walletCredentialId}`;
}
