const { withSentryConfig } = require('@sentry/nextjs');

/**
 * Parse origin từ URL string, trả về fallback nếu URL không hợp lệ hoặc không thể parse.
 * Ngăn crash build khi env var bị misconfigure (ví dụ: "localhost:4000" thiếu protocol).
 * @param {string | undefined} envValue
 * @param {string} fallback
 * @returns {string}
 */
function safeGetOrigin(envValue, fallback) {
  if (!envValue) {
    return fallback;
  }
  try {
    return new URL(envValue).origin;
  } catch {
    return fallback;
  }
}

/**
 * Xây dựng CSP header cho /donate route. Gom tất cả domain whitelisted
 * vào một directive duy nhất để tránh lỗi browser chỉ dùng directive cuối cùng.
 * @param {string} apiOrigin
 * @param {string} siteOrigin
 * @returns {string}
 */
function buildDonateCsp(apiOrigin, siteOrigin) {
  const connectSrcParts = ["'self'"];
  connectSrcParts.push(apiOrigin);
  if (siteOrigin) {
    // Bỏ qua empty string: khi NEXT_PUBLIC_SITE_URL không được set, safeGetOrigin trả về ''.
    // Empty string không phải origin hợp lệ và không nên thêm vào CSP directive.
    connectSrcParts.push(siteOrigin);
  }
  connectSrcParts.push('https://*.zerodev.app', 'https://*.polygonscan.com', 'https://*.polygon.technology');

  // PayOS iframe (payment modal) + Google OAuth (claim flow)
  const frameSrcParts = ["'self'", 'https://*.payos.vn', 'https://api-merchant.payos.vn', 'https://accounts.google.com'];

  // 'self' + Google (GIS scripts). unsafe-inline cho các script nội tuyến của Next.js:
  // __NEXT_DATA__, hydration markers được inject bởi Next.js bundler.
  // Dùng strict-dynamic + nonce là giải pháp chuẩn hơn nhưng cần middleware tạo nonce.
  // Hiện tại chấp nhận đánh đổi dùng unsafe-inline vì nguồn script đã được lập danh sách cho phép rõ ràng.
  const scriptSrcParts = ["'self'", 'https://accounts.google.com'];
  if (isDev) {
    scriptSrcParts.push("'unsafe-eval'");
  } else {
    scriptSrcParts.push("'unsafe-inline'");
  }

  // img-src: Origins không dùng single-quote (chỉ keywords như 'self' và 'none' dùng)
  const imgSrcPart = siteOrigin
    ? `img-src 'self' data: blob: ${siteOrigin}`
    : "img-src 'self' data: blob:";

  return [
    "default-src 'self'",
    "frame-ancestors 'none'",  // Ngăn clickjacking — supersedes X-Frame-Options trên browser hiện đại
    `connect-src ${connectSrcParts.join(' ')}`,
    `frame-src ${frameSrcParts.join(' ')}`,
    `script-src ${scriptSrcParts.join(' ')}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",  // unsafe-inline cần cho Tailwind CSS utility classes inject runtime bởi Next.js
    "font-src 'self' https://fonts.gstatic.com",
    imgSrcPart,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; ');
}

const DEFAULT_API_ORIGIN = 'http://localhost:4000';
const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || DEFAULT_API_ORIGIN;
const apiOrigin = safeGetOrigin(apiBaseUrl, DEFAULT_API_ORIGIN);
const siteOrigin = safeGetOrigin(process.env.NEXT_PUBLIC_SITE_URL, '');
const isDev = process.env.NODE_ENV !== 'production';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  poweredByHeader: false,
  compress: true,
  // Next 14 cần cờ này để gọi instrumentation.ts.
  experimental: {
    instrumentationHook: true
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff'
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY'
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin'
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()'
          },
          {
            key: 'X-Permitted-Cross-Domain-Policies',
            value: 'none'
          }
        ]
      },
      {
        source: '/donate(/:path*)?',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: buildDonateCsp(apiOrigin, siteOrigin)
          },
          {
            key: 'Cache-Control',
            value: 'no-store'
          }
        ]
      },
      {
        // Trang feedback chứa ticket theo từng lượt mở; bắt buộc no-store để CDN không phát lại ticket cũ.
        source: '/feedback(/:path*)?',
        headers: [
          {
            key: 'Cache-Control',
            value: 'no-store'
          }
        ]
      },
      {
        // Cổng FOUNDATION là form một lần và không được CDN giữ lại trạng thái hoặc payload cũ.
        source: '/foundation-kyc',
        headers: [
          {
            key: 'Cache-Control',
            value: 'no-store'
          }
        ]
      },
      {
        // Static pages — không bao gồm /donate vì donate có wallet state (không nên cache trên CDN)
        // Tunnel không được dính Cache-Control public vì đây là endpoint ingest động.
        source: '/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|donate|feedback|sentry-tunnel).*)',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, s-maxage=300, stale-while-revalidate=86400'
          }
        ]
      },
      {
        source: '/_next/static/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable'
          }
        ]
      }
    ];
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${apiOrigin}/api/:path*`
      }
    ];
  }
};

module.exports = withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  // Tunnel same-origin giúp CSP /donate và ad-blocker không chặn event.
  tunnelRoute: '/sentry-tunnel',
  widenClientFileUpload: true,
  sourcemaps: {
    deleteSourcemapsAfterUpload: true
  },
  silent: !process.env.CI,
  telemetry: false
});
