/** Hàm head cho trang đăng nhập. Mục đích: chặn index các trang xác thực để tránh nội dung mỏng trên công cụ tìm kiếm. */
export default function Head() {
  return (
    <>
      <title>Đăng nhập | DCP</title>
      <meta name="robots" content="noindex, nofollow, noarchive" />
      <link rel="canonical" href="/login" />
    </>
  );
}
