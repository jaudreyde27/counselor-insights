import type { Metadata } from "next";
import "./globals.css";

const appName = process.env.APP_NAME ?? "International Student Counseling";

export const metadata: Metadata = {
  title: appName,
  description: "Prototype",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
