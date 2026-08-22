import * as forge from 'node-forge';

export type ApplePassCertificate = {
  cert: forge.pki.Certificate;
  privateKey: forge.pki.PrivateKey;
};

/** Extracts the leaf certificate + private key from a Pass Type ID .p12 (base64-encoded DER). */
export function loadP12(p12Base64: string, password: string): ApplePassCertificate {
  const p12Der = forge.util.decode64(p12Base64);
  const p12Asn1 = forge.asn1.fromDer(p12Der);
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag as string });
  const certBag = certBags[forge.pki.oids.certBag as string]?.[0];
  if (!certBag?.cert) {
    throw new Error('Pass Type ID certificate not found in .p12');
  }

  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag as string });
  const keyBag = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag as string]?.[0];
  if (!keyBag?.key) {
    throw new Error('Private key not found in .p12');
  }

  return { cert: certBag.cert, privateKey: keyBag.key };
}

/**
 * Detached PKCS#7 signature over manifest.json's exact bytes, chained through the Apple
 * WWDR intermediate certificate — the signature Wallet apps verify before trusting a pass.
 */
export function signManifest(
  manifest: Buffer,
  certificate: ApplePassCertificate,
  wwdrPem: string,
): Buffer {
  const wwdrCert = forge.pki.certificateFromPem(wwdrPem);

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(manifest.toString('binary'));
  p7.addCertificate(certificate.cert);
  p7.addCertificate(wwdrCert);
  p7.addSigner({
    // @types/node-forge declares two structurally-identical-but-nominally-distinct
    // PrivateKey types across its pki/pkcs7 typings; the cast is a typing-only workaround,
    // not a behavior change — forge accepts the actual key object at runtime regardless.
    key: certificate.privateKey as unknown as string,
    certificate: certificate.cert,
    digestAlgorithm: forge.pki.oids.sha256 as string,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType as string, value: forge.pki.oids.data as string },
      { type: forge.pki.oids.messageDigest as string },
      { type: forge.pki.oids.signingTime as string, value: new Date().toISOString() as never },
    ],
  });
  p7.sign({ detached: true });

  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return Buffer.from(der, 'binary');
}
