/** `Acore::Crypto::AES` (AES-128-GCM, 12 byte IV, 12 byte tag) with the `AEEncryptWithRandomIV` / `AEDecrypt` layout: data ‖ IV ‖ tag. */
export const IV_SIZE_BYTES = 12;
export const KEY_SIZE_BYTES = 16;
export const TAG_SIZE_BYTES = 12;

function buffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes);
}

async function importKey(key: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", buffer(key), "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** @ac common/Cryptography/CryptoGenerics.h Acore::Crypto::AEEncryptWithRandomIV */
export async function AEEncryptWithRandomIV(data: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_SIZE_BYTES));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: TAG_SIZE_BYTES * 8 }, await importKey(key), buffer(data)));
  const cipher = sealed.subarray(0, sealed.length - TAG_SIZE_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_SIZE_BYTES);
  const out = new Uint8Array(cipher.length + IV_SIZE_BYTES + TAG_SIZE_BYTES);
  out.set(cipher, 0);
  out.set(iv, cipher.length);
  out.set(tag, cipher.length + IV_SIZE_BYTES);
  return out;
}

/** @ac common/Cryptography/CryptoGenerics.h Acore::Crypto::AEDecrypt */
export async function AEDecrypt(data: Uint8Array, key: Uint8Array): Promise<Uint8Array | null> {
  if (data.length < IV_SIZE_BYTES + TAG_SIZE_BYTES) return null;
  const cipher = data.subarray(0, data.length - IV_SIZE_BYTES - TAG_SIZE_BYTES);
  const iv = data.subarray(cipher.length, cipher.length + IV_SIZE_BYTES);
  const tag = data.subarray(cipher.length + IV_SIZE_BYTES);
  const sealed = new Uint8Array(cipher.length + TAG_SIZE_BYTES);
  sealed.set(cipher, 0);
  sealed.set(tag, cipher.length);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buffer(iv), tagLength: TAG_SIZE_BYTES * 8 }, await importKey(key), sealed));
  } catch {
    return null;
  }
}
