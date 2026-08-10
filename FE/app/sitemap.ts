import type { MetadataRoute } from 'next';

/** Hàm lấy URL gốc của website. Mục đích: đồng bộ domain cho sitemap trong mọi môi trường. */
function getSiteBaseUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL || 'https://dcp.example.com';
}

/** Hàm tạo danh sách sitemap. Mục đích: khai báo các trang quan trọng cần được search engine index. */
export default function sitemap(): MetadataRoute.Sitemap {
  const siteBaseUrl = getSiteBaseUrl();
  const currentTimestamp = new Date();

  return [
    {
      url: `${siteBaseUrl}/`,
      lastModified: currentTimestamp,
      changeFrequency: 'daily',
      priority: 1
    },
    {
      url: `${siteBaseUrl}/donations`,
      lastModified: currentTimestamp,
      changeFrequency: 'hourly',
      priority: 0.9
    },
    {
      url: `${siteBaseUrl}/impact-gallery`,
      lastModified: currentTimestamp,
      changeFrequency: 'daily',
      priority: 0.7
    },
    {
      url: `${siteBaseUrl}/organizations`,
      lastModified: currentTimestamp,
      changeFrequency: 'weekly',
      priority: 0.8
    },
    {
      url: `${siteBaseUrl}/login`,
      lastModified: currentTimestamp,
      changeFrequency: 'monthly',
      priority: 0.4
    },
    {
      url: `${siteBaseUrl}/register`,
      lastModified: currentTimestamp,
      changeFrequency: 'monthly',
      priority: 0.5
    }
  ];
}
