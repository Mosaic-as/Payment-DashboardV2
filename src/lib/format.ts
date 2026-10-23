const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const inrPlain = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const formatINR = (n: number) => inr.format(n || 0);
export const formatAmount = (n: number) => inrPlain.format(n || 0);

/** "₹20.00 L" / "₹1.25 Cr" style short form used on KPI cards. */
export function formatLakh(n: number): string {
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  return formatINR(n);
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export const nowIso = () => new Date().toISOString();

export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function newId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
}

/** '2026-10' → 'Oct 2026' */
export function formatMonth(ym: string | null | undefined): string {
  if (!ym || !/^\d{4}-\d{2}$/.test(ym)) return '';
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-IN', { month: 'short', year: 'numeric' });
}

/** Google Drive folder for a service month, e.g. '2026-10 (October 2026)'. Sorts chronologically. */
export function monthFolderName(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${ym} (${new Date(y, m - 1, 1).toLocaleString('en-IN', { month: 'long' })} ${y})`;
}

export const currentMonth = () => todayIso().slice(0, 7);

/** File name used in Drive: '2026-10 - Vendor - INV-1.pdf' */
export function driveFileName(serviceMonth: string, vendor: string, invoiceNo: string, original: string): string {
  const ext = original.includes('.') ? original.slice(original.lastIndexOf('.')) : '';
  return `${serviceMonth} - ${vendor} - ${invoiceNo}`.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 150) + ext;
}
