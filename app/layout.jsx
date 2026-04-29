import "./globals.css";

export const metadata = {
  title: "NSE Options Scanner",
  description: "Real-time NSE F&O gainers, losers and options chain scanner powered by Upstox",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <div className="app-container">{children}</div>
      </body>
    </html>
  );
}
