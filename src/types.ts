export type Role = 'maker' | 'approver1' | 'approver2' | 'approver3' | 'finance' | 'admin';

export const ROLE_LABELS: Record<Role, string> = {
  maker: 'Invoice Maker (User 1)',
  approver1: 'Approver L1 (User 2)',
  approver2: 'Approver L2 (User 3)',
  approver3: 'Approver L3 (User 4)',
  finance: 'Finance Team',
  admin: 'Administrator',
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
  col: 'invoices' | 'batches' | 'users' | 'mail' | 'vendors';
  id: string;
  data?: Record<string, unknown>;
}
