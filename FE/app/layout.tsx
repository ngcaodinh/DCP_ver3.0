import './globals.css';
import Script from 'next/script';
import { Be_Vietnam_Pro, Lexend } from 'next/font/google';
import type { Metadata, Viewport } from 'next';
import AuthSessionManager from './components/AuthSessionManager';
import { GuestWalletProvider } from './components/GuestWalletProvider';
import { QueryClientProviderWrapper } from './providers';

const beVietnamProFont = Be_Vietnam_Pro({
  subsets: ['latin', 'vietnamese'],
  weight: ['300', '400', '500', '600', '700', '800'],
  variable: '--font-be-vietnam-pro'
});

const lexendFont = Lexend({
  subsets: ['latin', 'vietnamese'],
  weight: ['300', '400', '500', '600'],
  variable: '--font-lexend'
});

/** Hàm lấy URL gốc của website. Mục đích: dùng thống nhất cho canonical, sitemap và structured data. */
function getSiteBaseUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL || 'https://dcp.example.com';
}

/** Hàm tạo structured data cho website. Mục đích: giúp search engine hiểu rõ thông tin thương hiệu và khả năng tìm kiếm nội bộ. */
function buildWebsiteStructuredData() {
  const siteBaseUrl = getSiteBaseUrl();

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${siteBaseUrl}/#organization`,
        name: 'DCP',
        alternateName: 'Decentralized Charity Platform',
        url: siteBaseUrl,
        logo: `${siteBaseUrl}/og-image.png`,
        description:
          'Nền tảng từ thiện phi tập trung tại Việt Nam, minh bạch hóa quy trình quyên góp bằng Blockchain.',
        sameAs: ['https://zalo.me/0367400325']
      },
      {
        '@type': 'WebSite',
        '@id': `${siteBaseUrl}/#website`,
        url: siteBaseUrl,
        name: 'DCP — Nền tảng Từ thiện Phi tập trung',
        inLanguage: 'vi-VN',
        publisher: {
          '@id': `${siteBaseUrl}/#organization`
        },
        potentialAction: {
          '@type': 'SearchAction',
          target: `${siteBaseUrl}/donations?keyword={search_term_string}`,
          'query-input': 'required name=search_term_string'
        }
      }
    ]
  };
}

export const metadata: Metadata = {
  metadataBase: new URL(getSiteBaseUrl()),
  title: {
    default: 'DCP — Nền tảng Từ thiện Phi tập trung',
    template: '%s | DCP'
  },
  description:
    'DCP — Nền tảng từ thiện phi tập trung đầu tiên tại Việt Nam. Quyên góp minh bạch trên Blockchain, giám sát on-chain, bảo mật ERC-4337.',
  keywords: [
    'từ thiện',
    'blockchain',
    'phi tập trung',
    'quyên góp',
    'minh bạch',
    'DCP',
    'Decentralized Charity Platform',
    'Việt Nam',
    'Web3',
    'Polygon'
  ],
  authors: [{ name: 'DCP Team' }],
  creator: 'DCP Team',
  publisher: 'DCP — Decentralized Charity Platform',
  alternates: {
    canonical: '/'
  },
  openGraph: {
    type: 'website',
    locale: 'vi_VN',
    siteName: 'DCP — Nền tảng Từ thiện Phi tập trung',
    title: 'DCP — Nền tảng Từ thiện Phi tập trung',
    description:
      'Quyên góp minh bạch trên Blockchain. Giám sát on-chain, không gian lận, bảo mật ERC-4337.',
    url: '/',
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'DCP — Decentralized Charity Platform'
      }
    ]
  },
  twitter: {
    card: 'summary_large_image',
    title: 'DCP — Nền tảng Từ thiện Phi tập trung',
    description:
      'Quyên góp minh bạch trên Blockchain. Giám sát on-chain, không gian lận, bảo mật ERC-4337.',
    images: ['/og-image.png']
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1
    }
  },
  verification: {
    google: process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION || undefined
  }
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover'
};

/**
 * Hàm layout gốc của ứng dụng FE.
 * Mục đích: bọc toàn bộ trang bằng cấu trúc HTML, SEO metadata và font chuẩn Next.js.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <body className={`${beVietnamProFont.variable} ${lexendFont.variable} overflow-x-hidden`}>
        <Script
          id="website-structured-data"
          type="application/ld+json"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(buildWebsiteStructuredData())
          }}
        />
        <QueryClientProviderWrapper>
          <GuestWalletProvider>
            {children}
          </GuestWalletProvider>
        </QueryClientProviderWrapper>
        <AuthSessionManager />
      </body>
      <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" />
    </html>
  );
}
