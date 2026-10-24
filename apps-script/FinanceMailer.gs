/**
 * Invoice Payment Approvals — finance email sender.
 *
 * Deployed ONCE by User 1 (Invoice Maker) as a Google Apps Script web app:
 *   Execute as: Me   ·   Who has access: Anyone
 * Every finance email is then sent from User 1's Gmail, the moment a batch
 * completes approval. See README → "Finance email (sent as User 1)".
 *
 * Safety: the caller must send their dashboard sign-in token. The script uses
 * it to read the caller's profile, the batch, the invoices and the recipient
 * list straight from Firestore, so the security rules decide what is allowed
 * and nobody can make it email anything else.
 */

const PROJECT_ID = 'payment-dashboard-51222';
const ALLOWED_DOMAIN = 'mosaicwellness.in';
const SENDER_NAME = 'Invoice Payment Approvals';
const SENDER_ROLES = ['approver2', 'approver3', 'finance', 'admin'];
// Gmail allows 25 MB per email including encoding overhead (~33%).
const MAX_ATTACHMENT_BYTES = 17 * 1024 * 1024;

const FIRESTORE = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents';

/** Run this once from the editor (▶ Run) to grant the permissions the script needs. */
function authorize() {
  GmailApp.getAliases();
  DriveApp.getRootFolder();
  UrlFetchApp.fetch('https://www.googleapis.com/discovery/v1/apis?name=firestore', { muteHttpExceptions: true });
  Logger.log('Authorised. Now deploy: Deploy → New deployment → Web app.');
}

function doGet() {
  return json_({ ok: true, service: 'finance-mailer', sender: Session.getEffectiveUser().getEmail() });
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const caller = verifyCaller_(req.idToken);

    if (req.test) {
      GmailApp.sendEmail(caller.email, 'Test – finance mailer is working',
        'This test email was sent from ' + Session.getEffectiveUser().getEmail() +
        ' by the Invoice Payment Approvals mailer. Finance emails will be sent from this mailbox.',
        { name: SENDER_NAME });
      return json_({ ok: true, parts: 1 });
    }

    if (SENDER_ROLES.indexOf(caller.role) < 0) throw new Error('Only L2/L3 approvers, Finance or an admin can send the finance email.');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(req.batchId || '')) throw new Error('Invalid batch.');

    const batch = getDoc_('batches/' + req.batchId, req.idToken);
    if (!batch) throw new Error('Batch not found.');
    if (batch.status !== 'WITH_FINANCE' && batch.status !== 'PAID') throw new Error('This batch has not completed approval yet.');

    const props = PropertiesService.getScriptProperties();
    const sentKey = 'sent_' + req.batchId;
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      if (props.getProperty(sentKey) && !req.resend) return json_({ ok: true, parts: Number(props.getProperty(sentKey)), already: true });

      const settings = getDoc_('settings/mail', req.idToken);
      const to = (settings && settings.to) || [];
      const cc = (settings && settings.cc) || [];
      if (!to.length) throw new Error('No finance email recipients are set (Settings → Finance email).');

      const excel = Utilities.newBlob(Utilities.base64Decode(req.excelBase64 || ''),
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', req.excelName || (batch.batchNo + '.xlsx'));

      // Invoice copies, straight from Drive (User 1 can read the invoices folder).
      const invoices = getDocs_(batch.invoiceIds.map(function (id) { return 'invoices/' + id; }), req.idToken);
      const files = invoices.map(function (inv) {
        const blob = DriveApp.getFileById(inv.filePath).getBlob();
        const ext = (inv.fileName.match(/\.[A-Za-z0-9]{2,5}$/) || [''])[0] || extFromType_(blob.getContentType());
        blob.setName(safeName_(inv.vendorName + ' - ' + inv.invoiceNumber) + ext);
        return { blob: blob, inv: inv };
      });

      // Pack: the first email carries the Excel and as many copies as fit;
      // the rest follow in "part 2 of N" emails. The main body never changes.
      const parts = [[]];
      let used = excel.getBytes().length;
      files.forEach(function (f) {
        const size = f.blob.getBytes().length;
        if (used + size > MAX_ATTACHMENT_BYTES && parts[parts.length - 1].length) { parts.push([]); used = 0; }
        parts[parts.length - 1].push(f);
        used += size;
      });

      const subject = 'Payment approved – ' + batch.batchNo + ' · ' + batch.category + ' · ' + inr_(batch.totalAmount) +
        ' · ' + batch.invoiceCount + (batch.invoiceCount === 1 ? ' invoice' : ' invoices');
      let html = String(req.html || '');
      if (parts.length > 1) {
        html += '<p style="color:#64748b;font-size:12px;font-family:Segoe UI,Arial,sans-serif">Invoice copies are split across ' +
          parts.length + ' emails because of Gmail\'s size limit; the remaining copies follow with the same subject (“part 2 of ' +
          parts.length + '” …).</p>';
      }
      const common = { name: SENDER_NAME, cc: cc.join(',') };

      GmailApp.sendEmail(to.join(','), subject, plainText_(batch), Object.assign({}, common, {
        htmlBody: html,
        attachments: [excel].concat(parts[0].map(function (f) { return f.blob; })),
      }));
      for (let p = 1; p < parts.length; p++) {
        const list = parts[p].map(function (f) {
          return '<li>' + esc_(f.inv.vendorName) + ' – ' + esc_(f.inv.invoiceNumber) + ' – ' + inr_(f.inv.totalAmount) + '</li>';
        }).join('');
        GmailApp.sendEmail(to.join(','), subject + ' – invoice copies part ' + (p + 1) + ' of ' + parts.length,
          'Invoice copies (continued) for batch ' + batch.batchNo + '.', Object.assign({}, common, {
            htmlBody: '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px">' +
              '<p>Invoice copies (continued) for batch <b>' + esc_(batch.batchNo) + '</b>. The batch summary and Excel are in the first email.</p>' +
              '<ul>' + list + '</ul></div>',
            attachments: parts[p].map(function (f) { return f.blob; }),
          }));
      }
      props.setProperty(sentKey, String(parts.length));
      return json_({ ok: true, parts: parts.length });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

// ── Caller check ────────────────────────────────────────────────────────────
function verifyCaller_(idToken) {
  if (!idToken || idToken.split('.').length !== 3) throw new Error('Not signed in.');
  const payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(pad_(idToken.split('.')[1]))).getDataAsString());
  if (payload.aud !== PROJECT_ID) throw new Error('Sign-in is for a different project.');
  const email = String(payload.email || '').toLowerCase();
  if (!email.endsWith('@' + ALLOWED_DOMAIN)) throw new Error('Only @' + ALLOWED_DOMAIN + ' users can use the mailer.');
  // Firestore checks the token's signature; the rules only return your own profile.
  const user = getDoc_('users/' + email, idToken);
  if (!user || user.active !== true) throw new Error('Your dashboard access is not active.');
  return { email: email, role: user.role };
}

// ── Firestore REST (as the caller) ───────────────────────────────────────────
function getDoc_(path, idToken) {
  const res = UrlFetchApp.fetch(FIRESTORE + '/' + path, {
    headers: { Authorization: 'Bearer ' + idToken }, muteHttpExceptions: true,
  });
  if (res.getResponseCode() === 404) return null;
  if (res.getResponseCode() !== 200) throw new Error('Database refused the request (' + res.getResponseCode() + '): ' + errText_(res));
  return fields_(JSON.parse(res.getContentText()).fields || {});
}

function getDocs_(paths, idToken) {
  if (!paths.length) return [];
  const base = 'projects/' + PROJECT_ID + '/databases/(default)/documents/';
  const res = UrlFetchApp.fetch(FIRESTORE + ':batchGet', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + idToken },
    payload: JSON.stringify({ documents: paths.map(function (p) { return base + p; }) }),
  });
  if (res.getResponseCode() !== 200) throw new Error('Database refused the request (' + res.getResponseCode() + '): ' + errText_(res));
  const byName = {};
  JSON.parse(res.getContentText()).forEach(function (r) { if (r.found) byName[r.found.name] = fields_(r.found.fields || {}); });
  return paths.map(function (p) { return byName[base + p]; }).filter(function (d) { return !!d; });
}

function fields_(f) {
  const o = {};
  Object.keys(f).forEach(function (k) { o[k] = val_(f[k]); });
  return o;
}

function val_(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(val_);
  if ('mapValue' in v) return fields_(v.mapValue.fields || {});
  return null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
function errText_(res) {
  try { return JSON.parse(res.getContentText()).error.message; } catch (e) { return res.getContentText().slice(0, 200); }
}
function pad_(s) { return s + '==='.slice((s.length + 3) % 4); }
function esc_(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function safeName_(s) { return String(s).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120); }
function extFromType_(t) { return t === 'application/pdf' ? '.pdf' : t === 'image/png' ? '.png' : t === 'image/jpeg' ? '.jpg' : ''; }

/** ₹ with Indian digit grouping: 1234567.5 → ₹12,34,567.50 */
function inr_(n) {
  const neg = n < 0;
  const parts = Math.abs(Number(n) || 0).toFixed(2).split('.');
  let x = parts[0];
  const last3 = x.slice(-3);
  const rest = x.slice(0, -3);
  x = (rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' : '') + last3;
  return (neg ? '-₹' : '₹') + x + '.' + parts[1];
}

function plainText_(b) {
  return 'Batch ' + b.batchNo + ' (' + b.category + ', ' + b.invoiceCount + ' invoices, ' + inr_(b.totalAmount) +
    ') has completed all approvals and is ready for payment. The Excel and invoice copies are attached. ' +
    'Open this email in an HTML-capable mail client to see the full summary.';
}
