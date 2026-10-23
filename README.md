# Invoice Payment Approval Dashboard

A multi-user invoice approval dashboard. It's a static React app hosted on **GitHub Pages**, uses **company-domain SSO** (Microsoft 365 or Google Workspace) through Firebase Authentication, and keeps its data in **Cloud Firestore**. Invoice copies are stored in **Firebase Storage**.

## Workflow

```
User 1 (Maker)                     User 2 (L1)   User 3 (L2)          User 4 (L3)        Finance
Upload invoice → Review & Validate → Send ──────▶ Approve ──▶ Approve ──┬─ total > ₹20 L ─▶ Approve ─▶ Pay (UTR)
(single or bulk; one batch per                                         └─ total ≤ ₹20 L ─────────────▶ Pay (UTR)
 expense category; Excel downloaded)        any approver can Reject (with reason) → invoices return to User 1
```

* **User 1** enters the vendor name, GSTIN, invoice no., date, taxable amount, GST, total and expense category, and attaches the invoice PDF or image. The dashboard then checks the invoice:
  * Taxable + GST must equal the total, within ₹1 for round-off.
  * The GST rate is checked against the standard slabs.
  * The GSTIN format is checked.
  * Duplicate vendor + invoice numbers are blocked.
  * Future dates are blocked.
  * An attachment is required.

  The **Validate** button stays disabled until User 1 ticks the double-check confirmation.
* After validation, User 1 can **send** one invoice right away, or select many invoices and **send them in bulk**. Selected invoices are grouped into **one batch per expense category**. An Excel file (`Batch Summary` + `Invoice Details` sheets) is downloaded automatically.
* The **₹20 lakh rule** applies to the **batch total**. A batch above ₹20,00,000 goes to User 4. Otherwise, User 3's approval sends it straight to Finance. The rule is also enforced on the server in `firestore.rules`.
* **Finance** sees the approved batches, downloads the Excel and records the payment reference (UTR). If you configure it, an email with the Excel attached is sent when a batch reaches Finance.
* **All batches** shows the full approval trail. Anyone can download the **Payment register** Excel, which lists every invoice sent for payment.

## Try it locally (demo mode)

```bash
npm install
```

```bash
npm run dev
```

If no Firebase settings are configured, the app runs in **DEMO mode**: you pick a role on the login page and data is kept only in your browser. Use two browser tabs to act as different users. Don't use demo mode for real invoices.

## Production setup

### 1. Firebase project
1. Create a project at <https://console.firebase.google.com>. Then add a **Web app** and copy its config values.
2. **Authentication → Sign-in method**:
   * **Microsoft 365**: register an app in Entra ID (Azure portal → App registrations). Choose *Single tenant* and set the redirect URI to `https://<project-id>.firebaseapp.com/__/auth/handler`. Then enable the **Microsoft** provider in Firebase with that app's client ID and secret.
   * **Google Workspace**: enable the **Google** provider.
3. **Authentication → Settings → Authorized domains**: add `<your-github-org>.github.io`.
4. **Firestore Database**: create it in *production mode*. Choose an Indian region (e.g. `asia-south1`) if you need data residency.
5. **Storage**: enable it. New projects need the Blaze (pay-as-you-go) plan for Storage. The free usage tier still applies, so normal invoice volumes cost little or nothing.

### 2. Lock the rules to your domain
Both rule files are already set to `mosaicwellness.in`. To add another domain, update `companyDomain()` in **both** `firestore.rules` and `storage.rules`, e.g. `'.*@(mosaicwellness[.]in|other[.]com)$'`, and `VITE_ALLOWED_DOMAINS`. If you change the ₹20 lakh threshold, change it in `firestore.rules` (`threshold()`) and in `src/config.ts` (`l3Threshold`) together. Then deploy:

```bash
npx firebase-tools login
```

```bash
npx firebase-tools deploy --only firestore:rules,storage --project <project-id>
```

When the CLI asks whether Storage rules may read Firestore, allow it. The Storage rules need that to check user roles.

### 3. Create the first administrator
In the Firestore console, create the collection `users` with a document whose **ID is your email in lower case**:

| field | type | value |
|---|---|---|
| name | string | Your Name |
| role | string | `admin` |
| active | boolean | `true` |

Sign in to the dashboard and use **Users & roles** to add everyone else. The roles are `maker` (User 1), `approver1` (User 2), `approver2` (User 3), `approver3` (User 4), `finance` and `admin`. Company users who aren't listed can sign in, but they see "Access pending" and the rules deny them all data.

### 4. Host on GitHub Pages
1. Create a GitHub repository and push this folder to the `main` branch.
2. Go to **Settings → Pages → Source** and choose **GitHub Actions**.
3. Go to **Settings → Secrets and variables → Actions → Variables** and add the values listed in `.env.example`: the `VITE_FIREBASE_*` values, `VITE_SSO_PROVIDER`, `VITE_MICROSOFT_TENANT_ID` and `VITE_ALLOWED_DOMAINS`. Optionally add `VITE_FINANCE_EMAIL` and `VITE_APP_NAME`. Firebase web config values are public identifiers, not secrets.
4. Push to `main`. The workflow in `.github/workflows/deploy.yml` runs the tests, builds the app and publishes it to `https://<org>.github.io/<repo>/`.

> GitHub Pages from a **private** repository needs a paid GitHub plan. On GitHub Enterprise Cloud you can also set Pages visibility to *private*, which adds GitHub login in front of the site. Either way, the data is protected by SSO and the Firestore/Storage rules, not by hiding the URL.

### 5. Optional: email to the finance team
Install the Firebase extension **Trigger Email from Firestore**, set its collection to `mail` and configure your SMTP server (e.g. Microsoft 365 SMTP). Then set `VITE_FINANCE_EMAIL`. Each batch that reaches Finance sends an email with the batch Excel attached.

## Security model

| Control | Where |
|---|---|
| Only company-domain, verified accounts are accepted | Client check plus `firestore.rules` / `storage.rules` (server) |
| Only active users listed in `users/` get any data | Rules |
| Only makers create or edit invoices. Invoices are locked while in approval or after payment | Rules |
| Each approver can act only at their own level, and only the next status is allowed | Rules (`decide()`) |
| The L3 routing flag must equal `total > ₹20 L`, and it can't change after creation | Rules (batch create and immutable fields) |
| Rejection needs a reason. Approval history is append-only. Batches can't be deleted | Rules |
| Invoice copies are fetched through the rules, with no public download links | Storage rules + `getBlob` |

**Known limitation:** the rules can't add up the invoices inside a batch. Each approver's screen re-adds the invoice amounts and blocks approval if they don't match the batch total. This catches a tampered total, but the check runs in the browser. For full server-side enforcement, move batch creation into a Cloud Function.

The rules haven't been run in the Firebase emulator (it needs Java 11+). Test the workflow once in a staging Firebase project before going live.

## Project structure

```
src/config.ts               domains, SSO provider, ₹20 L threshold, categories
src/lib/validation.ts       invoice checks
src/lib/workflow.ts         routing, batching, stage logic
src/lib/excel.ts            finance Excel export
src/data/actions.ts         all state changes (atomic writes)
src/data/firebaseBackend.ts Firebase implementation
src/data/demoBackend.ts     browser-only demo implementation
src/views/*                 screens per role
firestore.rules, storage.rules
```

```bash
npm test
```

```bash
npm run build
```
