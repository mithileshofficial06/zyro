import type {Metadata} from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Zyro Console",
  description:
    "The live reservation price of every position shipped to 1inch Aqua, and proof it matches the chain."
};

/**
 * @dev Fonts are loaded from Google rather than bundled through
 *      `next/font`, which fetches at build time — the console has to build in
 *      CI, where that fetch is a network dependency in a step that otherwise
 *      has none. Every family declares a real fallback stack, so a blocked
 *      request degrades to system type rather than to invisible text.
 */
export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Inter:wght@400;600;800&family=JetBrains+Mono:wght@400;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
