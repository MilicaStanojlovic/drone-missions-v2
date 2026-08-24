import type { Metadata } from "next";
import { IBM_Plex_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";

/**
 * The two typefaces the design canvas (`design/DroneMissions.dc.html`) and
 * the Angular original (`src/styles.css`, `login.component.css`) specify:
 * Space Grotesk for body copy, IBM Plex Mono for the wordmark and
 * mono/label accents. Exposed as CSS variables that `globals.css`'s
 * `@theme inline` block maps onto Tailwind's `font-sans`/`font-mono`.
 */
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-space-grotesk",
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-ibm-plex-mono",
});

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
    <html lang="en" className={`${spaceGrotesk.variable} ${ibmPlexMono.variable}`}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
