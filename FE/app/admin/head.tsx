/** Hàm head cho trang quản trị. Mục đích: chặn index khu vực quản trị và tránh search engine thu thập nội dung nội bộ. */
export default function Head() {
  return (
    <>
      <title>Quản trị hệ thống | DCP</title>
      <meta name="robots" content="noindex, nofollow, noarchive" />
      <link rel="canonical" href="/admin" />
    </>
  );
}
