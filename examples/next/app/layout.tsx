import type { ReactNode } from "react";

export const metadata = { title: "authtempo Next.js example" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
