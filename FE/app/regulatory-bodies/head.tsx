/** Hàm head cho trang regulatory bodies. Mục đích: chặn index màn hình nghiệp vụ kiểm soát dành cho vai trò đặc thù. */
export default function Head() {
  return (
    <>
      <title>Cơ quan quản lý | DCP</title>
      <meta name="robots" content="noindex, nofollow, noarchive" />
      <link rel="canonical" href="/regulatory-bodies" />
    </>
  );
}
