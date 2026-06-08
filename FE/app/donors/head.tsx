/** Hàm head cho trang donors. Mục đích: chặn index trang nội bộ chưa phục vụ mục tiêu SEO công khai. */
export default function Head() {
  return (
    <>
      <title>Nhà hảo tâm | DCP</title>
      <meta name="robots" content="noindex, nofollow, noarchive" />
      <link rel="canonical" href="/donors" />
    </>
  );
}
