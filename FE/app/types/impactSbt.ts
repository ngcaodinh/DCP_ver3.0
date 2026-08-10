/** Trạng thái token on-chain mà API gallery public có thể trả về. */
export type ImpactSbtTokenStatus = 'ACTIVE' | 'FROZEN' | 'REVOKED' | 'BURNED';

/** DTO một SBT được trả về từ GET /api/sbt/gallery. */
export interface ImpactSbtGalleryEntry {
  onChainTokenId: number | null;
  projectId: string;
  projectName: string | null;
  milestone: number;
  beneficiaryCount: number;
  imageCid: string;
  imageGatewayUrl: string | null;
  onChainTokenStatus: ImpactSbtTokenStatus | null;
  // JSON serialize Date từ backend thành chuỗi ISO, không phải đối tượng Date.
  confirmedAt: string | null;
}

/** Thông tin phân trang do gallery API trả về. */
export interface ImpactSbtGalleryPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** Payload data trong envelope chuẩn của gallery API. */
export interface ImpactSbtGalleryResponse {
  entries: ImpactSbtGalleryEntry[];
  pagination: ImpactSbtGalleryPagination;
}
