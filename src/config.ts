// ─────────────────────────────────────────────────────────────────────────────
// Central configuration. Edit this file (or set the VITE_* variables in the
// GitHub repository settings) before deploying. See README.md → "Setup".
// ─────────────────────────────────────────────────────────────────────────────

const env = import.meta.env;

export const config = {
  appName: env.VITE_APP_NAME || 'Invoice Payment Approvals',

  /**
   * Firebase web config (Project settings → Your apps → Web app).
   * These values are public identifiers, not secrets — access control is
   * enforced by firestore.rules / storage.rules.
   * Leave apiKey empty to run the app in DEMO MODE (data kept in this browser).
   */
  firebase: {
    apiKey: env.VITE_FIREBASE_API_KEY || '',
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || '',
    projectId: env.VITE_FIREBASE_PROJECT_ID || '',
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || '',
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
    appId: env.VITE_FIREBASE_APP_ID || '',
  },

  /** 'microsoft' for Microsoft 365 / Entra ID, 'google' for Google Workspace. */
  ssoProvider: (env.VITE_SSO_PROVIDER || 'google') as 'microsoft' | 'google',

  /**
   * Google Workspace storage (used when Firebase is configured):
   *  • invoice copies → Drive folder <driveFolderId>/<service month>/
   *  • live register   → Google Sheet <sheetId>
   * clientId is the OAuth "Web client" ID of the Firebase/Google Cloud project.
   */
  google: {
    clientId: env.VITE_GOOGLE_CLIENT_ID || '',
    driveFolderId: env.VITE_DRIVE_FOLDER_ID || '',
    sheetId: env.VITE_SHEET_ID || '',
  },

  /** Microsoft Entra tenant ID (restricts sign-in to your organisation). */
  microsoftTenantId: env.VITE_MICROSOFT_TENANT_ID || '',

  /**
   * Company email domains allowed to sign in. Must match the domain list in
   * firestore.rules and storage.rules.
   */
  allowedDomains: (env.VITE_ALLOWED_DOMAINS || 'mosaicwellness.in')
    .split(',')
    .map((d: string) => d.trim().toLowerCase())
    .filter(Boolean),

  /**
   * Batches with a total ABOVE this amount (₹) need the 4th-user (L3) approval.
   * Must match THRESHOLD in firestore.rules. 20 lakh = 20,00,000.
   */
  l3Threshold: 2_000_000,

  /** Allowed difference (₹) between Taxable + GST and Total, for round-off. */
  roundOffTolerance: 1,

  /** GST rates (%) considered normal. Any other effective rate shows a warning. */
  gstSlabs: [0, 0.25, 3, 5, 12, 18, 28, 40],

  expenseCategories: [
    'Rent',
    'Utilities',
    'IT & Software',
    'Professional Fees',
    'Travel',
    'Marketing',
    'Office Supplies',
    'Repairs & Maintenance',
    'Logistics',
    'Others',
  ],

  /**
   * Optional email to the finance team when a batch is cleared for payment.
   * Requires the Firebase "Trigger Email from Firestore" extension, writing
   * to the `mail` collection. Leave empty to rely on the in-app finance queue.
   */
  financeEmail: env.VITE_FINANCE_EMAIL || '',

  maxAttachmentMb: 10,
};

export const isDemoMode = !config.firebase.apiKey;

export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const domain = email.toLowerCase().split('@')[1];
  return !!domain && config.allowedDomains.includes(domain);
}
