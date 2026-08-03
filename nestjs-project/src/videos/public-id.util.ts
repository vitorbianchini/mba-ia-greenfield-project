import { randomBytes } from 'node:crypto';

export const PUBLIC_ID_LENGTH = 11;

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// 64 symbols fit exactly in 6 bits, so masking is uniform. A plain `byte % 64`
// would be uniform here too, but the mask keeps the property explicit and holds
// if the alphabet ever changes size.
const MASK = 0x3f;

export function generatePublicId(): string {
  const bytes = randomBytes(PUBLIC_ID_LENGTH);
  let id = '';
  for (const byte of bytes) {
    id += ALPHABET[byte & MASK];
  }
  return id;
}
