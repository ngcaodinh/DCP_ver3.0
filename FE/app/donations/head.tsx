/** Hàm head cho trang danh sách dự án. Mục đích: khai báo SEO metadata cho trang donations mà không ảnh hưởng client component. */
export default function Head() {
  return (
    <>
      <title>Dự án đang gây quỹ | DCP</title>
      <meta
        name="description"
        content="Theo dõi và ủng hộ các dự án từ thiện đang gây quỹ trên DCP với dữ liệu minh bạch và cập nhật theo thời gian thực."
      />
      <link rel="canonical" href="/donations" />
      <meta property="og:title" content="Dự án đang gây quỹ | DCP" />
      <meta
        property="og:description"
        content="Theo dõi và ủng hộ các dự án từ thiện đang gây quỹ trên DCP với dữ liệu minh bạch và cập nhật theo thời gian thực."
      />
      <meta property="og:url" content="/donations" />
    </>
  );
}
