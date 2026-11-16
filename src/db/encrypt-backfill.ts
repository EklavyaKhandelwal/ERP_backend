import { and, asc, eq, gt } from 'drizzle-orm';
import { db, pool } from './index.js';
import { employeeDocuments, employees, payrollRecordRevisions, payrollRecords } from './schema.js';
import {
  employeeDocumentContext,
  employeeFieldContext,
  payrollFieldContext,
  payrollMoneyFields,
  payrollTextFields,
} from './encryption-core.js';
import { decryptNumber, fieldEncryption } from './field-encryption.js';

const batchSize = 10;

async function backfillEmployees(): Promise<number> {
  let lastId: string | undefined;
  let processed = 0;
  while (true) {
    const rows = await db.select({
      id: employees.id,
      salary: employees.salary,
      bankName: employees.bankName,
      bankAccountNumber: employees.bankAccountNumber,
    }).from(employees)
      .where(lastId ? gt(employees.id, lastId) : undefined)
      .orderBy(asc(employees.id))
      .limit(batchSize);
    if (!rows.length) return processed;

    await db.transaction(async tx => {
      for (const row of rows) {
        const updated = await tx.update(employees).set({
          salary: fieldEncryption.ensureEncryptedText(row.salary, employeeFieldContext(row.id, 'salary')),
          bankName: fieldEncryption.ensureEncryptedText(row.bankName, employeeFieldContext(row.id, 'bankName')),
          bankAccountNumber: fieldEncryption.ensureEncryptedText(
            row.bankAccountNumber,
            employeeFieldContext(row.id, 'bankAccountNumber'),
          ),
        }).where(and(
          eq(employees.id, row.id),
          eq(employees.salary, row.salary),
          eq(employees.bankName, row.bankName),
          eq(employees.bankAccountNumber, row.bankAccountNumber),
        )).returning({ id: employees.id });
        if (updated.length !== 1) {
          throw new Error(`Employee ${row.id} changed during encryption backfill; stop all writers and rerun it.`);
        }
      }
    });

    processed += rows.length;
    lastId = rows[rows.length - 1].id;
  }
}

async function backfillPayrollRecords(): Promise<number> {
  let lastId: string | undefined;
  let processed = 0;
  while (true) {
    const rows = await db.select().from(payrollRecords)
      .where(lastId ? gt(payrollRecords.id, lastId) : undefined)
      .orderBy(asc(payrollRecords.id))
      .limit(batchSize);
    if (!rows.length) return processed;

    await db.transaction(async tx => {
      for (const row of rows) {
        const amounts = Object.fromEntries(payrollMoneyFields.map(field => [
          field,
          fieldEncryption.ensureEncryptedText(row[field], payrollFieldContext(row.id, field)),
        ]));
        const textFields = Object.fromEntries(payrollTextFields.map(field => [
          field,
          fieldEncryption.ensureEncryptedText(row[field], payrollFieldContext(row.id, field)),
        ]));
        const updated = await tx.update(payrollRecords).set({
          ...amounts,
          ...textFields,
        }).where(and(
          eq(payrollRecords.id, row.id),
          ...payrollMoneyFields.map(field => eq(payrollRecords[field], row[field])),
          ...payrollTextFields.map(field => eq(payrollRecords[field], row[field])),
        )).returning({ id: payrollRecords.id });
        if (updated.length !== 1) {
          throw new Error(`Payroll record ${row.id} changed during encryption backfill; stop all writers and rerun it.`);
        }
      }
    });

    processed += rows.length;
    lastId = rows[rows.length - 1].id;
  }
}

async function backfillDocuments(): Promise<number> {
  let lastId: string | undefined;
  let processed = 0;
  while (true) {
    const rows = await db.select({
      id: employeeDocuments.id,
      employeeId: employeeDocuments.employeeId,
      documentType: employeeDocuments.documentType,
      content: employeeDocuments.content,
    }).from(employeeDocuments)
      .where(lastId ? gt(employeeDocuments.id, lastId) : undefined)
      .orderBy(asc(employeeDocuments.id))
      .limit(batchSize);
    if (!rows.length) return processed;

    await db.transaction(async tx => {
      for (const row of rows) {
        const updated = await tx.update(employeeDocuments).set({
          content: fieldEncryption.ensureEncryptedBytes(
            row.content,
            employeeDocumentContext(row.employeeId, row.documentType),
          ),
        }).where(and(
          eq(employeeDocuments.id, row.id),
          eq(employeeDocuments.employeeId, row.employeeId),
          eq(employeeDocuments.documentType, row.documentType),
          eq(employeeDocuments.content, row.content),
        )).returning({ id: employeeDocuments.id });
        if (updated.length !== 1) {
          throw new Error(`Employee document ${row.id} changed during encryption backfill; stop all writers and rerun it.`);
        }
      }
    });

    processed += rows.length;
    lastId = rows[rows.length - 1].id;
  }
}

async function backfillPayrollRevisions(): Promise<number> {
  let lastId: string | undefined;
  let processed = 0;
  while (true) {
    const rows = await db.select({
      id: payrollRecordRevisions.id,
      payrollRecordId: payrollRecordRevisions.payrollRecordId,
      snapshot: payrollRecordRevisions.snapshot,
    }).from(payrollRecordRevisions)
      .where(lastId ? gt(payrollRecordRevisions.id, lastId) : undefined)
      .orderBy(asc(payrollRecordRevisions.id))
      .limit(batchSize);
    if (!rows.length) return processed;

    await db.transaction(async tx => {
      for (const row of rows) {
        if (typeof row.snapshot !== 'object' || row.snapshot === null || Array.isArray(row.snapshot)) {
          throw new Error(`Payroll revision ${row.id} has an invalid snapshot.`);
        }
        const snapshot = { ...row.snapshot };
        for (const field of [...payrollMoneyFields, ...payrollTextFields]) {
          const value = snapshot[field];
          if (typeof value !== 'string' && typeof value !== 'number') {
            throw new Error(`Payroll revision ${row.id} is missing ${field}.`);
          }
          snapshot[field] = fieldEncryption.ensureEncryptedText(
            String(value),
            payrollFieldContext(row.payrollRecordId, field),
          );
        }
        const updated = await tx.update(payrollRecordRevisions).set({ snapshot })
          .where(and(
            eq(payrollRecordRevisions.id, row.id),
            eq(payrollRecordRevisions.payrollRecordId, row.payrollRecordId),
            eq(payrollRecordRevisions.snapshot, row.snapshot),
          )).returning({ id: payrollRecordRevisions.id });
        if (updated.length !== 1) {
          throw new Error(`Payroll revision ${row.id} changed during encryption backfill; stop all writers and rerun it.`);
        }
      }
    });

    processed += rows.length;
    lastId = rows[rows.length - 1].id;
  }
}

async function verifyEmployees(): Promise<number> {
  let lastId: string | undefined;
  let verified = 0;
  while (true) {
    const rows = await db.select({
      id: employees.id,
      salary: employees.salary,
      bankName: employees.bankName,
      bankAccountNumber: employees.bankAccountNumber,
    }).from(employees)
      .where(lastId ? gt(employees.id, lastId) : undefined)
      .orderBy(asc(employees.id))
      .limit(batchSize);
    if (!rows.length) return verified;
    for (const row of rows) {
      decryptNumber(row.salary, employeeFieldContext(row.id, 'salary'));
      fieldEncryption.decryptText(row.bankName, employeeFieldContext(row.id, 'bankName'));
      fieldEncryption.decryptText(
        row.bankAccountNumber,
        employeeFieldContext(row.id, 'bankAccountNumber'),
      );
    }
    verified += rows.length;
    lastId = rows[rows.length - 1].id;
  }
}

async function verifyPayrollRecords(): Promise<number> {
  let lastId: string | undefined;
  let verified = 0;
  while (true) {
    const rows = await db.select().from(payrollRecords)
      .where(lastId ? gt(payrollRecords.id, lastId) : undefined)
      .orderBy(asc(payrollRecords.id))
      .limit(batchSize);
    if (!rows.length) return verified;
    for (const row of rows) {
      for (const field of payrollMoneyFields) {
        decryptNumber(row[field], payrollFieldContext(row.id, field));
      }
      for (const field of payrollTextFields) {
        fieldEncryption.decryptText(row[field], payrollFieldContext(row.id, field));
      }
    }
    verified += rows.length;
    lastId = rows[rows.length - 1].id;
  }
}

async function verifyDocuments(): Promise<number> {
  let lastId: string | undefined;
  let verified = 0;
  while (true) {
    const rows = await db.select({
      id: employeeDocuments.id,
      employeeId: employeeDocuments.employeeId,
      documentType: employeeDocuments.documentType,
      content: employeeDocuments.content,
    }).from(employeeDocuments)
      .where(lastId ? gt(employeeDocuments.id, lastId) : undefined)
      .orderBy(asc(employeeDocuments.id))
      .limit(batchSize);
    if (!rows.length) return verified;
    for (const row of rows) {
      fieldEncryption.decryptBytes(
        row.content,
        employeeDocumentContext(row.employeeId, row.documentType),
      );
    }
    verified += rows.length;
    lastId = rows[rows.length - 1].id;
  }
}

async function verifyPayrollRevisions(): Promise<number> {
  let lastId: string | undefined;
  let verified = 0;
  while (true) {
    const rows = await db.select({
      id: payrollRecordRevisions.id,
      payrollRecordId: payrollRecordRevisions.payrollRecordId,
      snapshot: payrollRecordRevisions.snapshot,
    }).from(payrollRecordRevisions)
      .where(lastId ? gt(payrollRecordRevisions.id, lastId) : undefined)
      .orderBy(asc(payrollRecordRevisions.id))
      .limit(batchSize);
    if (!rows.length) return verified;
    for (const row of rows) {
      if (typeof row.snapshot !== 'object' || row.snapshot === null || Array.isArray(row.snapshot)) {
        throw new Error(`Payroll revision ${row.id} has an invalid snapshot.`);
      }
      for (const field of payrollMoneyFields) {
        const value = row.snapshot[field];
        if (typeof value !== 'string') throw new Error(`Payroll revision ${row.id} has an unencrypted ${field}.`);
        decryptNumber(value, payrollFieldContext(row.payrollRecordId, field));
      }
      for (const field of payrollTextFields) {
        const value = row.snapshot[field];
        if (typeof value !== 'string') throw new Error(`Payroll revision ${row.id} has an unencrypted ${field}.`);
        fieldEncryption.decryptText(value, payrollFieldContext(row.payrollRecordId, field));
      }
    }
    verified += rows.length;
    lastId = rows[rows.length - 1].id;
  }
}

try {
  const [employeeCount, payrollCount, documentCount, revisionCount] = await Promise.all([
    backfillEmployees(),
    backfillPayrollRecords(),
    backfillDocuments(),
    backfillPayrollRevisions(),
  ]);
  const [verifiedEmployees, verifiedPayroll, verifiedDocuments, verifiedRevisions] = await Promise.all([
    verifyEmployees(),
    verifyPayrollRecords(),
    verifyDocuments(),
    verifyPayrollRevisions(),
  ]);
  if (
    employeeCount !== verifiedEmployees
    || payrollCount !== verifiedPayroll
    || documentCount !== verifiedDocuments
    || revisionCount !== verifiedRevisions
  ) {
    throw new Error('Database rows changed during the encryption backfill; stop all writers and rerun it.');
  }
  console.info(
    `Encrypted and verified ${employeeCount} employees, ${payrollCount} payroll records, ${documentCount} documents, and ${revisionCount} revisions.`,
  );
} catch (error) {
  console.error('Sensitive data encryption backfill failed.', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
