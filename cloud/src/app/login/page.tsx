import { LoginForm } from './LoginForm';

export default function LoginPage() {
  return (
    <div className="page" style={{ maxWidth: 460 }}>
      <h2 style={{ textAlign: 'center', marginBottom: 8 }}>Sign in</h2>
      <p style={{ textAlign: 'center', color: 'var(--text-2)', fontSize: 13, marginBottom: 24 }}>
        We send a magic link to your inbox — no password required.
      </p>
      <div className="card">
        <LoginForm />
      </div>
      <p style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: 12, marginTop: 16 }}>
        Signup uses the same form — your account is created automatically.
      </p>
    </div>
  );
}
