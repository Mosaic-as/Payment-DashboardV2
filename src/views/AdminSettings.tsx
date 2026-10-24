import { useEffect, useState } from 'react';
import { isAllowedEmail } from '../config';
import { saveMailSettings } from '../data/actions';
import { useStore } from '../data/store';
import { ErrorNote, useAction } from '../components/ui';

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const splitEmails = (s: string) => s.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);

export function AdminSettings() {
  const { be, mailSettings } = useStore();
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [mailerUrl, setMailerUrl] = useState('');
  const [saved, setSaved] = useState('');
  const save = useAction();
  const test = useAction();

  useEffect(() => {
    setTo((mailSettings?.to ?? []).join('\n'));
    setCc((mailSettings?.cc ?? []).join('\n'));
    setMailerUrl(mailSettings?.mailerUrl ?? '');
  }, [mailSettings]);

  const toList = splitEmails(to);
  const ccList = splitEmails(cc);
  const bad = [...toList, ...ccList].filter((e) => !EMAIL_RE.test(e));
  const external = [...toList, ...ccList].filter((e) => EMAIL_RE.test(e) && !isAllowedEmail(e));

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">Who receives the email when a batch completes approval, and the mailer that sends it from User 1's mailbox.</p>
        </div>
      </div>

      <div className="card">
        <h3>Finance email</h3>
        <div className="form-grid form-grid-2">
          <label>To — finance team (one per line)
            <textarea rows={5} value={to} onChange={(e) => { setTo(e.target.value); setSaved(''); }} placeholder={'payments@mosaicwellness.in'} />
          </label>
          <label>CC — stakeholders (one per line)
            <textarea rows={5} value={cc} onChange={(e) => { setCc(e.target.value); setSaved(''); }} />
          </label>
          <label className="span-3">Mailer URL (from User 1's Apps Script deployment — see README)
            <input className="mono" value={mailerUrl} onChange={(e) => { setMailerUrl(e.target.value.trim()); setSaved(''); }} placeholder="https://script.google.com/macros/s/…/exec" />
          </label>
        </div>
        {bad.length > 0 && <div className="note note-error">Not valid email addresses: {bad.join(', ')}</div>}
        {external.length > 0 && <div className="note note-warn">Outside mosaicwellness.in: {external.join(', ')} — invoices and amounts will be emailed to them.</div>}
        <div className="row-gap">
          <button
            className="btn btn-primary"
            disabled={save.busy || bad.length > 0}
            onClick={() => save.run(async () => {
              if (!toList.length) throw new Error('Add at least one "To" address.');
              if (mailerUrl && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(mailerUrl)) {
                throw new Error('The mailer URL should look like https://script.google.com/macros/s/…/exec');
              }
              await saveMailSettings(be, { to: toList, cc: ccList, mailerUrl });
              setSaved('Saved.');
            })}
          >{save.busy ? 'Saving…' : 'Save'}</button>
          <button
            className="btn btn-outline"
            disabled={test.busy || !mailSettings?.mailerUrl || !be.sendFinanceMail}
            title="Sends a short test email to you, from User 1's mailbox"
            onClick={() => test.run(async () => {
              await be.sendFinanceMail!(mailSettings!.mailerUrl, { batchId: '', html: '', excelBase64: '', excelName: '', resend: false, test: true });
              setSaved('Test email sent — check your inbox.');
            })}
          >{test.busy ? 'Sending…' : 'Send test email to me'}</button>
          {saved && <span className="small ok-text">{saved}</span>}
        </div>
        <ErrorNote error={save.error || test.error} />
      </div>
    </section>
  );
}
