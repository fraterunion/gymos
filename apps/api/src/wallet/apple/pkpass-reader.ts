import JSZip from 'jszip';

/**
 * The inverse of pkpass-builder.ts's barcode embedding — reads a previously-signed .pkpass
 * bundle back out and returns the exact string embedded in pass.json's barcodes[0].message
 * (the full "gymos:v1:<raw>" value, unmodified — see buildPassJson). Used only for artifact-
 * backed credential recovery (Phase 3.2); the caller is responsible for verifying the
 * returned value against WalletCredentialService.resolve() before trusting it — this
 * function only extracts, it never validates ownership or credential status.
 *
 * Throws on any malformed/unexpected zip structure rather than returning a partial/guessed
 * value — a corrupt stored artifact must fail closed, not silently recover something wrong.
 */
export async function extractBarcodeMessageFromPkpass(pkpassData: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(pkpassData);
  const passJsonFile = zip.file('pass.json');
  if (!passJsonFile) {
    throw new Error('pkpass artifact missing pass.json');
  }
  const passJsonRaw = await passJsonFile.async('string');
  const passJson = JSON.parse(passJsonRaw) as { barcodes?: Array<{ message?: unknown }> };
  const message = passJson.barcodes?.[0]?.message;
  if (typeof message !== 'string' || message.length === 0) {
    throw new Error('pkpass artifact has no barcode message');
  }
  return message;
}
