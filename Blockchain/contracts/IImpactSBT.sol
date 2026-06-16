// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IImpactSBT
 * @notice Interface cho Impact Soulbound Token, tương thích chuẩn ERC-5192.
 * @dev Định nghĩa các hàm công khai mà contract ImpactSBT phải triển khai.
 *      Các hàm này cho phép bên ngoài (frontend, backend indexer) tương tác
 *      với token SBT mà không cần biết chi tiết implementation bên trong.
 */
interface IImpactSBT {
    /**
     * @notice Trả về URI chứa metadata JSON của SBT trên IPFS.
     * @param tokenId ID của token SBT cần truy vấn.
     * @return URI dạng ipfs://Qm... trỏ đến metadata JSON.
     */
    function tokenURI(uint256 tokenId) external view returns (string memory);

    /**
     * @notice Trả về tổng số SBT đã được mint kể từ khi deploy contract.
     * @return Số lượng token đã mint.
     */
    function totalSupply() external view returns (uint256);

    /**
     * @notice Kiểm tra SBT có bị khóa (soulbound) hay không theo chuẩn ERC-5192.
     * @dev Token bị khóa khi đang ở trạng thái Active — không thể transfer.
     *      Token không bị khóa khi ở Frozen, Revoked, hoặc Burned (nhưng vẫn không
     *      thể transfer vì soulbound restriction được enforce ở cấp contract).
     * @param tokenId ID của SBT cần kiểm tra.
     * @return true nếu token bị khóa, false nếu không.
     */
    function locked(uint256 tokenId) external view returns (bool);

    /**
     * @notice Trả về toàn bộ thông tin metadata của một SBT.
     * @param tokenId ID của SBT cần truy vấn.
     * @return projectId ID của dự án mà SBT đại diện.
     * @return milestone Bước tiến (milestone) của dự án tại thời điểm mint.
     * @return beneficiaryCount Số người thụ hưởng được ghi nhận.
     * @return gpsCoordinates Tọa độ GPS của địa điểm (có thể rỗng nếu EXIF bị strip).
     * @return imageCID IPFS CID của hình ảnh minh chứng.
     * @return mintedAt Thời điểm token được mint (Unix timestamp).
     */
    function getTokenMetadata(uint256 tokenId)
        external
        view
        returns (
            uint256 projectId,
            uint256 milestone,
            uint256 beneficiaryCount,
            string memory gpsCoordinates,
            string memory imageCID,
            uint256 mintedAt
        );

    /**
     * @notice Trả về trạng thái hiện tại của SBT dưới dạng số.
     * @param tokenId ID của SBT cần truy vấn.
     * @return 0 = Active, 1 = Frozen, 2 = Revoked, 3 = Burned.
     */
    function getTokenStatus(uint256 tokenId) external view returns (uint8);

    /**
     * @notice Cập nhật trạng thái của một SBT.
     * @dev Chỉ Oracle hoặc Owner mới được phép gọi. Trạng thái Revoked và Burned
     *      là terminal states — không thể chuyển đổi sang trạng thái khác.
     * @param tokenId ID của SBT cần cập nhật.
     * @param newStatus Trạng thái mới (0-3).
     * @param reason Lý do thay đổi trạng thái (để audit trail).
     */
    function updateTokenStatus(uint256 tokenId, uint8 newStatus, string calldata reason) external;

    /**
     * @notice Mint một SBT mới cho địa chỉ beneficiary.
     * @dev Chỉ tài khoản có ORACLE_ROLE mới được phép mint.
     *      Token được gán vĩnh viễn cho beneficiary sau khi mint — không thể transfer.
     *      Contract phải đang ở trạng thái hoạt động (không bị pause).
     * @param to Địa chỉ nhận SBT.
     * @param projectId ID của dự án.
     * @param milestone Bước tiến của dự án.
     * @param beneficiaryCount Số người thụ hưởng.
     * @param gpsCoordinates Tọa độ GPS của địa điểm (có thể rỗng).
     * @param imageCID IPFS CID của hình ảnh minh chứng (không được rỗng).
     * @param tokenURI_ URI metadata IPFS đầy đủ (không được rỗng).
     * @return tokenId ID của SBT vừa được mint.
     */
    function mint(
        address to,
        uint256 projectId,
        uint256 milestone,
        uint256 beneficiaryCount,
        string calldata gpsCoordinates,
        string calldata imageCID,
        string calldata tokenURI_
    ) external returns (uint256 tokenId);

    /**
     * @notice Kiểm tra một địa chỉ có vai trò Oracle hay không.
     * @param account Địa chỉ cần kiểm tra.
     * @return true nếu có ORACLE_ROLE, false nếu không.
     */
    function isOracle(address account) external view returns (bool);

    /**
     * @notice Chuyển quyền Oracle sang địa chỉ khác.
     * @dev Chỉ Owner mới được phép gọi. Thu hồi ORACLE_ROLE khỏi Oracle cũ
     *      và cấp ORACLE_ROLE cho Oracle mới.
     * @param newOracle Địa chỉ Oracle mới.
     */
    function transferOracleRole(address newOracle) external;

    /// @notice Tạm dừng toàn bộ contract (chỉ Owner).
    function pause() external;

    /// @notice Tiếp tục hoạt động contract sau khi tạm dừng (chỉ Owner).
    function unpause() external;
}
