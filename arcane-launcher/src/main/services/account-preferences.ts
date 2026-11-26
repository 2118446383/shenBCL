import { validateSkinPng } from './account';

export interface AccountPreferences {
  localSkin?: string;
}

const PNG_PREFIX = 'data:image/png;base64,';
const MAX_SKIN_DATA_LENGTH = 1_400_000;

/** Local JSON preferences are untrusted input; malformed fields must not prevent startup. */
export function sanitizeAccountPreferences(value: unknown): AccountPreferences {
  const preferences: AccountPreferences = {};
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return preferences;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return preferences;

    // Read only own data fields, without invoking accessors or trusting inherited values.
    const skin = Object.getOwnPropertyDescriptor(value, 'localSkin')?.value;
    if (typeof skin !== 'string' || skin.length > MAX_SKIN_DATA_LENGTH || !skin.startsWith(PNG_PREFIX)) return preferences;
    const encoded = skin.slice(PNG_PREFIX.length);
    if (!encoded.length || encoded.length % 4 !== 0 || !/^[A-Za-z\d+/]*={0,2}$/.test(encoded)) return preferences;
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) return preferences;
    try { validateSkinPng(bytes); preferences.localSkin = skin; }
    catch { /* Discard a corrupt local preview. */ }
  } catch { /* Unexpected object shapes, including proxy traps, are treated as empty preferences. */ }
  return preferences;
}
