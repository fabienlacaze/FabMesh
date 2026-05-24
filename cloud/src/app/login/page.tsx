import { LoginForm } from './LoginForm';

export default function LoginPage() {
  return (
    <div className="page" style={{ maxWidth: 460 }}>
      <h2 style={{ textAlign: 'center', marginBottom: 8 }}>Welcome back</h2>
      <p style={{ textAlign: 'center', color: 'var(--text-2)', fontSize: 13, marginBottom: 24 }}>
        Sign in with your email and password to access your Cloud workspace.
      </p>
      <div className="card">
        <LoginForm />
      </div>
      <p style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: 12, marginTop: 16 }}>
        New here? Click <strong>Create an account</strong> to sign up with email + password.
      </p>
    </div>
  );
}
