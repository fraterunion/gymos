import { APPLE_BRAND_IMAGE_FILES, loadAppleBrandImages } from './wallet-brand-assets';

/** Minimal PNG IHDR reader — enough to assert Apple's dimension rules without an image lib. */
function pngSize(buffer: Buffer): { width: number; height: number } {
  expect(buffer.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(buffer.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

describe('loadAppleBrandImages', () => {
  it('returns null for a studio with no checked-in artwork rather than throwing', () => {
    expect(loadAppleBrandImages('a-studio-with-no-assets')).toBeNull();
  });

  it('refuses slugs that could escape the asset root', () => {
    expect(loadAppleBrandImages('../../../etc')).toBeNull();
    expect(loadAppleBrandImages('')).toBeNull();
    expect(loadAppleBrandImages(null)).toBeNull();
  });

  describe('ares-fitness', () => {
    const images = loadAppleBrandImages('ares-fitness');

    it('ships every image Apple expects for a generic pass', () => {
      expect(images).not.toBeNull();
      expect(Object.keys(images!).sort()).toEqual([...APPLE_BRAND_IMAGE_FILES].sort());
    });

    it('sizes the icon at Apple\'s 29pt, with exact @2x/@3x multiples', () => {
      expect(pngSize(images!['icon.png'])).toEqual({ width: 29, height: 29 });
      expect(pngSize(images!['icon@2x.png'])).toEqual({ width: 58, height: 58 });
      expect(pngSize(images!['icon@3x.png'])).toEqual({ width: 87, height: 87 });
    });

    // Apple allots the logo 160x50pt in the pass's top-left corner and crops anything larger.
    it('fits the logo inside the 160x50pt budget, with exact @2x/@3x multiples', () => {
      const base = pngSize(images!['logo.png']);
      expect(base.width).toBeLessThanOrEqual(160);
      expect(base.height).toBeLessThanOrEqual(50);
      expect(pngSize(images!['logo@2x.png'])).toEqual({ width: base.width * 2, height: base.height * 2 });
      expect(pngSize(images!['logo@3x.png'])).toEqual({ width: base.width * 3, height: base.height * 3 });
    });

    it('keeps the wordmark aspect ratio of the canonical ARES source', () => {
      const { width, height } = pngSize(images!['logo.png']);
      // splash-wordmark.png is 1800x461; anything far from that ratio means a distorted logo.
      expect(width / height).toBeCloseTo(1800 / 461, 1);
    });
  });
});
