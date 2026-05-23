import { LoginForm } from './LoginForm';

export default function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  return (
    <div className="container" style={{ padding: '60px 0', maxWidth: 460 }}>
      <h1 style={{ textAlign: 'center' }}>Connexion</h1>
      <p className="muted" style={{ textAlign: 'center', marginBottom: 24 }}>
        On t'envoie un lien magique par e-mail. Pas de mot de passe à retenir.
      </p>
      <div className="card">
        <LoginForm />
      </div>
      <p className="dim" style={{ textAlign: 'center', fontSize: 13, marginTop: 16 }}>
        Inscription = même formulaire. Le compte est créé automatiquement.
      </p>
    </div>
  );
}
