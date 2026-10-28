export type Role = 'maker' | 'approver1' | 'approver2' | 'approver3' | 'finance' | 'admin' | 'superuser';

export const ROLE_LABELS: Record<Role, string> = {
  maker: 'Invoice Maker (User 1)',
  approver1: 'Approver L1 (User 2)',
  approver2: 'Approver L2 (User 3)',
  approver3: 'Approver L3 (User 4)',
  finance: 'Finance Team',
  admin: 'Administrator',
  superuser: 'Super user (all roles)',
};

export interface AppUser {
  email: string; // document id, lower-case
  name: string;
  role: Role;
  active: boolean;
}

export interface SessionUser {
  email: string;
  name: string;
  profile: AppUser | null; // null = signed in but not provisioned by an admin
}

export interface Vendor {
  id: string; // vendorKey(name)
  name: string;
  gstin: string;
  /** false for the built-in starting list */
  custom: boolean;
}

export interface HistoryEntry {
  at: string;
  by: string;
  action: string;
  note?: string;
}

export type InvoiceStatus = 'DRAFT' | 'VALIDATED';

export interface Invoice {
  id: string;
  vendorName: string;
  vendorGstin: string;
  invoiceNumber: string;
  invoiceDate: string; // yyyy-mm-dd
  taxableAmount: number;
  gstAmount: number;
  totalAmount: number;
  category: string;
  /** Month the services were taken (yyyy-mm); decides the Drive folder. */
  serviceMonth: string;
  notes: string;
  dupKey: string;
  /** Drive file id (or demo storage path). */
  filePath: string;
  fileName: string;
  /** Link to open the copy (Drive), empty in demo mode. */
  fileUrl: string;
  status: InvoiceStatus;
  /** Set when sent for approval. Workflow stage then comes from the batch. */
  batchId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  validatedBy: string | null;
  validatedAt: string | null;
  history: HistoryEntry[];
}

export type BatchStatus = 'PENDING_L1' | 'PENDING_L2' | 'PENDING_L3' | 'WITH_FINANCE' | 'PAID' | 'REJECTED';

export interface Approval {
  level: 1 | 2 | 3;
  by: string;
  at: string;
  decision: 'APPROVED' | 'REJECTED';
  comment: string;
}

/** An invoice an approver took out of a batch and sent back to User 1. */
export interface ReturnedInvoice {
  invoiceId: string;
  invoiceNumber: string;
  vendorName: string;
  totalAmount: number;
  level: 1 | 2 | 3;
  by: string;
  at: string;
  reason: string;
}

/** Payment of one invoice, recorded by Finance. */
export interface Payment {
  utr: string;
  date: string; // yyyy-mm-dd
  tds: number;
  paid: number;
  by: string;
  at: string;
}

/** Result of the automatic email to the finance team. */
export interface FinanceMail {
  status: 'sent' | 'failed';
  at: string;
  by: string;
  parts?: number;
  error?: string;
}

/** Admin settings for the finance email (Firestore settings/mail). */
export interface MailSettings {
  to: string[];
  cc: string[];
  /** Web app URL of the Apps Script mailer that sends as User 1. */
  mailerUrl: string;
}

export interface Batch {
  id: string;
  batchNo: string;
  category: string;
  invoiceIds: string[];
  invoiceCount: number;
  taxableTotal: number;
  gstTotal: number;
  totalAmount: number;
  requiresL3: boolean;
  status: BatchStatus;
  approvals: Approval[];
  /** Invoices returned individually; they are no longer in invoiceIds. */
  returned?: ReturnedInvoice[];
  /** Invoices already approved one by one at the current level. */
  levelApproved?: string[];
  /** Invoice id → payment. The batch becomes PAID when every invoice has one. */
  payments?: Record<string, Payment>;
  financeMail?: FinanceMail;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  paymentRef: string | null;
  paidAt: string | null;
  paidBy: string | null;
}

/** Combined stage shown on an invoice row. */
export type InvoiceStage = 'DRAFT' | 'VALIDATED' | 'RETURNED' | BatchStatus;

export const STAGE_LABELS: Record<InvoiceStage, string> = {
  DRAFT: 'Draft',
  VALIDATED: 'Validated',
  RETURNED: 'Returned',
  PENDING_L1: 'Pending L1',
  PENDING_L2: 'Pending L2',
  PENDING_L3: 'Pending L3',
  WITH_FINANCE: 'With Finance',
  PAID: 'Paid',
  REJECTED: 'Rejected',
};

export interface WriteOp {
  type: 'set' | 'update' | 'delete';
  col: 'invoices' | 'batches' | 'users' | 'mail' | 'vendors' | 'settings';
  id: string;
  data?: Record<string, unknown>;
}
