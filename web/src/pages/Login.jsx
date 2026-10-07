import { useState } from 'react';
import { api } from '../api.js';
import { FormError, Notice, toast, useAction } from '../ui.jsx';

const FLOW = ['Find the patient, not the accession', 'Request with the clinical question and priority', 'Confirm identity, screen for safety, then scan', 'Report from a template and close critical results with the named clinician'];

function Forgot({ back }) {
  const [phone, setPhone] = useState(''); const [ch, setCh] = useState(null); const [code, setCode] = useState(''); const [pw, setPw] = useState(''); const [pw2, setPw2] = useState(''); const a = useAction();
  const send = () => a.run(async () => { setCh(await api.post('/auth/forgot', { phone })); toast('If the number belongs to an account, a code was sent'); });
  const reset = () => a.run(async () => { await api.post('/auth/reset', { challengeId: ch.challengeId, code, newPassword: pw }); toast('Password changed. Sign in with the new password.'); back(); });
  return (
    <div className="login-card">
      <h2>Forgot password</h2><p>Enter the mobile number on your account. We will send a 6-digit code.</p>
      <FormError error={a.error} />
      {!ch ? (<>
        <label><span>Mobile number</span><input inputMode="numeric" value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))} autoFocus /></label>
        <button className="btn btn-primary" disabled={a.busy || phone.length !== 10} onClick={send}>Send code</button></>
      ) : (<>
        {ch.devCode && <Notice>Demo mode: the code is <b>{ch.devCode}</b>.</Notice>}
        <label><span>6-digit code</span><input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} autoFocus /></label>
        <label><span>New password</span><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></label>
        <label><span>Repeat new password</span><input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" /></label>
        {pw2 && pw !== pw2 && <p className="note" style={{ color: 'var(--danger)' }}>Passwords do not match.</p>}
        <button className="btn btn-primary" disabled={a.busy || code.length !== 6 || !pw || pw !== pw2} onClick={reset}>Change password</button></>)}
      <button className="link-btn" style={{ marginTop: 12 }} onClick={back}>Back to sign in</button>
    </div>
  );
}

export default function Login({ onLogin }) {
  const [forgot, setForgot] = useState(false);
  const [username, setU] = useState(''); const [password, setP] = useState(''); const a = useAction();
  const submit = (e) => { e.preventDefault(); a.run(async () => onLogin(await api.post('/auth/login', { username, password }))); };

  return (
    <div className="login-page">
      <div className="login-brand">
        <img src="/stavya_logo.png" alt="Stavya Spine Hospital" />
        <h1>Radiology</h1>
        <p>One shared record between OPD, IPD, OT and the radiology department: requests, scans, reports and critical results.</p>
        <div className="login-flow">{FLOW.map((t, i) => <div key={t}><i>{i + 1}</i>{t}</div>)}</div>
      </div>
      <div className="login-panel">
        {forgot ? <Forgot back={() => setForgot(false)} /> : <form className="login-card" onSubmit={submit}>
          <h2>Sign in</h2>
          <p>Enter your employee code and password.</p>
          <FormError error={a.error} />
          <label><span>Employee code</span><input value={username} onChange={(e) => setU(e.target.value.toUpperCase())} placeholder="e.g. 301" inputMode="numeric" autoFocus autoComplete="username" autoCapitalize="characters" spellCheck={false} /></label>
          <label><span>Password</span><input type="password" value={password} onChange={(e) => setP(e.target.value)} autoComplete="current-password" /></label>
          <button className="btn btn-primary" disabled={a.busy || !username || !password}>{a.busy ? 'Signing in…' : 'Sign in'}</button>
          <button type="button" className="link-btn" onClick={() => setForgot(true)}>Forgot password?</button>
        </form>}
      </div>
    </div>
  );
}
