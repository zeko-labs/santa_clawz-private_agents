import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface CipherEnvelope {
  cipherTextBase64: string;
  ivBase64: string;
  authTagBase64: string;
}

export function randomKey(bytes = 32): Buffer {
  return randomBytes(bytes);
}

export function sealBytes(plainText: Buffer, key: Buffer): CipherEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const cipherText = Buffer.concat([cipher.update(plainText), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    cipherTextBase64: cipherText.toString("base64"),
    ivBase64: iv.toString("base64"),
    authTagBase64: authTag.toString("base64")
  };
}

export function openBytes(envelope: CipherEnvelope, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.ivBase64, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.authTagBase64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.cipherTextBase64, "base64")),
    decipher.final()
  ]);
}
