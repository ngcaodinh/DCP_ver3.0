/** Hàm head cho trang unauthorized. Mục đích: chặn index trang lỗi phân quyền vì không mang giá trị SEO. */
export default function Head() {
  return (
    <>
      <title>Không có quyền truy cập | DCP</title>
      <meta name="robots" content="noindex, nofollow, noarchive" />
      <link rel="canonical" href="/unauthorized" />
    </>
  );
}
