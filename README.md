# Invoice Payment Approval Dashboard

A multi-user invoice approval dashboard for **mosaicwellness.in**. It's a static React app hosted on **GitHub Pages**, and users sign in with their **Google Workspace** accounts.

* **Invoice copies** are saved to **Google Drive**, in one folder per **service month** (the month the services were taken), for example `Invoices/2026-10 (October 2026)/2026-10 - Vendor - INV-123.pdf`.
* **A Google Sheet** is the live register. It's updated automatically after every action, with three tabs:
  * **All Invoices**: every invoice that has been uploaded.
  * **Sent for Payment**: one row per invoice sent for payment.
  * **Batches**: one row per batch, with its approval trail.
* **Cloud Firestore** (Firebase) stores the approval workflow behind the scenes. A sheet can be edited by anyone with access, so the workflow itself lives in Firestore, where server-side rules decide who may approve what.

## Workflow

```
User 1 (Maker)                     User 2 (L1)   User 3 (L2)          User 4 (L3)        Finance
Upload invoice → Review & Validate → Send ──────▶ Approve ──▶ Approve ──┬─ total > ₹20 L ─▶ Approve ─▶ Pay (UTR)
(single or bulk; one batch per                                         └─ total ≤ ₹20 L ─────────────▶ Pay (UTR)
 expense category; Excel downloaded)        any approver can Reject (with reason) → invoices return to User 1
```

* **User 1** enters the vendor name, GSTIN, invoice no., invoice date, **service month**, taxable amount, GST, total and expense category, and attaches the invoice PDF or image. The copy goes into that service month's Drive folder. The month folder is created automatically if it doesn't exist. The dashboard then checks the invoice:
  * Taxable + GST must equal the total, within ₹1 for round-off.
  * The GST rate is checked against the standard slabs.
  * The GSTIN format is checked.
  * Duplicate vendor + invoice numbers are blocked.
  * Future invoice dates are blocked.
  * An attachment and a service month are required.

  The **Validate** button stays disabled until User 1 ticks the double-check confirmation.
* The **vendor** is picked from a searchable dropdown (79 vendors built in, in `src/vendors.ts`). If a vendor is missing, **+ Add new vendor** saves it, with an optional GSTIN, for everyone. Picking a vendor with a saved GSTIN fills the GSTIN in automatically. The **expense categories** (16 `Warehouse - …` heads) are set in `src/config.ts`.
* If the service month, vendor or invoice number is corrected later, the Drive file is moved to the correct folder and renamed.
* After validation, User 1 can **send** one invoice right away, or select many invoices and **send them in bulk**. Selected invoices are grouped into **one batch per expense category**. An Excel file is downloaded, and the Google Sheet is updated.
* The **₹20 lakh rule** applies to the **batch total**. A batch above ₹20,00,000 goes to User 4. Otherwise, User 3's approval sends it straight to Finance. The rule is also enforced on the server in `firestore.rules`.
* **Finance** sees the approved batches, downloads the Excel or uses the Google Sheet, and records the payment reference (UTR).
* The top bar has **📁 Drive** and **📊 Sheet** links. The sheet link shows whether the last update succeeded and offers **Retry** if it failed.

## Try it locally (demo mode)

```bash
npm install
```

```bash
npm run dev
```

If no Firebase settings are configured, the app runs in **DEMO mode**: you pick a role on the login page, and data and files are kept only in your browser. Drive and Sheets aren't used. Don't use demo mode for real invoices.

## Production setup

Do all of this while signed in with your **@mosaicwellness.in** account, so that the project belongs to the company's Google Workspace.

### 1. Firebase project (sign-in and workflow database)
1. Go to <https://console.firebase.google.com>, choose **Create a project** (Analytics isn't needed), then click the **`</>`** (Web) icon to **register a web app**. Copy the six `firebaseConfig` values.
2. **Authentication → Get started → Sign-in method → Google**: enable it and save. Then under **Settings → Authorized domains**, add `mosaic-as.github.io`.
3. **Firestore Database → Create database**: choose the `asia-south1` (Mumbai) location and **production mode**.
4. **Firestore Database → Rules**: replace the contents with [`firestore.rules`](firestore.rules) and click **Publish**.
5. **Firestore Database → Data → Start collection** `users`. Add a document whose **ID is your email in lower case** (e.g. `asif.shaikh@mosaicwellness.in`), with the fields `name` (string), `role` = `admin` (string) and `active` = `true` (boolean).

Firebase Storage and the Blaze (paid) plan are **not** needed, because the files go to Google Drive.

### 2. Google Cloud (permission to use Drive and Sheets)
Open <https://console.cloud.google.com> and select the same project from the project picker at the top.

1. **APIs & Services → Library**: enable **Google Drive API** and **Google Sheets API**.
2. **APIs & Services → OAuth consent screen** (shown as *Google Auth Platform → Audience* in newer consoles): set the user type to **Internal**. This restricts the app to mosaicwellness.in users, and Google doesn't need to verify the app.
3. **APIs & Services → Credentials → OAuth 2.0 Client IDs**: open **"Web client (auto created by Google Service)"**.
   * Under **Authorized JavaScript origins**, add `https://mosaic-as.github.io` and `http://localhost:5173`, then save.
   * Copy the **Client ID**. It ends in `.apps.googleusercontent.com`.

The first time each person signs in, Google asks them to allow access to Drive and Sheets. The dashboard can only see what that person can already see in Drive.

### 3. Drive folder and Google Sheet
1. **Drive folder:** create a folder for invoice copies, e.g. `Invoices`. A **Shared drive** is recommended, so the files belong to the company rather than to one person's account. The folder ID is the last part of the folder's URL (`https://drive.google.com/drive/folders/`**`<folder-id>`**). Share the folder:
   * **User 1 (makers):** Editor (or Content manager on a Shared drive).
   * **Approvers and Finance:** Viewer.
2. **Google Sheet:** create a blank sheet, e.g. `Payment Register`. The sheet ID is the part of its URL between `/d/` and `/edit`. Share it as **Editor** with everyone who uses the dashboard (makers, all approvers and finance), because whoever takes an action updates the sheet. The dashboard creates and rewrites the tabs **All Invoices**, **Sent for Payment** and **Batches**. Don't type into those tabs: your changes would be overwritten. Add your own tabs for pivots and formulas instead.

### 4. Settings in GitHub
In the repository, go to **Settings → Secrets and variables → Actions → Variables** and add these:

| Variable | Value |
|---|---|
| `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID` | from step 1.1 |
| `VITE_GOOGLE_CLIENT_ID` | from step 2.3 |
| `VITE_DRIVE_FOLDER_ID` | from step 3.1 |
| `VITE_SHEET_ID` | from step 3.2 |
| `VITE_SSO_PROVIDER` | `google` |
| `VITE_ALLOWED_DOMAINS` | `mosaicwellness.in` |

Then go to **Settings → Pages → Source** and choose **GitHub Actions**. Open the **Actions** tab, select **Deploy dashboard to GitHub Pages** and click **Run workflow**. The site is published at <https://mosaic-as.github.io/Payment-DashboardV2/>. Every push to `main` deploys again.

### 5. Add users
Sign in to the site as the admin and add people under **Users & roles**. The roles are `maker` (User 1), `approver1` (User 2), `approver2` (User 3), `approver3` (User 4), `finance` and `admin`. Remember to share the Drive folder and the Sheet with each person too (step 3).

## Security model

| Control | Where |
|---|---|
| Only @mosaicwellness.in Google accounts are accepted | Google sign-in, the Internal consent screen and `firestore.rules` |
| Only active users listed in `users/` get any data | Firestore rules |
| Only makers create or edit invoices. Invoices are locked while in approval or after payment | Firestore rules |
| Each approver can act only at their own level, and only the next status is allowed | Firestore rules (`decide()`) |
| The L3 routing flag must equal `total > ₹20 L`, and it can't change after creation | Firestore rules |
| Rejection needs a reason. Approval history is append-only. Batches can't be deleted | Firestore rules |
| Invoice copies and the register follow Google Drive and Sheets sharing | The folder and sheet permissions you set in step 3 |

**Known limitations**
* The Google Sheet is a **copy** of the workflow data that's rewritten after each action. If one update fails, for example because someone lacks edit access, the next successful update fixes it. **Retry** in the top bar forces an update.
* The Firestore rules can't add up the invoices inside a batch. Each approver's screen re-adds the invoice amounts and blocks approval if they don't match the batch total. This catches a tampered total, but the check runs in the browser. For full server-side enforcement, move batch creation into a Cloud Function.
* Deleting a draft invoice leaves its copy in Drive. Uploading a replacement copy keeps the old file too.
* The rules and the Drive/Sheets integration haven't been tested against a live project yet. Run one dummy invoice through every user before going live.

## Project structure

```
src/config.ts               domains, Google IDs, ₹20 L threshold, categories
src/vendors.ts              built-in vendor list
src/lib/validation.ts       invoice checks
src/lib/workflow.ts         routing, batching, stage logic
src/lib/excel.ts            Excel export and Google Sheet rows (same columns)
src/lib/google.ts           Google Drive (month folders) and Google Sheets
src/data/actions.ts         all state changes
src/data/firebaseBackend.ts Firebase sign-in and Firestore, plus Drive and Sheets
src/data/demoBackend.ts     browser-only demo implementation
src/views/*                 screens per role
firestore.rules
```

```bash
npm test
```

```bash
npm run build
```
