import assert from 'node:assert/strict';
import test from 'node:test';
import { createFieldEncryption } from '../src/db/encryption-core.js';

const oldKey = Buffer.alloc(32, 1).toString('base64');
const newKey = Buffer.alloc(32, 2).toString('base64');
const context = 'payroll_records:record-1:netPay';

test('encrypts and decrypts text and bytes with authenticated context', () => {
  const encryption = createFieldEncryption({
    activeKeyId: 'old',
    keys: { old: oldKey },
  });
  const encrypted = encryption.encryptText('₹12,345.67', context);
  assert.notEqual(encrypted, '₹12,345.67');
  assert.equal(encryption.decryptText(encrypted, context), '₹12,345.67');

  const bytes = Buffer.from([0, 1, 2, 255]);
  assert.deepEqual(
    encryption.decryptBytes(encryption.encryptBytes(bytes, 'documents:employee-1:government_id'), 'documents:employee-1:government_id'),
    bytes,
  );
});

test('uses unique nonces and rejects tampering or a mismatched field context', () => {
  const encryption = createFieldEncryption({
    activeKeyId: 'old',
    keys: { old: oldKey },
  });
  const first = encryption.encryptText('50000', context);
  const second = encryption.encryptText('50000', context);
  assert.notEqual(first, second);
  assert.throws(() => encryption.decryptText(first, 'payroll_records:record-2:netPay'));
  const tamperedParts = first.split(':');
  tamperedParts[4] = tamperedParts[4].startsWith('A') ? 'B' : 'A';
  assert.throws(() => encryption.decryptText(tamperedParts.join(':'), context));
});

test('re-encrypts old key versions and is idempotent after rotation', () => {
  const oldEncryption = createFieldEncryption({
    activeKeyId: 'old',
    keys: { old: oldKey },
  });
  const newEncryption = createFieldEncryption({
    activeKeyId: 'new',
    keys: { old: oldKey, new: newKey },
  });
  const oldValue = oldEncryption.encryptText('account-value', context);
  const rotatedValue = newEncryption.ensureEncryptedText(oldValue, context);
  assert.notEqual(rotatedValue, oldValue);
  assert.equal(newEncryption.decryptText(rotatedValue, context), 'account-value');
  assert.equal(newEncryption.ensureEncryptedText(rotatedValue, context), rotatedValue);
  assert.equal(newEncryption.decryptText(newEncryption.ensureEncryptedText('legacy-value', context), context), 'legacy-value');
});
