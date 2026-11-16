import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface FieldEncryptionKeyring {
  activeKeyId: string;
  keys: Record<string, string>;
}

interface Envelope {
  keyId: string;
  nonce: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

const envelopePrefix = 'enc:v1:';

function parseEnvelope(value: string): Envelope {
  const parts = value.split(':');
  if (parts.length !== 6 || parts[0] !== 'enc' || parts[1] !== 'v1') {
    throw new Error('Unsupported or malformed encrypted field value.');
  }

  const [, , keyId, nonceValue, authTagValue, ciphertextValue] = parts;
  if (!keyId || !/^[A-Za-z0-9_-]+$/.test(keyId)) {
    throw new Error('Encrypted field has an invalid key identifier.');
  }

  const nonce = Buffer.from(nonceValue, 'base64url');
  const authTag = Buffer.from(authTagValue, 'base64url');
  const ciphertext = Buffer.from(ciphertextValue, 'base64url');
  if (
    nonce.length !== 12
    || authTag.length !== 16
    || nonce.toString('base64url') !== nonceValue
    || authTag.toString('base64url') !== authTagValue
    || ciphertext.toString('base64url') !== ciphertextValue
  ) {
    throw new Error('Encrypted field has invalid encoding.');
  }

  return { keyId, nonce, authTag, ciphertext };
}

export function createFieldEncryption(keyring: FieldEncryptionKeyring) {
  const keys = new Map(Object.entries(keyring.keys).map(([id, value]) => [id, Buffer.from(value, 'base64')]));
  if ([...keys.values()].some(key => key.length !== 32)) {
    throw new Error('Every field-encryption key must be 32 bytes.');
  }
  const activeKey = Buffer.from(keys.get(keyring.activeKeyId) ?? []);
  if (activeKey.length !== 32) {
    throw new Error('The active field-encryption key must be a configured 32-byte key.');
  }

  function encrypt(plaintext: Buffer, context: string): string {
    if (!context) throw new Error('An encryption context is required.');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', activeKey, nonce);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [
      'enc',
      'v1',
      keyring.activeKeyId,
      nonce.toString('base64url'),
      authTag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join(':');
  }

  function decrypt(value: string, context: string): Buffer {
    if (!context) throw new Error('A decryption context is required.');
    const envelope = parseEnvelope(value);
    const key = keys.get(envelope.keyId);
    if (!key) throw new Error(`No field-encryption key is configured for key ID "${envelope.keyId}".`);

    const decipher = createDecipheriv('aes-256-gcm', key, envelope.nonce);
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(envelope.authTag);
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
  }

  function encryptText(value: string, context: string): string {
    return encrypt(Buffer.from(value, 'utf8'), context);
  }

  function decryptText(value: string, context: string): string {
    if (!value.startsWith(envelopePrefix)) {
      throw new Error('Refusing to decrypt a field that is not encrypted.');
    }
    return decrypt(value, context).toString('utf8');
  }

  function encryptBytes(value: Buffer, context: string): Buffer {
    return Buffer.from(encrypt(value, context), 'utf8');
  }

  function decryptBytes(value: Buffer, context: string): Buffer {
    const stored = value.toString('utf8');
    if (!stored.startsWith(envelopePrefix)) {
      throw new Error('Refusing to decrypt a field that is not encrypted.');
    }
    return decrypt(stored, context);
  }

  function ensureEncryptedText(value: string, context: string): string {
    if (!value.startsWith('enc:')) return encryptText(value, context);
    const plaintext = decryptText(value, context);
    return parseEnvelope(value).keyId === keyring.activeKeyId
      ? value
      : encryptText(plaintext, context);
  }

  function ensureEncryptedBytes(value: Buffer, context: string): Buffer {
    const stored = value.toString('utf8');
    if (!stored.startsWith('enc:')) return encryptBytes(value, context);
    const plaintext = decryptBytes(value, context);
    return parseEnvelope(stored).keyId === keyring.activeKeyId
      ? value
      : encryptBytes(plaintext, context);
  }

  return {
    activeKeyId: keyring.activeKeyId,
    encryptText,
    decryptText,
    encryptBytes,
    decryptBytes,
    ensureEncryptedText,
    ensureEncryptedBytes,
  };
}

export const employeeFieldContext = (employeeId: string, field: string) => `employees:${employeeId}:${field}`;
export const payrollFieldContext = (payrollRecordId: string, field: string) => `payroll_records:${payrollRecordId}:${field}`;
export const employeeDocumentContext = (employeeId: string, documentType: string) => (
  `employee_documents:${employeeId}:${documentType}:content`
);

export const payrollMoneyFields = [
  'basicSalaryMaster',
  'hraMaster',
  'specialAllowanceMaster',
  'bonusMaster',
  'basicSalary',
  'hra',
  'specialAllowance',
  'bonus',
  'providentFund',
  'professionalTax',
  'incomeTax',
  'totalEarnings',
  'totalDeductions',
  'netPay',
] as const;

export const payrollTextFields = [
  'bankName',
  'bankAccountNumber',
  'panNumber',
  'providentFundNumber',
  'providentFundUan',
  'otherDetails',
] as const;
