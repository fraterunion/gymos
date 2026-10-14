import JSZip from 'jszip';

/** Bounds what we are willing to parse out of a stored artifact (ours are ~10–60 KB). */
const MAX_PKPASS_BYTES = 2 * 1024 * 1024;
const MAX_PASS_JSON_BYTES = 256 * 1024;

/**
 * Reads pass.json back out of a previously-signed .pkpass. Throws on any malformed or
 * unexpected structure rather than returning a partial/guessed value — a corrupt stored
 * artifact must fail closed, not silently recover something wrong.
 */
export async function extractPassJsonFromPkpass(pkpassData: Buffer): Promise<Record<string, unknown>> {
  if (pkpassData.length > MAX_PKPASS_BYTES) {
    throw new Error('pkpass artifact too large');
  }
  const zip = await JSZip.loadAsync(pkpassData);
  const passJsonFile = zip.file('pass.json');
  if (!passJsonFile) {
    throw new Error('pkpass artifact missing pass.json');
  }
  const passJsonRaw = await passJsonFile.async('string');
  if (passJsonRaw.length > MAX_PASS_JSON_BYTES) {
    throw new Error('pkpass artifact pass.json too large');
  }
  const parsed: unknown = JSON.parse(passJsonRaw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('pkpass artifact pass.json is not an object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * The inverse of pkpass-builder.ts's barcode embedding — returns the exact string embedded in
 * pass.json's barcodes[0].message (the full "gymos:v1:<raw>" value, unmodified). Used only for
 * artifact-backed credential recovery (Phase 3.2); the caller is responsible for verifying the
 * returned value against the credential before trusting it — this function only extracts, it
 * never validates ownership or credential status.
 */
export async function extractBarcodeMessageFromPkpass(pkpassData: Buffer): Promise<string> {
  const passJson = (await extractPassJsonFromPkpass(pkpassData)) as { barcodes?: Array<{ message?: unknown }> };
  const message = passJson.barcodes?.[0]?.message;
  if (typeof message !== 'string' || message.length === 0) {
    throw new Error('pkpass artifact has no barcode message');
  }
  return message;
}

/**
 * The PassKit authenticationToken embedded in a dynamic pass, or null when the pass has none
 * (every static pass). The caller verifies it against the stored hash before reusing it.
 */
export async function extractAuthenticationTokenFromPkpass(pkpassData: Buffer): Promise<string | null> {
  const passJson = await extractPassJsonFromPkpass(pkpassData);
  const token = passJson['authenticationToken'];
  return typeof token === 'string' && token.length > 0 ? token : null;
}
