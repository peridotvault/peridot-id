import Link from 'next/link';

export default function HomePage() {
  return (
    <main
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        textAlign: 'center',
        justifyContent: 'center',
        alignItems: 'center',
        gap: '1rem',
      }}
    >
      <h1 style={{ fontSize: '2.5rem', fontWeight: 'bold', margin: 0 }}>Peridot ID</h1>
      <p style={{ fontSize: '1.15rem', maxWidth: '36rem', opacity: 0.85 }}>
        One gaming identity for the whole Peridot ecosystem — Google sign-in, session
        management, and profiles across every product.
      </p>
      <div style={{ display: 'flex', gap: '0.75rem' }}>
        <Link
          href="/docs"
          style={{ fontWeight: '600', textDecoration: 'underline' }}
        >
          Read the docs
        </Link>
        <Link
          href="/docs/api/auth"
          style={{ fontWeight: '600', textDecoration: 'underline', opacity: 0.7 }}
        >
          API reference
        </Link>
      </div>
    </main>
  );
}
