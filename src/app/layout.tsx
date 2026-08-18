import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Drone Missions",
  description: "A two-sided drone-mission marketplace.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
