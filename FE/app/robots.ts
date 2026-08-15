import type { MetadataRoute } from 'next';

/** Hàm lấy URL gốc của website. Mục đích: dùng lại cho robots sitemap để tránh sai lệch domain. */
function getSiteBaseUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL || 'https://dcp.example.com';
}

/** Hàm tạo robots.txt. Mục đích: điều hướng bot index các trang công khai và chặn trang không nên lên SERP. */
export default function robots(): MetadataRoute.Robots {
  const siteBaseUrl = getSiteBaseUrl();

  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/', '/donations', '/organizations', '/impact-gallery'],
        disallow: ['/admin', '/login', '/register', '/unauthorized', '/deposit', '/donors', '/regulatory-bodies', '/feedback']
      }
    ],
    sitemap: `${siteBaseUrl}/sitemap.xml`,
    host: siteBaseUrl
  };
}
