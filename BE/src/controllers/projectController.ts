import { Response } from 'express';
import { getLogger } from '../config/logger';
import { AuthenticatedRequest } from '../middleware/authenticationMiddleware';
import {
  createProjectForOrganization,
  getCreateProjectEligibilityForOrganization,
  getPendingApprovalProjectsForReviewer,
  getProjectsForOrganization,
  getPublicSupportProjectDetail,
  getPublicSupportProjects,
  reviewProjectByReviewer,
  submitProjectForApproval,
  updateProjectForOrganization,
  uploadProjectEvidencesForOrganization
} from '../services/projectService';
import { sendErrorFromUnknown, sendErrorResponse, sendSuccessResponse } from '../utils/apiResponse';
import {
  validateCreateProjectRequestBody,
  validateReviewProjectRequestBody,
  validateSubmitProjectRequestBody,
  validateUpdateProjectRequestBody,
  validateUploadProjectEvidencesRequestBody
} from '../validators/projectValidator';

const logger = getLogger();

/** Hàm xử lý request tạo dự án mới. Mục đích: kiểm tra xác thực, validate payload và trả response chuẩn hóa. */
export async function handleCreateProject(request: AuthenticatedRequest, response: Response): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.', 'UNAUTHENTICATED');
    return;
  }

  const validationResult = validateCreateProjectRequestBody(request.body);
  if (!validationResult.isValid || !validationResult.data) {
    sendErrorResponse(response, 400, 'Dữ liệu dự án không hợp lệ.', 'VALIDATION_ERROR', validationResult.errors);
    return;
  }

  try {
    const createResult = await createProjectForOrganization(request.authenticatedUser.userId, validationResult.data);
    sendSuccessResponse(response, 201, 'Tạo dự án thành công.', createResult);
  } catch (error) {
    logger.error('Tạo dự án thất bại.', { errorMessage: (error as Error).message });
    sendErrorFromUnknown(response, error, 'Không thể tạo dự án mới.');
  }
}

/** Hàm xử lý request lấy danh sách dự án của tổ chức. Mục đích: trả dữ liệu thật phục vụ trang quản lý dự án. */
export async function handleGetOrganizationProjects(request: AuthenticatedRequest, response: Response): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.', 'UNAUTHENTICATED');
    return;
  }

  try {
    const projects = await getProjectsForOrganization(request.authenticatedUser.userId);
    sendSuccessResponse(response, 200, 'Lấy danh sách dự án thành công.', projects);
  } catch (error) {
    logger.error('Lấy danh sách dự án thất bại.', { errorMessage: (error as Error).message });
    sendErrorFromUnknown(response, error, 'Không thể lấy danh sách dự án.');
  }
}

/** Hàm xử lý request kiểm tra điều kiện tạo dự án. Mục đích: trả trạng thái eligibility để frontend chủ động khóa nút tạo dự án. */
export async function handleGetCreateProjectEligibility(request: AuthenticatedRequest, response: Response): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.', 'UNAUTHENTICATED');
    return;
  }

  try {
    const eligibilityResult = await getCreateProjectEligibilityForOrganization(request.authenticatedUser.userId);
    sendSuccessResponse(response, 200, 'Lấy trạng thái điều kiện tạo dự án thành công.', eligibilityResult);
  } catch (error) {
    logger.error('Lấy trạng thái điều kiện tạo dự án thất bại.', { errorMessage: (error as Error).message });
    sendErrorFromUnknown(response, error, 'Không thể kiểm tra điều kiện tạo dự án.');
  }
}

/** Hàm xử lý request lấy danh sách dự án public cần hỗ trợ. Mục đích: trả dữ liệu thật cho trang Home mà không cần đăng nhập. */
export async function handleGetPublicSupportProjects(request: AuthenticatedRequest, response: Response): Promise<void> {
  const parsedLimitCount = Number(request.query.limit);

  try {
    const publicProjects = await getPublicSupportProjects(parsedLimitCount);
    sendSuccessResponse(response, 200, 'Lấy danh sách dự án cần hỗ trợ thành công.', publicProjects);
  } catch (error) {
    logger.error('Lấy danh sách dự án cần hỗ trợ thất bại.', { errorMessage: (error as Error).message });
    sendErrorFromUnknown(response, error, 'Không thể lấy danh sách dự án cần hỗ trợ.');
  }
}

/** Hàm xử lý request lấy chi tiết dự án public theo projectId. Mục đích: trả dữ liệu thật cho modal chi tiết ở Home. */
export async function handleGetPublicSupportProjectDetail(request: AuthenticatedRequest, response: Response): Promise<void> {
  const { projectId } = request.params;

  try {
    const projectDetail = await getPublicSupportProjectDetail(projectId);

    if (!projectDetail) {
      sendSuccessResponse(response, 200, 'Không tìm thấy chi tiết dự án cần hỗ trợ.', null);
      return;
    }

    sendSuccessResponse(response, 200, 'Lấy chi tiết dự án cần hỗ trợ thành công.', projectDetail);
  } catch (error) {
    logger.error('Lấy chi tiết dự án cần hỗ trợ thất bại.', { errorMessage: (error as Error).message });
    sendErrorFromUnknown(response, error, 'Không thể lấy chi tiết dự án cần hỗ trợ.');
  }
}


/** Hàm xử lý request lấy danh sách dự án chờ duyệt cho reviewer. Mục đích: trả dữ liệu thật cho màn hình “Duyệt dự án mới”. */
export async function handleGetPendingApprovalProjects(request: AuthenticatedRequest, response: Response): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.', 'UNAUTHENTICATED');
    return;
  }

  try {
    const projects = await getPendingApprovalProjectsForReviewer(request.authenticatedUser.userId);
    sendSuccessResponse(response, 200, 'Lấy danh sách dự án chờ duyệt thành công.', projects);
  } catch (error) {
    logger.error('Lấy danh sách dự án chờ duyệt thất bại.', { errorMessage: (error as Error).message });
    sendErrorFromUnknown(response, error, 'Không thể lấy danh sách dự án chờ duyệt.');
  }
}

/** Hàm xử lý upload file minh chứng dự án. Mục đích: upload lên Pinata và trả danh sách CID IPFS. */
export async function handleUploadProjectEvidences(request: AuthenticatedRequest, response: Response): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.', 'UNAUTHENTICATED');
    return;
  }

  const validationResult = validateUploadProjectEvidencesRequestBody(request.body);
  if (!validationResult.isValid || !validationResult.data) {
    sendErrorResponse(response, 400, 'Dữ liệu upload file minh chứng không hợp lệ.', 'VALIDATION_ERROR', validationResult.errors);
    return;
  }

  try {
    const uploadResult = await uploadProjectEvidencesForOrganization(request.authenticatedUser.userId, validationResult.data);
    sendSuccessResponse(response, 200, 'Upload file minh chứng thành công.', uploadResult);
  } catch (error) {
    logger.error('Upload file minh chứng thất bại.', { errorMessage: (error as Error).message });
    sendErrorFromUnknown(response, error, 'Không thể upload file minh chứng.');
  }
}

/** Hàm xử lý request submit dự án. Mục đích: chuyển dự án sang trạng thái chờ duyệt. */
export async function handleSubmitProject(request: AuthenticatedRequest, response: Response): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.', 'UNAUTHENTICATED');
    return;
  }

  const validationResult = validateSubmitProjectRequestBody(request.body);
  if (!validationResult.isValid || !validationResult.data) {
    sendErrorResponse(response, 400, 'Dữ liệu submit dự án không hợp lệ.', 'VALIDATION_ERROR', validationResult.errors);
    return;
  }

  try {
    const submitResult = await submitProjectForApproval(request.authenticatedUser.userId, validationResult.data.projectId);
    sendSuccessResponse(response, 200, 'Submit dự án thành công.', submitResult);
  } catch (error) {
    logger.error('Submit dự án thất bại.', { errorMessage: (error as Error).message });
    sendErrorFromUnknown(response, error, 'Không thể submit dự án.');
  }
}

/** Hàm xử lý request cập nhật dự án. Mục đích: cho phép tổ chức chỉnh sửa thông tin và thay minh chứng IPFS. */
export async function handleUpdateProject(request: AuthenticatedRequest, response: Response): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.', 'UNAUTHENTICATED');
    return;
  }

  const validationResult = validateUpdateProjectRequestBody(request.body);
  if (!validationResult.isValid || !validationResult.data) {
    sendErrorResponse(response, 400, 'Dữ liệu cập nhật dự án không hợp lệ.', 'VALIDATION_ERROR', validationResult.errors);
    return;
  }

  try {
    const updatedProject = await updateProjectForOrganization(request.authenticatedUser.userId, validationResult.data);
    sendSuccessResponse(response, 200, 'Cập nhật dự án thành công.', updatedProject);
  } catch (error) {
    logger.error('Cập nhật dự án thất bại.', { errorMessage: (error as Error).message });
    sendErrorFromUnknown(response, error, 'Không thể cập nhật dự án.');
  }
}

/** Hàm xử lý request review dự án. Mục đích: cho phép reviewer approve hoặc reject dự án. */
export async function handleReviewProject(request: AuthenticatedRequest, response: Response): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.', 'UNAUTHENTICATED');
    return;
  }

  const validationResult = validateReviewProjectRequestBody(request.body);
  if (!validationResult.isValid || !validationResult.data) {
    sendErrorResponse(response, 400, 'Dữ liệu review dự án không hợp lệ.', 'VALIDATION_ERROR', validationResult.errors);
    return;
  }

  try {
    const reviewResult = await reviewProjectByReviewer(
      request.authenticatedUser.userId,
      validationResult.data.projectId,
      validationResult.data.action,
      validationResult.data.rejectionReason
    );
    sendSuccessResponse(response, 200, 'Review dự án thành công.', reviewResult);
  } catch (error) {
    logger.error('Review dự án thất bại.', { errorMessage: (error as Error).message });
    sendErrorFromUnknown(response, error, 'Không thể review dự án.');
  }
}

