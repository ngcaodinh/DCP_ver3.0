import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import {
  createUploadValidationMiddleware,
  createBatchUploadValidationMiddleware,
  createCsvRowCountValidationMiddleware,
  MAX_CSV_ROWS,
  UPLOAD_ALLOWED_MIME_TYPES
} from '../../middleware/upload-validation.middleware';

vi.mock('../../config/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

describe('upload-validation.middleware', () => {

  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let nextFunction: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequest = { file: undefined, files: undefined };
    mockResponse = {
      status: vi.fn().mockReturnThis() as Response['status'],
      json: vi.fn().mockReturnThis() as Response['json']
    };
    nextFunction = vi.fn();
  });

  // =========================================================================
  // createUploadValidationMiddleware
  // =========================================================================
  describe('createUploadValidationMiddleware', () => {

    // -------------------------------------------------------------------------
    // No file → pass through
    // -------------------------------------------------------------------------
    describe('no file in request', () => {
      it('gọi next() và không set validatedFile khi không có file', () => {
        mockRequest.file = undefined;

        const middleware = createUploadValidationMiddleware('image');
        middleware(mockRequest as Request, mockResponse as Response, nextFunction);

        expect(nextFunction).toHaveBeenCalledTimes(1);
        expect((mockRequest as Request).validatedFile).toBeUndefined();
      });
    });

    // -------------------------------------------------------------------------
    // Valid JPEG image
    // -------------------------------------------------------------------------
    describe('valid JPEG image', () => {
      it('pass validation và gắn validatedFile với JPEG detected', () => {
        // JPEG signature: FFD8FFE0
        const jpegBuffer = Buffer.from([
          0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46,
          0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01
        ]);

        mockRequest.file = {
          fieldname: 'evidence',
          originalname: 'photo.jpg',
          encoding: '7bit',
          mimetype: 'image/jpeg',
          buffer: jpegBuffer,
          size: 16,
          destination: '',
          filename: '',
          path: '',
          stream: null as never
        };

        const middleware = createUploadValidationMiddleware('image');
        middleware(mockRequest as Request, mockResponse as Response, nextFunction);

        expect(nextFunction).toHaveBeenCalledTimes(1);
        expect((mockRequest as Request).validatedFile).toMatchObject({
          originalName: 'photo.jpg',
          fieldName: 'evidence',
          declaredMimeType: 'image/jpeg',
          detectedMimeType: 'image/jpeg',
          detectedExtension: 'jpg',
          isValid: true,
          errorCode: undefined
        });
      });
    });

    // -------------------------------------------------------------------------
    // Valid PNG image
    // -------------------------------------------------------------------------
    describe('valid PNG image', () => {
      it('pass validation với PNG signature', () => {
        const pngBuffer = Buffer.from([
          0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
          0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52
        ]);

        mockRequest.file = {
          fieldname: 'evidence',
          originalname: 'proof.png',
          encoding: '7bit',
          mimetype: 'image/png',
          buffer: pngBuffer,
          size: 16,
          destination: '',
          filename: '',
          path: '',
          stream: null as never
        };

        const middleware = createUploadValidationMiddleware('image');
        middleware(mockRequest as Request, mockResponse as Response, nextFunction);

        expect(nextFunction).toHaveBeenCalledTimes(1);
        expect((mockRequest as Request).validatedFile?.isValid).toBe(true);
        expect((mockRequest as Request).validatedFile?.detectedMimeType).toBe('image/png');
      });
    });

    // -------------------------------------------------------------------------
    // Valid CSV
    // -------------------------------------------------------------------------
    describe('valid CSV text', () => {
      it('pass validation với CSV text content', () => {
        const csvBuffer = Buffer.from('name,amount,status\nFood Bank,5000000,VND');

        mockRequest.file = {
          fieldname: 'feedback',
          originalname: 'export.csv',
          encoding: '7bit',
          mimetype: 'text/csv',
          buffer: csvBuffer,
          size: csvBuffer.length,
          destination: '',
          filename: '',
          path: '',
          stream: null as never
        };

        const middleware = createUploadValidationMiddleware('csv');
        middleware(mockRequest as Request, mockResponse as Response, nextFunction);

        expect(nextFunction).toHaveBeenCalledTimes(1);
        expect((mockRequest as Request).validatedFile?.isValid).toBe(true);
        expect((mockRequest as Request).validatedFile?.detectedMimeType).toBe('text/csv');
      });
    });

    // -------------------------------------------------------------------------
    // File too large
    // -------------------------------------------------------------------------
    describe('file size exceeds limit', () => {
      it('trả về 413 khi file JPEG vượt 10MB', () => {
        // JPEG signature trong buffer để pass magic bytes check
        const largeBuffer = Buffer.alloc(11 * 1024 * 1024); // 11MB
        largeBuffer[0] = 0xFF;
        largeBuffer[1] = 0xD8;
        largeBuffer[2] = 0xFF;
        largeBuffer[3] = 0xE0;

        mockRequest.file = {
          fieldname: 'evidence',
          originalname: 'huge.jpg',
          encoding: '7bit',
          mimetype: 'image/jpeg',
          buffer: largeBuffer,
          size: 11 * 1024 * 1024,
          destination: '',
          filename: '',
          path: '',
          stream: null as never
        };

        const middleware = createUploadValidationMiddleware('image');
        middleware(mockRequest as Request, mockResponse as Response, nextFunction);

        expect(nextFunction).not.toHaveBeenCalled();
        expect(mockResponse.status).toHaveBeenCalledWith(413);
        expect(mockResponse.json).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            errorCode: 'PAYLOAD_TOO_LARGE'
          })
        );
      });

      it('trả về 413 khi file CSV vượt 5MB', () => {
        const largeBuffer = Buffer.alloc(6 * 1024 * 1024); // 6MB
        largeBuffer.write('name,amount\n');
        largeBuffer[0] = 0x6E; // 'n'

        mockRequest.file = {
          fieldname: 'feedback',
          originalname: 'huge.csv',
          encoding: '7bit',
          mimetype: 'text/csv',
          buffer: largeBuffer,
          size: 6 * 1024 * 1024,
          destination: '',
          filename: '',
          path: '',
          stream: null as never
        };

        const middleware = createUploadValidationMiddleware('csv');
        middleware(mockRequest as Request, mockResponse as Response, nextFunction);

        expect(nextFunction).not.toHaveBeenCalled();
        expect(mockResponse.status).toHaveBeenCalledWith(413);
      });
    });

    // -------------------------------------------------------------------------
    // Unsupported file type (magic bytes mismatch)
    // -------------------------------------------------------------------------
    describe('unsupported file type via magic bytes', () => {
      it('trả về 415 khi file là EXE (MZ header)', () => {
        const exeBuffer = Buffer.from([
          0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00,
          0x04, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0x00, 0x00
        ]);

        mockRequest.file = {
          fieldname: 'evidence',
          originalname: 'malware.exe',
          encoding: '7bit',
          mimetype: 'image/jpeg', // spoofed
          buffer: exeBuffer,
          size: 16,
          destination: '',
          filename: '',
          path: '',
          stream: null as never
        };

        const middleware = createUploadValidationMiddleware('image');
        middleware(mockRequest as Request, mockResponse as Response, nextFunction);

        expect(nextFunction).not.toHaveBeenCalled();
        expect(mockResponse.status).toHaveBeenCalledWith(415);
        expect(mockResponse.json).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            errorCode: 'UNSUPPORTED_MEDIA_TYPE'
          })
        );
      });

      it('trả về 415 khi file là PDF (not in allowlist)', () => {
        const pdfBuffer = Buffer.from([
          0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34,
          0x0A, 0x25, 0xC7, 0xEC, 0x8F, 0xA2, 0xB1, 0x8A
        ]);

        mockRequest.file = {
          fieldname: 'document',
          originalname: 'report.pdf',
          encoding: '7bit',
          mimetype: 'application/pdf',
          buffer: pdfBuffer,
          size: 16,
          destination: '',
          filename: '',
          path: '',
          stream: null as never
        };

        const middleware = createUploadValidationMiddleware('image');
        middleware(mockRequest as Request, mockResponse as Response, nextFunction);

        expect(nextFunction).not.toHaveBeenCalled();
        expect(mockResponse.status).toHaveBeenCalledWith(415);
      });
    });

    // -------------------------------------------------------------------------
    // Magic bytes override declared MIME type
    // -------------------------------------------------------------------------
    describe('magic bytes detection overrides declared MIME type', () => {
      it('phát hiện file thực sự là JPEG dù declared là PNG', () => {
        // JPEG signature nhưng declared PNG
        const fakePngBuffer = Buffer.from([
          0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46,
          0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01
        ]);

        mockRequest.file = {
          fieldname: 'evidence',
          originalname: 'photo.png',
          encoding: '7bit',
          mimetype: 'image/png', // declared
          buffer: fakePngBuffer,
          size: 16,
          destination: '',
          filename: '',
          path: '',
          stream: null as never
        };

        const middleware = createUploadValidationMiddleware('image');
        middleware(mockRequest as Request, mockResponse as Response, nextFunction);

        expect(nextFunction).toHaveBeenCalledTimes(1);
        expect((mockRequest as Request).validatedFile?.detectedMimeType).toBe('image/jpeg');
        expect((mockRequest as Request).validatedFile?.declaredMimeType).toBe('image/png');
      });
    });
  });

  // =========================================================================
  // createBatchUploadValidationMiddleware
  // =========================================================================
  describe('createBatchUploadValidationMiddleware', () => {

    it('gọi next() khi không có files', () => {
      mockRequest.files = undefined;

      const middleware = createBatchUploadValidationMiddleware('image');
      middleware(mockRequest as Request, mockResponse as Response, nextFunction);

      expect(nextFunction).toHaveBeenCalledTimes(1);
    });

    it('gọi next() khi files là mảng rỗng', () => {
      mockRequest.files = [];

      const middleware = createBatchUploadValidationMiddleware('image');
      middleware(mockRequest as Request, mockResponse as Response, nextFunction);

      expect(nextFunction).toHaveBeenCalledTimes(1);
    });

    it('pass validation khi tất cả files hợp lệ', () => {
      const jpegBuffer = Buffer.from([
        0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46
      ]);
      const pngBuffer = Buffer.from([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A
      ]);

      mockRequest.files = [
        {
          fieldname: 'file1',
          originalname: 'photo1.jpg',
          encoding: '7bit',
          mimetype: 'image/jpeg',
          buffer: jpegBuffer,
          size: 8,
          destination: '',
          filename: '',
          path: '',
          stream: null as never
        },
        {
          fieldname: 'file2',
          originalname: 'photo2.png',
          encoding: '7bit',
          mimetype: 'image/png',
          buffer: pngBuffer,
          size: 8,
          destination: '',
          filename: '',
          path: '',
          stream: null as never
        }
      ];

      const middleware = createBatchUploadValidationMiddleware('image');
      middleware(mockRequest as Request, mockResponse as Response, nextFunction);

      expect(nextFunction).toHaveBeenCalledTimes(1);
      expect((mockRequest as Request).validatedFiles).toHaveLength(2);
      expect((mockRequest as Request).validatedFiles?.[0].isValid).toBe(true);
      expect((mockRequest as Request).validatedFiles?.[1].isValid).toBe(true);
    });

    it('trả về 415 khi bất kỳ file nào trong batch không hợp lệ', () => {
      const jpegBuffer = Buffer.from([
        0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46
      ]);
      const exeBuffer = Buffer.from([
        0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00
      ]);

      mockRequest.files = [
        {
          fieldname: 'file1',
          originalname: 'valid.jpg',
          encoding: '7bit',
          mimetype: 'image/jpeg',
          buffer: jpegBuffer,
          size: 8,
          destination: '',
          filename: '',
          path: '',
          stream: null as never
        },
        {
          fieldname: 'file2',
          originalname: 'malware.exe',
          encoding: '7bit',
          mimetype: 'application/octet-stream',
          buffer: exeBuffer,
          size: 8,
          destination: '',
          filename: '',
          path: '',
          stream: null as never
        }
      ];

      const middleware = createBatchUploadValidationMiddleware('image');
      middleware(mockRequest as Request, mockResponse as Response, nextFunction);

      expect(nextFunction).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(415);
      expect((mockRequest as Request).validatedFiles).toBeDefined();
    });

    it('gắn validatedFiles vào request khi pass validation', () => {
      const csvBuffer = Buffer.from('name,amount\nTest,100');

      mockRequest.files = [
        {
          fieldname: 'batch',
          originalname: 'data.csv',
          encoding: '7bit',
          mimetype: 'text/csv',
          buffer: csvBuffer,
          size: csvBuffer.length,
          destination: '',
          filename: '',
          path: '',
          stream: null as never
        }
      ];

      const middleware = createBatchUploadValidationMiddleware('csv');
      middleware(mockRequest as Request, mockResponse as Response, nextFunction);

      expect(nextFunction).toHaveBeenCalledTimes(1);
      expect((mockRequest as Request).validatedFiles).toBeDefined();
      expect((mockRequest as Request).validatedFiles?.[0].index).toBe(0);
    });
  });

  // =========================================================================
  // createCsvRowCountValidationMiddleware
  // =========================================================================
  describe('createCsvRowCountValidationMiddleware', () => {
    it('gọi next() khi row count <= MAX_CSV_ROWS', () => {
      const middleware = createCsvRowCountValidationMiddleware(500);
      middleware(mockRequest as Request, mockResponse as Response, nextFunction);

      expect(nextFunction).toHaveBeenCalledTimes(1);
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it('gọi next() khi row count = MAX_CSV_ROWS (1000)', () => {
      const middleware = createCsvRowCountValidationMiddleware(MAX_CSV_ROWS);
      middleware(mockRequest as Request, mockResponse as Response, nextFunction);

      expect(nextFunction).toHaveBeenCalledTimes(1);
    });

    it('trả về 413 khi row count > MAX_CSV_ROWS', () => {
      const middleware = createCsvRowCountValidationMiddleware(1001);
      middleware(mockRequest as Request, mockResponse as Response, nextFunction);

      expect(nextFunction).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(413);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          errorCode: 'PAYLOAD_TOO_LARGE'
        })
      );
    });

    it('trả về 413 khi row count = 2000 (2x limit)', () => {
      const middleware = createCsvRowCountValidationMiddleware(2000);
      middleware(mockRequest as Request, mockResponse as Response, nextFunction);

      expect(nextFunction).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(413);
    });
  });

  // =========================================================================
  // Constants
  // =========================================================================
  describe('constants', () => {
    it('UPLOAD_ALLOWED_MIME_TYPES khớp với service ALLOWED_MIME_TYPES', () => {
      expect(UPLOAD_ALLOWED_MIME_TYPES).toContain('image/jpeg');
      expect(UPLOAD_ALLOWED_MIME_TYPES).toContain('image/png');
      expect(UPLOAD_ALLOWED_MIME_TYPES).toContain('image/webp');
      expect(UPLOAD_ALLOWED_MIME_TYPES).toContain('text/csv');
      expect(UPLOAD_ALLOWED_MIME_TYPES).toContain('application/json');
    });

    it('MAX_CSV_ROWS = 1000', () => {
      expect(MAX_CSV_ROWS).toBe(1000);
    });
  });
});
