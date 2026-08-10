const mongodbDesign = {
  collections: [
    {
      name: 'users',
      purpose: 'Lưu thông tin định danh người dùng và ví smart account.',
      fields: [
        { name: 'userId', type: 'String', description: 'UUID định danh người dùng.' },
        { name: 'email', type: 'String', description: 'Email đăng nhập duy nhất.' },
        { name: 'fullName', type: 'String', description: 'Họ và tên người dùng.' },
        { name: 'role', type: 'String', description: 'Vai trò người dùng.' },
        { name: 'organizationId', type: 'String', description: 'UUID tổ chức nếu người dùng thuộc tổ chức.' },
        { name: 'walletAddress', type: 'String', description: 'Địa chỉ ví smart account.' },
        { name: 'socialProvider', type: 'String', description: 'Nguồn đăng nhập xã hội.' },
        { name: 'socialAccountId', type: 'String', description: 'Mã định danh từ nhà cung cấp social để đối soát.' },
        { name: 'recoveryProvider', type: 'String', description: 'Nhà cung cấp phục hồi tài khoản để khôi phục đăng nhập.' },
        { name: 'recoveryAccountId', type: 'String', description: 'Định danh tài khoản phục hồi để liên kết an toàn.' },
        { name: 'isEmailVerified', type: 'Boolean', description: 'Cờ xác thực email.' },
        { name: 'isSybil', type: 'Boolean', description: 'Cờ đánh dấu Sybil sau khi đánh giá.' },
        { name: 'status', type: 'String', description: 'Trạng thái tài khoản.' },
        { name: 'lastLoginAt', type: 'Date', description: 'Thời điểm đăng nhập gần nhất.' },
        { name: 'createdAt', type: 'Date', description: 'Thời điểm tạo.' },
        { name: 'updatedAt', type: 'Date', description: 'Thời điểm cập nhật.' }
      ],
      indexes: [
        { keys: { email: 1 }, unique: true, reason: 'Đảm bảo mỗi email chỉ có một tài khoản.' },
        { keys: { walletAddress: 1 }, unique: true, reason: 'Đảm bảo mỗi ví chỉ liên kết một tài khoản.' },
        { keys: { organizationId: 1 }, reason: 'Tối ưu truy vấn người dùng theo tổ chức.' },
        { keys: { role: 1, status: 1 }, reason: 'Tối ưu lọc theo vai trò và trạng thái.' }
      ]
    },
    {
      name: 'organizations',
      purpose: 'Lưu hồ sơ tổ chức từ thiện đã KYC.',
      fields: [
        { name: 'organizationId', type: 'String', description: 'UUID định danh tổ chức.' },
        { name: 'organizationName', type: 'String', description: 'Tên tổ chức.' },
        { name: 'legalRepresentative', type: 'String', description: 'Người đại diện pháp lý.' },
        { name: 'registrationNumber', type: 'String', description: 'Mã đăng ký pháp lý.' },
        { name: 'kycStatus', type: 'String', description: 'Trạng thái KYC.' },
        { name: 'kycReviewedByUserId', type: 'String', description: 'UUID người duyệt KYC.' },
        { name: 'kycReviewedAt', type: 'Date', description: 'Thời điểm duyệt KYC.' },
        { name: 'kycDocumentsIpfsList', type: 'Array<String>', description: 'Danh sách minh chứng KYC để đối soát.' },
        { name: 'contactEmail', type: 'String', description: 'Email liên hệ.' },
        { name: 'contactPhone', type: 'String', description: 'Số điện thoại liên hệ.' },
        { name: 'address', type: 'String', description: 'Địa chỉ tổ chức.' },
        { name: 'createdAt', type: 'Date', description: 'Thời điểm tạo.' },
        { name: 'updatedAt', type: 'Date', description: 'Thời điểm cập nhật.' }
      ],
      indexes: [
        { keys: { registrationNumber: 1 }, unique: true, reason: 'Tránh trùng hồ sơ pháp lý.' },
        { keys: { kycStatus: 1 }, reason: 'Tối ưu truy vấn trạng thái KYC.' },
        { keys: { organizationName: 1 }, reason: 'Tối ưu tìm kiếm tổ chức theo tên.' }
      ]
    },
    {
      name: 'projects',
      purpose: 'Quản lý dự án gây quỹ và trạng thái hoạt động.',
      fields: [
        { name: 'projectId', type: 'String', description: 'UUID định danh dự án.' },
        { name: 'organizationId', type: 'String', description: 'UUID tổ chức sở hữu dự án.' },
        { name: 'campaignId', type: 'String', description: 'UUID chiến dịch QF liên quan.' },
        { name: 'title', type: 'String', description: 'Tiêu đề dự án.' },
        { name: 'description', type: 'String', description: 'Mô tả dự án.' },
        { name: 'goalAmount', type: 'Number', description: 'Mục tiêu gây quỹ.' },
        { name: 'deadline', type: 'Date', description: 'Thời hạn chiến dịch.' },
        { name: 'evidenceIpfsList', type: 'Array<String>', description: 'Danh sách bằng chứng IPFS.' },
        { name: 'status', type: 'String', description: 'Trạng thái dự án.' },
        { name: 'totalRaised', type: 'Number', description: 'Tổng số tiền đã huy động.' },
        { name: 'donorCount', type: 'Number', description: 'Số lượng nhà hảo tâm.' },
        { name: 'qfScore', type: 'Number', description: 'Điểm QF hiện tại.' },
        { name: 'approvedByUserId', type: 'String', description: 'UUID admin phê duyệt.' },
        { name: 'approvedAt', type: 'Date', description: 'Thời điểm phê duyệt.' },
        { name: 'createdAt', type: 'Date', description: 'Thời điểm tạo.' },
        { name: 'updatedAt', type: 'Date', description: 'Thời điểm cập nhật.' }
      ],
      indexes: [
        { keys: { organizationId: 1 }, reason: 'Tối ưu truy vấn dự án theo tổ chức.' },
        { keys: { campaignId: 1 }, reason: 'Tối ưu truy vấn dự án theo chiến dịch.' },
        { keys: { status: 1, deadline: 1 }, reason: 'Tối ưu danh sách dự án theo trạng thái.' },
        { keys: { qfScore: -1 }, reason: 'Tối ưu xếp hạng theo QF.' }
      ]
    },
    {
      name: 'deposits',
      purpose: 'Theo dõi nạp tiền VNĐ và trạng thái mint token.',
      fields: [
        { name: 'depositId', type: 'String', description: 'UUID giao dịch nạp.' },
        { name: 'userId', type: 'String', description: 'UUID người nạp.' },
        { name: 'orderCode', type: 'String', description: 'Mã đơn PayOS.' },
        { name: 'amountVnd', type: 'Number', description: 'Số tiền VNĐ.' },
        { name: 'tokenAmount', type: 'Number', description: 'Số token tương ứng.' },
        { name: 'paymentStatus', type: 'String', description: 'Trạng thái thanh toán.' },
        { name: 'mintStatus', type: 'String', description: 'Trạng thái mint.' },
        { name: 'payosTransactionId', type: 'String', description: 'Mã giao dịch PayOS.' },
        { name: 'blockchainTransactionHash', type: 'String', description: 'Hash giao dịch on-chain.' },
        { name: 'correlationId', type: 'String', description: 'Mã liên kết chuỗi xử lý giữa các dịch vụ.' },
        { name: 'idempotencyKey', type: 'String', description: 'Khóa chống xử lý trùng từ webhook.' },
        { name: 'paymentConfirmedAt', type: 'Date', description: 'Thời điểm PayOS xác nhận thanh toán.' },
        { name: 'mintedAt', type: 'Date', description: 'Thời điểm mint token thành công.' },
        { name: 'retryCount', type: 'Number', description: 'Số lần retry khi mint hoặc cập nhật thất bại.' },
        { name: 'failureReason', type: 'String', description: 'Lý do thất bại nếu có.' },
        { name: 'createdAt', type: 'Date', description: 'Thời điểm tạo.' },
        { name: 'updatedAt', type: 'Date', description: 'Thời điểm cập nhật.' }
      ],
      indexes: [
        { keys: { orderCode: 1 }, unique: true, reason: 'Idempotency webhook theo orderCode.' },
        { keys: { idempotencyKey: 1 }, unique: true, reason: 'Ngăn xử lý trùng nhiều webhook.' },
        { keys: { correlationId: 1 }, reason: 'Tối ưu truy vết liên dịch vụ.' },
        { keys: { payosTransactionId: 1 }, reason: 'Tối ưu truy vết giao dịch PayOS.' },
        { keys: { userId: 1, paymentStatus: 1 }, reason: 'Tối ưu truy vấn trạng thái nạp.' }
      ]
    },
    {
      name: 'donations',
      purpose: 'Lưu donation on-chain đã index.',
      fields: [
        { name: 'donationId', type: 'String', description: 'UUID donation.' },
        { name: 'donorUserId', type: 'String', description: 'UUID nhà hảo tâm.' },
        { name: 'donorWalletAddress', type: 'String', description: 'Địa chỉ ví quyên góp để đối soát on-chain.' },
        { name: 'projectId', type: 'String', description: 'UUID dự án.' },
        { name: 'amountToken', type: 'Number', description: 'Số token quyên góp.' },
        { name: 'isAnonymous', type: 'Boolean', description: 'Cờ ẩn danh.' },
        { name: 'blockchainTransactionHash', type: 'String', description: 'Hash giao dịch.' },
        { name: 'blockNumber', type: 'Number', description: 'Số block.' },
        { name: 'confirmations', type: 'Number', description: 'Số xác nhận blockchain.' },
        { name: 'donationStatus', type: 'String', description: 'Trạng thái ghi nhận donation.' },
        { name: 'isValidForQf', type: 'Boolean', description: 'Cờ loại trừ khi ví bị Sybil.' },
        { name: 'correlationId', type: 'String', description: 'Mã liên kết chuỗi xử lý giữa các dịch vụ.' },
        { name: 'donatedAt', type: 'Date', description: 'Thời điểm donate.' },
        { name: 'createdAt', type: 'Date', description: 'Thời điểm tạo.' }
      ],
      indexes: [
        { keys: { projectId: 1, donatedAt: -1 }, reason: 'Tối ưu lịch sử dự án.' },
        { keys: { projectId: 1, isAnonymous: 1, donatedAt: -1 }, reason: 'Tối ưu danh sách donate công khai.' },
        { keys: { donorUserId: 1, donatedAt: -1 }, reason: 'Tối ưu lịch sử theo người dùng.' },
        { keys: { donorWalletAddress: 1, donatedAt: -1 }, reason: 'Tối ưu tra cứu theo ví công khai.' },
        { keys: { blockchainTransactionHash: 1 }, unique: true, reason: 'Tránh trùng index.' },
        { keys: { projectId: 1, donorUserId: 1 }, reason: 'Hỗ trợ thống kê người đóng góp theo dự án.' },
        { keys: { blockNumber: -1 }, reason: 'Hỗ trợ indexer đồng bộ theo block.' }
      ]
    },
    {
      name: 'disbursements',
      purpose: 'Theo dõi yêu cầu giải ngân và đối soát ngân hàng.',
      fields: [
        { name: 'disbursementId', type: 'String', description: 'UUID giải ngân.' },
        { name: 'projectId', type: 'String', description: 'UUID dự án.' },
        { name: 'organizationId', type: 'String', description: 'UUID tổ chức.' },
        { name: 'requestedAmount', type: 'Number', description: 'Số tiền yêu cầu.' },
        { name: 'status', type: 'String', description: 'Trạng thái giải ngân.' },
        { name: 'bankAccountNumber', type: 'String', description: 'Số tài khoản.' },
        { name: 'bankCode', type: 'String', description: 'Mã ngân hàng.' },
        { name: 'bankAccountName', type: 'String', description: 'Tên chủ tài khoản.' },
        { name: 'evidenceIpfsList', type: 'Array<String>', description: 'Bằng chứng IPFS.' },
        { name: 'onChainRequestId', type: 'String', description: 'Mã request on-chain.' },
        { name: 'payosTransferId', type: 'String', description: 'Mã chuyển khoản PayOS.' },
        { name: 'payosBankReference', type: 'String', description: 'Mã tham chiếu ngân hàng.' },
        { name: 'correlationId', type: 'String', description: 'Mã liên kết chuỗi xử lý giữa các dịch vụ.' },
        { name: 'idempotencyKey', type: 'String', description: 'Khóa chống xử lý trùng khi gọi PayOS.' },
        { name: 'authorizedAt', type: 'Date', description: 'Thời điểm đủ chữ ký phê duyệt.' },
        { name: 'bankProcessedAt', type: 'Date', description: 'Thời điểm bắt đầu chuyển khoản.' },
        { name: 'completedAt', type: 'Date', description: 'Thời điểm hoàn tất giải ngân.' },
        { name: 'timeoutAt', type: 'Date', description: 'Thời điểm hết hạn chờ đủ chữ ký.' },
        { name: 'retryCount', type: 'Number', description: 'Số lần retry chuyển khoản.' },
        { name: 'failureReason', type: 'String', description: 'Lý do thất bại nếu có.' },
        { name: 'createdAt', type: 'Date', description: 'Thời điểm tạo.' },
        { name: 'updatedAt', type: 'Date', description: 'Thời điểm cập nhật.' }
      ],
      indexes: [
        { keys: { projectId: 1, status: 1, createdAt: -1 }, reason: 'Tối ưu summary COMPLETED theo dự án và thứ tự gần nhất.' },
        { keys: { organizationId: 1, status: 1 }, reason: 'Tối ưu theo tổ chức.' },
        { keys: { onChainRequestId: 1 }, unique: true, reason: 'Idempotency on-chain.' },
        { keys: { idempotencyKey: 1 }, unique: true, reason: 'Ngăn xử lý trùng khi gọi PayOS.' },
        { keys: { correlationId: 1 }, reason: 'Tối ưu truy vết liên dịch vụ.' },
        { keys: { status: 1, createdAt: -1 }, reason: 'Tối ưu giám sát xử lý giải ngân.' }
      ]
    },
    {
      name: 'disbursementSignatures',
      purpose: 'Lưu chữ ký duyệt giải ngân theo vai trò.',
      fields: [
        { name: 'signatureId', type: 'String', description: 'UUID chữ ký.' },
        { name: 'disbursementId', type: 'String', description: 'UUID giải ngân.' },
        { name: 'signerUserId', type: 'String', description: 'UUID người ký.' },
        { name: 'signerRole', type: 'String', description: 'Vai trò người ký.' },
        { name: 'decision', type: 'String', description: 'Kết quả ký duyệt.' },
        { name: 'signedAt', type: 'Date', description: 'Thời điểm ký.' },
        { name: 'createdAt', type: 'Date', description: 'Thời điểm tạo.' }
      ],
      indexes: [
        { keys: { disbursementId: 1, signerRole: 1 }, unique: true, reason: 'Bảo đảm mỗi vai trò chỉ ký một lần.' },
        { keys: { disbursementId: 1, decision: 1 }, reason: 'Tối ưu kiểm tra trạng thái ký.' }
      ]
    },
    {
      name: 'fraudReviews',
      purpose: 'Lưu đánh giá gian lận và quyết định xử lý Sybil.',
      fields: [
        { name: 'reviewId', type: 'String', description: 'UUID đánh giá.' },
        { name: 'userId', type: 'String', description: 'UUID người dùng.' },
        { name: 'riskScore', type: 'Number', description: 'Điểm rủi ro Sybil.' },
        { name: 'riskSignals', type: 'Array<String>', description: 'Danh sách tín hiệu rủi ro.' },
        { name: 'ipAddress', type: 'String', description: 'Địa chỉ IP phục vụ đối soát Sybil.' },
        { name: 'deviceFingerprint', type: 'String', description: 'Dấu vân tay thiết bị để đối chiếu gian lận.' },
        { name: 'relatedDonationIds', type: 'Array<String>', description: 'Danh sách donation liên quan đến đánh giá.' },
        { name: 'status', type: 'String', description: 'Trạng thái xử lý.' },
        { name: 'reviewedByUserId', type: 'String', description: 'UUID người duyệt.' },
        { name: 'reviewedAt', type: 'Date', description: 'Thời điểm duyệt.' },
        { name: 'createdAt', type: 'Date', description: 'Thời điểm tạo.' }
      ],
      indexes: [
        { keys: { userId: 1, status: 1 }, reason: 'Tối ưu truy vấn theo người dùng.' },
        { keys: { status: 1, createdAt: -1 }, reason: 'Tối ưu hàng chờ review.' },
        { keys: { riskScore: -1 }, reason: 'Tối ưu danh sách theo điểm rủi ro.' }
      ]
    },
    {
      name: 'qfCampaigns',
      purpose: 'Quản lý chiến dịch Quadratic Funding theo giai đoạn.',
      fields: [
        { name: 'campaignId', type: 'String', description: 'UUID chiến dịch.' },
        { name: 'campaignName', type: 'String', description: 'Tên chiến dịch.' },
        { name: 'startAt', type: 'Date', description: 'Thời điểm bắt đầu.' },
        { name: 'endAt', type: 'Date', description: 'Thời điểm kết thúc.' },
        { name: 'matchingPoolAmount', type: 'Number', description: 'Quỹ matching theo chiến dịch.' },
        { name: 'status', type: 'String', description: 'Trạng thái chiến dịch.' },
        { name: 'createdAt', type: 'Date', description: 'Thời điểm tạo.' },
        { name: 'updatedAt', type: 'Date', description: 'Thời điểm cập nhật.' }
      ],
      indexes: [
        { keys: { status: 1, startAt: 1 }, reason: 'Tối ưu truy vấn chiến dịch đang hoạt động.' },
        { keys: { endAt: 1 }, reason: 'Tối ưu kiểm tra chiến dịch hết hạn.' }
      ]
    },
    {
      name: 'qfSnapshots',
      purpose: 'Lưu snapshot kết quả QF theo dự án và chiến dịch.',
      fields: [
        { name: 'snapshotId', type: 'String', description: 'UUID snapshot.' },
        { name: 'projectId', type: 'String', description: 'UUID dự án.' },
        { name: 'campaignId', type: 'String', description: 'UUID chiến dịch.' },
        { name: 'totalDonation', type: 'Number', description: 'Tổng donation hợp lệ.' },
        { name: 'qfMatching', type: 'Number', description: 'Phần matching theo QF.' },
        { name: 'qfTotalScore', type: 'Number', description: 'Tổng điểm QF.' },
        { name: 'calculatedAt', type: 'Date', description: 'Thời điểm tính toán.' },
        { name: 'createdAt', type: 'Date', description: 'Thời điểm tạo.' }
      ],
      indexes: [
        { keys: { projectId: 1, calculatedAt: -1 }, reason: 'Tối ưu truy vấn theo dự án.' },
        { keys: { campaignId: 1, calculatedAt: -1 }, reason: 'Tối ưu truy vấn theo chiến dịch.' }
      ]
    },
    {
      name: 'transparencyTransactions',
      purpose: 'Tổng hợp giao dịch để hiển thị minh bạch.',
      fields: [
        { name: 'transactionId', type: 'String', description: 'UUID giao dịch.' },
        { name: 'transactionType', type: 'String', description: 'Loại giao dịch.' },
        { name: 'projectId', type: 'String', description: 'UUID dự án nếu có.' },
        { name: 'userId', type: 'String', description: 'UUID người dùng nếu có.' },
        { name: 'senderWalletAddress', type: 'String', description: 'Địa chỉ ví gửi để hiển thị minh bạch.' },
        { name: 'receiverWalletAddress', type: 'String', description: 'Địa chỉ ví nhận để hiển thị minh bạch.' },
        { name: 'amountToken', type: 'Number', description: 'Giá trị token.' },
        { name: 'amountVnd', type: 'Number', description: 'Giá trị VNĐ.' },
        { name: 'blockchainTransactionHash', type: 'String', description: 'Hash giao dịch on-chain.' },
        { name: 'confirmations', type: 'Number', description: 'Số xác nhận blockchain.' },
        { name: 'explorerUrl', type: 'String', description: 'Liên kết tra cứu block explorer.' },
        { name: 'bankReference', type: 'String', description: 'Mã tham chiếu ngân hàng.' },
        { name: 'bankAccountMasked', type: 'String', description: 'Thông tin tài khoản ngân hàng đã ẩn.' },
        { name: 'status', type: 'String', description: 'Trạng thái giao dịch.' },
        { name: 'occurredAt', type: 'Date', description: 'Thời điểm nghiệp vụ.' },
        { name: 'createdAt', type: 'Date', description: 'Thời điểm tạo.' }
      ],
      indexes: [
        { keys: { projectId: 1, occurredAt: -1 }, reason: 'Tối ưu tra cứu theo dự án.' },
        { keys: { userId: 1, occurredAt: -1 }, reason: 'Tối ưu tra cứu theo người dùng.' },
        { keys: { transactionType: 1, occurredAt: -1 }, reason: 'Tối ưu lọc theo loại giao dịch.' },
        { keys: { blockchainTransactionHash: 1 }, unique: true, reason: 'Ngăn trùng dữ liệu index on-chain.' }
      ]
    },
    {
      name: 'auditLogs',
      purpose: 'Lưu vết audit cho các hành động quan trọng.',
      fields: [
        { name: 'auditLogId', type: 'String', description: 'UUID bản ghi audit.' },
        { name: 'actorUserId', type: 'String', description: 'UUID người thực hiện.' },
        { name: 'action', type: 'String', description: 'Hành động đã thực hiện.' },
        { name: 'resourceType', type: 'String', description: 'Loại tài nguyên.' },
        { name: 'resourceId', type: 'String', description: 'UUID tài nguyên.' },
        { name: 'correlationId', type: 'String', description: 'Mã liên kết chuỗi xử lý giữa các dịch vụ.' },
        { name: 'metadata', type: 'Object', description: 'Dữ liệu bổ sung.' },
        { name: 'createdAt', type: 'Date', description: 'Thời điểm tạo.' }
      ],
      indexes: [
        { keys: { actorUserId: 1, createdAt: -1 }, reason: 'Tối ưu truy vấn audit theo người dùng.' },
        { keys: { resourceType: 1, resourceId: 1 }, reason: 'Tối ưu truy vấn theo tài nguyên.' },
        { keys: { correlationId: 1 }, reason: 'Tối ưu truy vết liên dịch vụ.' }
      ]
    },
    {
      name: 'authSessions',
      purpose: 'Quản lý phiên đăng nhập và hạn dùng session.',
      fields: [
        { name: 'sessionId', type: 'String', description: 'UUID phiên đăng nhập.' },
        { name: 'userId', type: 'String', description: 'UUID người dùng.' },
        { name: 'sessionTokenHash', type: 'String', description: 'Mã băm session token để lưu an toàn.' },
        { name: 'ipAddress', type: 'String', description: 'Địa chỉ IP tạo phiên.' },
        { name: 'deviceFingerprint', type: 'String', description: 'Dấu vân tay thiết bị để phát hiện gian lận.' },
        { name: 'expiresAt', type: 'Date', description: 'Thời điểm hết hạn phiên.' },
        { name: 'createdAt', type: 'Date', description: 'Thời điểm tạo.' },
        { name: 'revokedAt', type: 'Date', description: 'Thời điểm thu hồi phiên nếu có.' }
      ],
      indexes: [
        { keys: { sessionTokenHash: 1 }, unique: true, reason: 'Tra cứu nhanh session theo token.' },
        { keys: { userId: 1, createdAt: -1 }, reason: 'Tối ưu truy vấn lịch sử đăng nhập.' },
        { keys: { expiresAt: 1 }, reason: 'TTL tự động xóa session hết hạn.' }
      ]
    },
    {
      name: 'webhookEvents',
      purpose: 'Lưu log webhook từ PayOS để idempotency và đối soát.',
      fields: [
        { name: 'webhookEventId', type: 'String', description: 'UUID sự kiện webhook.' },
        { name: 'eventSource', type: 'String', description: 'Nguồn sự kiện như PayOS.' },
        { name: 'eventType', type: 'String', description: 'Loại sự kiện webhook.' },
        { name: 'idempotencyKey', type: 'String', description: 'Khóa chống xử lý trùng từ webhook.' },
        { name: 'correlationId', type: 'String', description: 'Mã liên kết chuỗi xử lý giữa các dịch vụ.' },
        { name: 'payload', type: 'Object', description: 'Dữ liệu gốc của webhook.' },
        { name: 'signatureVerified', type: 'Boolean', description: 'Cờ xác thực chữ ký webhook.' },
        { name: 'receivedAt', type: 'Date', description: 'Thời điểm nhận webhook.' },
        { name: 'processedAt', type: 'Date', description: 'Thời điểm xử lý xong.' }
      ],
      indexes: [
        { keys: { idempotencyKey: 1 }, unique: true, reason: 'Chặn xử lý trùng webhook.' },
        { keys: { eventSource: 1, receivedAt: -1 }, reason: 'Tối ưu truy vết theo nguồn.' }
      ]
    },
    {
      name: 'projectUpdates',
      purpose: 'Lưu tiến độ và báo cáo minh chứng dự án.',
      fields: [
        { name: 'projectUpdateId', type: 'String', description: 'UUID cập nhật dự án.' },
        { name: 'projectId', type: 'String', description: 'UUID dự án.' },
        { name: 'updateTitle', type: 'String', description: 'Tiêu đề cập nhật.' },
        { name: 'updateContent', type: 'String', description: 'Nội dung cập nhật.' },
        { name: 'evidenceIpfsList', type: 'Array<String>', description: 'Danh sách bằng chứng IPFS.' },
        { name: 'createdByUserId', type: 'String', description: 'UUID người tạo cập nhật.' },
        { name: 'createdAt', type: 'Date', description: 'Thời điểm tạo.' }
      ],
      indexes: [
        { keys: { projectId: 1, createdAt: -1 }, reason: 'Tối ưu tra cứu tiến độ theo dự án.' }
      ]
    },
    {
      name: 'organizationBankAccounts',
      purpose: 'Lưu tài khoản ngân hàng đã xác thực của tổ chức.',
      fields: [
        { name: 'organizationBankAccountId', type: 'String', description: 'UUID tài khoản ngân hàng.' },
        { name: 'organizationId', type: 'String', description: 'UUID tổ chức.' },
        { name: 'bankAccountNumber', type: 'String', description: 'Số tài khoản ngân hàng.' },
        { name: 'bankCode', type: 'String', description: 'Mã ngân hàng.' },
        { name: 'bankAccountName', type: 'String', description: 'Tên chủ tài khoản.' },
        { name: 'isDefault', type: 'Boolean', description: 'Cờ tài khoản mặc định.' },
        { name: 'verifiedByUserId', type: 'String', description: 'UUID người xác thực.' },
        { name: 'verifiedAt', type: 'Date', description: 'Thời điểm xác thực.' },
        { name: 'createdAt', type: 'Date', description: 'Thời điểm tạo.' }
      ],
      indexes: [
        { keys: { organizationId: 1, isDefault: 1 }, reason: 'Tối ưu lấy tài khoản mặc định.' },
        { keys: { bankAccountNumber: 1, bankCode: 1 }, unique: true, reason: 'Ngăn trùng tài khoản ngân hàng.' }
      ]
    },
    {
      name: 'notifications',
      purpose: 'Lưu thông báo realtime cho người dùng.',
      fields: [
        { name: 'notificationId', type: 'String', description: 'UUID thông báo.' },
        { name: 'userId', type: 'String', description: 'UUID người nhận.' },
        { name: 'notificationType', type: 'String', description: 'Loại thông báo.' },
        { name: 'content', type: 'String', description: 'Nội dung thông báo.' },
        { name: 'isRead', type: 'Boolean', description: 'Cờ đã đọc.' },
        { name: 'metadata', type: 'Object', description: 'Dữ liệu bổ sung.' },
        { name: 'createdAt', type: 'Date', description: 'Thời điểm tạo.' }
      ],
      indexes: [
        { keys: { userId: 1, isRead: 1 }, reason: 'Tối ưu truy vấn thông báo chưa đọc.' },
        { keys: { createdAt: -1 }, reason: 'Tối ưu sắp xếp theo thời gian.' }
      ]
    },
    {
      name: 'errorCodeDictionary',
      purpose: 'Chuẩn hóa mã lỗi theo miền nghiệp vụ.',
      fields: [
        { name: 'errorCodeId', type: 'String', description: 'UUID mã lỗi.' },
        { name: 'domain', type: 'String', description: 'Miền nghiệp vụ áp dụng.' },
        { name: 'code', type: 'String', description: 'Mã lỗi chuẩn hóa.' },
        { name: 'message', type: 'String', description: 'Thông điệp lỗi hiển thị.' },
        { name: 'severity', type: 'String', description: 'Mức độ nghiêm trọng.' },
        { name: 'isActive', type: 'Boolean', description: 'Cờ kích hoạt mã lỗi.' },
        { name: 'createdAt', type: 'Date', description: 'Thời điểm tạo.' },
        { name: 'updatedAt', type: 'Date', description: 'Thời điểm cập nhật.' }
      ],
      indexes: [
        { keys: { domain: 1, code: 1 }, unique: true, reason: 'Ngăn trùng mã lỗi theo miền.' },
        { keys: { isActive: 1 }, reason: 'Tối ưu tra cứu mã lỗi đang dùng.' }
      ]
    },
    {
      name: 'unified_transactions',
      purpose: 'Tổng hợp giao dịch minh bạch từ PayOS và blockchain.',
      fields: [
        { name: 'utxId', type: 'String', description: 'UUID duy nhất của unified transaction.' },
        { name: 'correlationId', type: 'String', description: 'Mã liên kết PayOS và blockchain events.' },
        { name: 'projectId', type: 'String', description: 'UUID dự án.' },
        { name: 'walletAddress', type: 'String', description: 'Địa chỉ ví người dùng.' },
        { name: 'eventType', type: 'String', description: 'Loại sự kiện: DEPOSIT, DONATION, DISBURSEMENT, MINT.' },
        { name: 'eventTimestamp', type: 'Date', description: 'Thời điểm sự kiện xảy ra.' },
        { name: 'amountVnd', type: 'Number', description: 'Số tiền VNĐ.' },
        { name: 'amountUsd', type: 'Number', description: 'Số tiền USD tương đương.' },
        { name: 'source', type: 'String', description: 'Nguồn dữ liệu: PAYOS, BLOCKCHAIN, MIXED.' },
        { name: 'chainStatus', type: 'String', description: 'Trạng thái blockchain: PENDING, CONFIRMED, FAILED, REORGED.' },
        { name: 'chainTxHash', type: 'String', description: 'Transaction hash on-chain.' },
        { name: 'chainBlockNumber', type: 'Number', description: 'Số block on-chain.' },
        { name: 'payosStatus', type: 'String', description: 'Trạng thái PayOS: PENDING_PAYMENT, PAYMENT_CONFIRMED, FAILED.' },
        { name: 'payosOrderCode', type: 'String', description: 'Mã đơn PayOS.' },
        { name: 'payosTransactionId', type: 'String', description: 'PayOS transaction ID.' },
        { name: 'payosRecordId', type: 'String', description: 'ID gốc từ PayOS.' },
        { name: 'blockchainRecordId', type: 'String', description: 'ID gốc từ blockchain.' },
        { name: 'metadata', type: 'Object', description: 'Dữ liệu bổ sung.' },
        { name: 'createdAt', type: 'Date', description: 'Thời điểm tạo.' },
        { name: 'updatedAt', type: 'Date', description: 'Thời điểm cập nhật.' }
      ],
      indexes: [
        { keys: { utxId: 1 }, unique: true, reason: 'Đảm bảo mỗi unified transaction chỉ tồn tại một bản ghi.' },
        { keys: { projectId: 1, eventTimestamp: 1 }, reason: 'Tối ưu timeline theo dự án và thời gian.' },
        { keys: { walletAddress: 1, eventTimestamp: 1 }, reason: 'Tối ưu tra cứu theo ví và thời gian.' },
        { keys: { correlationId: 1 }, unique: true, reason: 'Đảm bảo không trùng correlationId.' }
      ]
    }
  ]
};

/**
 * Hàm cung cấp thiết kế MongoDB cho các dịch vụ cần tham chiếu.
 * Mục đích: gom dữ liệu thiết kế dưới dạng cấu hình dùng lại.
 */
function getMongoDbDesign() {
  return mongodbDesign;
}

module.exports = {
  getMongoDbDesign
};

