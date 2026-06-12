export const metadata = { title: 'Login with bkey — quickstart' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui', maxWidth: 480, margin: '10vh auto' }}>
        {children}
      </body>
    </html>
  );
}
