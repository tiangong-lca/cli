import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimePackageRoot } from '../runtime/descriptor.js';

export function reportBrand(): { logo: string; cover: string } {
  const extension = path.extname(fileURLToPath(import.meta.url));
  const root = runtimePackageRoot(new URL(`../../runtime${extension}`, import.meta.url).href);
  const asset = (name: string, mime: string) =>
    `data:${mime};base64,${readFileSync(path.join(root, 'assets', 'report', name)).toString('base64')}`;
  return {
    logo: asset('tiangong-lca-logo.svg', 'image/svg+xml'),
    cover: asset('lifecycle-cover.webp', 'image/webp'),
  };
}
