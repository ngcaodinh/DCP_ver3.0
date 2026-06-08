/** Hàm head cho trang đăng ký. Mục đích: chặn index trang chuyển đổi nội bộ không cần SEO. */
export default function Head() {
  return (
    <>
      <title>Đăng ký tài khoản | DCP</title>
      <meta name="robots" content="noindex, nofollow, noarchive" />
      <link rel="canonical" href="/register" />
    </>
  );
}
