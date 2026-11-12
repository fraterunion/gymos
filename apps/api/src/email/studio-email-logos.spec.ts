import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { studioEmailLogo } from './studio-email-logos';

/** Width and height from a PNG's IHDR chunk. */
function pngSize(path: string): { width: number; height: number } {
  const png = readFileSync(path);
  expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe('studio email logos', () => {
  it('serves the ARES wordmark over HTTPS from the public site, sized like the checked-in file', () => {
    const logo = studioEmailLogo('ares-fitness');
    expect(logo).not.toBeNull();
    const url = new URL(logo!.url);
    expect(url.protocol).toBe('https:');
    expect(url.host).toBe('www.arestrainingclub.com');
    expect(url.pathname).toBe('/ares-wordmark.png');
    const file = pngSize(join(__dirname, '../../../ares-site/public', url.pathname));
    expect({ width: logo!.width, height: logo!.height }).toEqual(file);
  });

  it('has no logo for any other studio, including prototype keys and empty slugs', () => {
    for (const slug of ['pilates-toluca', 'ares', 'constructor', '__proto__', '', null, undefined]) {
      expect(studioEmailLogo(slug)).toBeNull();
    }
  });
});
