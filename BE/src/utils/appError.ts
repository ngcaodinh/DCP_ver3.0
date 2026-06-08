/**
 * Lớp lỗi ứng dụng chuẩn hóa — hỗ trợ HTTP status code.
 * Mục đích: giúp Express Error Handler nhận diện được HTTP status tương ứng
 * thay vì phải parse error message.
 */
export class AppError extends Error {
  constructor(message: string, public statusCode: number = 500) {
    super(message);
    this.name = 'AppError';
  }
}
