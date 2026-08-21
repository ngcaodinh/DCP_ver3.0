export const MAP_TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';
export const MAP_MIN_ZOOM = 5;
export const MAP_MAX_ZOOM = 19;
export const ADMINISTRATIVE_BOUNDARY_MAX_ZOOM = 16;
export const ADMINISTRATIVE_BOUNDARY_ATTRIBUTION = 'Địa giới hành chính © <a href="https://sapnhap.bando.com.vn/">Nhà xuất bản Tài nguyên - Môi trường và Bản đồ Việt Nam</a>';

/** Lấy URL tile cùng origin để Next.js rewrite request sang backend proxy thay vì browser gọi API/provider trực tiếp. */
export function getMapTileUrl(): string {
  return '/api/tiles/{z}/{x}/{y}.png';
}

/** Lấy URL tile proxy cho lớp địa giới và tên tỉnh/thành sau sáp nhập. */
export function getAdministrativeBoundaryTileUrl(): string {
  return '/api/tiles/administrative/{z}/{x}/{y}.png';
}
