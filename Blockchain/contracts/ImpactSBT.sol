// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title IERC5192
 * @notice Interface tối thiểu cho Soulbound Token theo chuẩn ERC-5192.
 * @dev ERC-5192 yêu cầu contract triển khai hàm `locked(uint256 tokenId)`.
 *      Interface ID: 0x6a4d1d1c
 *      Tham khảo: https://eips.ethereum.org/EIPS/eip-5192
 */
interface IERC5192 {
    /**
     * @notice Trả về trạng thái khóa (soulbound) của SBT.
     * @dev Token bị khóa khi đang ở trạng thái Active.
     *      Khi token bị khóa, mọi lần transfer đều bị từ chối ở cấp contract.
     * @param tokenId ID của SBT cần kiểm tra.
     * @return true nếu token bị khóa (soulbound), false nếu không.
     */
    function locked(uint256 tokenId) external view returns (bool);
}

/**
 * @title ImpactSBT
 * @notice Soulbound Token theo chuẩn ERC-5192, đại diện cho Impact Certificate của dự án từ thiện.
 *
 * @dev Đặc điểm chính:
 *      - Non-transferable (soulbound) sau khi mint — token gắn vĩnh viễn với beneficiary.
 *      - Chỉ Oracle mới được phép mint thông qua AccessControl (ORACLE_ROLE).
 *      - Owner có quyền pause/unpause contract và chuyển Oracle address.
 *      - Owner và DEFAULT_ADMIN_ROLE được đồng bộ khi chuyển ownership
 *        (override transferOwnership để sync cả hai hệ thống quyền).
 *      - Hỗ trợ 4 trạng thái token: Active, Frozen, Revoked, Burned.
 *      - Revoked và Burned là terminal states — không thể chuyển đổi.
 *
 * @dev Cấu trúc phân quyền:
 *      - Ownable: quản lý pause/unpause và transferOracleRole.
 *      - AccessControl: ORACLE_ROLE quản lý ai được mint SBT.
 *      - Khi transferOwnership được gọi, DEFAULT_ADMIN_ROLE được sync với Ownable ownership.
 *
 * @dev ERC-5192 Interface ID: 0x6a4d1d1c
 */
contract ImpactSBT is ERC721, Ownable, AccessControl, Pausable, ReentrancyGuard, IERC5192 {
    /// @notice Mã định danh interface ERC-5192 theo chuẩn EIP-165.
    bytes4 constant ERC5192_INTERFACE_ID = 0x6a4d1d1c;

    /// @notice Role cho phép mint SBT. Giá trị hash: keccak256("ORACLE_ROLE").
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

    /**
     * @notice Các trạng thái có thể của một SBT.
     *
     * @dev Transition rules:
     *      - Active → Frozen, Revoked
     *      - Frozen → Active, Revoked
     *      - Revoked → (terminal, không chuyển được)
     *      - Burned → (terminal, không chuyển được)
     */
    enum TokenStatus {
        Active,   // 0: Token đang hoạt động, bị khóa (soulbound)
        Frozen,   // 1: Token bị đóng băng tạm thời
        Revoked,  // 2: Token bị thu hồi (terminal state)
        Burned    // 3: Token đã bị burn (terminal state)
    }

    /**
     * @notice Cấu trúc metadata lưu trữ thông tin mở rộng của mỗi SBT.
     *
     * @dev Lưu trữ on-chain để indexer và frontend có thể truy vấn trực tiếp
     *      mà không cần đọc IPFS metadata JSON. Metadata JSON trên IPFS vẫn
     *      được lưu dưới dạng tokenURI_ trong event SBTMinted.
     *
     * @member projectId ID của dự án mà SBT đại diện.
     * @member milestone Bước tiến của dự án tại thời điểm mint.
     * @member beneficiaryCount Số người thụ hưởng được ghi nhận.
     * @member gpsCoordinates Tọa độ GPS của địa điểm (có thể rỗng nếu EXIF bị strip).
     * @member imageCID IPFS CID của hình ảnh minh chứng.
     * @member mintedAt Thời điểm token được mint (Unix timestamp, block.timestamp).
     */
    struct TokenMetadata {
        uint256 projectId;
        uint256 milestone;
        uint256 beneficiaryCount;
        string gpsCoordinates;
        string imageCID;
        uint256 mintedAt;
    }

    /// @notice Bộ đếm SBT, bắt đầu từ 0, tăng 1 mỗi lần mint thành công.
    uint256 private _sbtIdCounter;

    /// @notice Metadata của từng SBT, ánh xạ theo tokenId.
    mapping(uint256 => TokenMetadata) public tokenMetadata;

    /// @notice Trạng thái của từng SBT theo tokenId.
    mapping(uint256 => TokenStatus) public tokenStatus;

    /// @notice URI chứa metadata JSON của từng SBT trên IPFS (dạng ipfs://Qm...).
    mapping(uint256 => string) private _tokenURIs;

    /// @notice Cờ đánh dấu token tồn tại (dùng string rỗng vẫn có length=0 nên cần flag riêng).
    mapping(uint256 => bool) private _tokenExists;

    /// @notice Địa chỉ Oracle hiện tại — track riêng để dùng trong transferOracleRole.
    address private _currentOracle;

    /**
     * @notice Sự kiện khi một SBT mới được mint thành công.
     *
     * @dev Trường tokenURI_ chứa URI đầy đủ (ipfs://Qm...), KHÔNG PHẢI metadataCID đơn thuần.
     *      Backend indexer có thể dùng trực tiếp làm URL IPFS gateway.
     *      Nếu cần CID thuần túy, parse bằng: tokenURI_.replace("ipfs://", "").
     *
     * @param to Địa chỉ nhận SBT.
     * @param tokenId ID của SBT vừa được mint.
     * @param tokenURI_ URI metadata IPFS đầy đủ (ipfs://Qm...).
     */
    event SBTMinted(address indexed to, uint256 indexed tokenId, string tokenURI_);

    /// @notice Sự kiện khi trạng thái SBT được cập nhật.
    /// @param tokenId ID của SBT được cập nhật.
    /// @param newStatus Trạng thái mới (0-3).
    /// @param reason Lý do thay đổi trạng thái.
    event TokenStatusUpdated(uint256 indexed tokenId, uint8 newStatus, string reason);

    /// @notice Sự kiện khi Oracle role được chuyển sang địa chỉ khác.
    /// @param previousOracle Địa chỉ Oracle cũ.
    /// @param newOracle Địa chỉ Oracle mới.
    event OracleRoleTransferred(address indexed previousOracle, address indexed newOracle);

    /// @notice Token không tồn tại trong contract.
    error TokenNotExists();

    /// @notice Trạng thái không hợp lệ (vượt ngoài phạm vi 0-3).
    error InvalidStatus();

    /// @notice Địa chỉ không hợp lệ (zero address).
    error InvalidAddress();

    /// @notice Token đang bị khóa (soulbound), không thể chuyển.
    error TokenLocked();

    /// @notice Chuyển đổi trạng thái không hợp lệ (terminal state).
    error InvalidTransition();

    /// @notice IPFS CID của hình ảnh bị rỗng.
    error EmptyImageCID();

    /// @notice Token URI bị rỗng.
    error EmptyTokenURI();

    /**
     * @notice Khởi tạo contract với địa chỉ Oracle ban đầu.
     *
     * @dev Constructor thực hiện:
     *      1. Cấp DEFAULT_ADMIN_ROLE cho deployer (msg.sender).
     *      2. Cấp ORACLE_ROLE cho initialOracle.
     *      3. Lưu initialOracle vào biến track riêng _currentOracle.
     *
     * @param initialOracle Địa chỉ Oracle được phép mint SBT lần đầu.
     */
    constructor(address initialOracle) ERC721("Impact SBT", "ISBT") Ownable(msg.sender) {
        if (initialOracle == address(0)) revert InvalidAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ORACLE_ROLE, initialOracle);
        _currentOracle = initialOracle;
    }

    /**
     * @notice Chuyển quyền sở hữu contract sang địa chỉ mới.
     *
     * @dev Override Ownable.transferOwnership để đồng bộ Ownable ownership với
     *      AccessControl DEFAULT_ADMIN_ROLE. Trước đây hai hệ thống này tách rời
     *      khiến chỉ có Ownable ownership được chuyển mà DEFAULT_ADMIN_ROLE giữ
     *      nguyên — gây ra lỗ hổng bảo mật nghiêm trọng.
     *
     * @dev Logic:
     *      1. Cấp DEFAULT_ADMIN_ROLE cho newOwner (newOwner có toàn quyền AccessControl).
     *      2. Thu hồi DEFAULT_ADMIN_ROLE khỏi owner hiện tại (ngăn owner cũ tiếp tục
     *         thực hiện hành động admin sau khi transfer).
     *      3. Gọi super.transferOwnership() để cập nhật Ownable ownership.
     *
     * @param newOwner Địa chỉ owner mới.
     */
    function transferOwnership(address newOwner) public override(Ownable) onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, newOwner);
        _revokeRole(DEFAULT_ADMIN_ROLE, msg.sender);
        super.transferOwnership(newOwner);
    }

    /// @notice Trả về tổng số SBT đã được mint kể từ khi deploy contract.
    function totalSupply() public view returns (uint256) {
        return _sbtIdCounter;
    }

    /**
     * @notice Trả về URI chứa metadata JSON của SBT trên IPFS.
     *
     * @dev URI được lưu trong mapping riêng (_tokenURIs) khi mint.
     *      Dùng cho ERC-721 metadata extension (json metadata trên IPFS).
     *
     * @param tokenId ID của SBT cần truy vấn.
     * @return URI dạng ipfs://Qm... trỏ đến metadata JSON.
     */
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        if (!_tokenExists[tokenId]) revert TokenNotExists();
        return _tokenURIs[tokenId];
    }

    /**
     * @notice Trả về trạng thái khóa (soulbound) của SBT theo chuẩn ERC-5192.
     *
     * @dev Token bị khóa (locked = true) khi đang ở trạng thái Active.
     *      Token không bị khóa (locked = false) khi ở Frozen, Revoked, hoặc Burned.
     *      Tuy nhiên, dù locked=false, token vẫn không thể transfer vì
     *      soulbound restriction được enforce ở cấp contract (_update override).
     *      Non-existent token sẽ revert.
     *
     * @param tokenId ID của SBT cần kiểm tra.
     * @return true nếu token bị khóa (Active), false nếu không.
     */
    function locked(uint256 tokenId) public view returns (bool) {
        if (!_tokenExists[tokenId]) revert TokenNotExists();
        return tokenStatus[tokenId] == TokenStatus.Active;
    }

    /**
     * @notice Trả về toàn bộ thông tin metadata của một SBT.
     *
     * @dev Trả về từng trường riêng lẻ thay vì struct để tránh
     *      "stack too deep" compiler error trong Solidity.
     *      Non-existent token sẽ revert.
     *
     * @param tokenId ID của SBT cần truy vấn.
     * @return projectId ID của dự án.
     * @return milestone Bước tiến của dự án.
     * @return beneficiaryCount Số người thụ hưởng.
     * @return gpsCoordinates Tọa độ GPS (có thể rỗng).
     * @return imageCID IPFS CID của hình ảnh minh chứng.
     * @return mintedAt Thời điểm mint (Unix timestamp).
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
        )
    {
        if (!_tokenExists[tokenId]) revert TokenNotExists();
        TokenMetadata memory metadata = tokenMetadata[tokenId];
        return (
            metadata.projectId,
            metadata.milestone,
            metadata.beneficiaryCount,
            metadata.gpsCoordinates,
            metadata.imageCID,
            metadata.mintedAt
        );
    }

    /**
     * @notice Trả về trạng thái hiện tại của SBT dưới dạng số.
     *
     * @param tokenId ID của SBT cần truy vấn.
     * @return 0 = Active, 1 = Frozen, 2 = Revoked, 3 = Burned.
     */
    function getTokenStatus(uint256 tokenId) external view returns (uint8) {
        if (!_tokenExists[tokenId]) revert TokenNotExists();
        return uint8(tokenStatus[tokenId]);
    }

    /**
     * @notice Kiểm tra một địa chỉ có vai trò Oracle hay không.
     *
     * @param account Địa chỉ cần kiểm tra.
     * @return true nếu có ORACLE_ROLE, false nếu không.
     */
    function isOracle(address account) external view returns (bool) {
        return hasRole(ORACLE_ROLE, account);
    }

    /**
     * @notice Cập nhật trạng thái của một SBT.
     *
     * @dev Ai được phép:
     *      - Oracle (có ORACLE_ROLE): cập nhật trạng thái token.
     *      - Owner: cũng được phép cập nhật trạng thái.
     *
     * @dev Trạng thái terminal:
     *      - Revoked và Burned là terminal states — không thể chuyển đổi sang
     *        trạng thái khác sau khi đã set. Điều này đảm bảo tính bất biến
     *        của SBT: một token đã bị thu hồi hoặc burn không thể khôi phục.
     *
     * @param tokenId ID của SBT cần cập nhật.
     * @param newStatus Trạng thái mới (0: Active, 1: Frozen, 2: Revoked, 3: Burned).
     * @param reason Lý do thay đổi trạng thái (để audit trail trên blockchain).
     */
    function updateTokenStatus(
        uint256 tokenId,
        uint8 newStatus,
        string calldata reason
    ) external {
        _checkOracleOrOwner();
        if (!_tokenExists[tokenId]) revert TokenNotExists();
        if (newStatus > uint8(TokenStatus.Burned)) revert InvalidStatus();

        TokenStatus currentStatus = tokenStatus[tokenId];
        TokenStatus targetStatus = TokenStatus(newStatus);

        // Trạng thái Burned là terminal — không thể chuyển đổi
        if (currentStatus == TokenStatus.Burned) revert InvalidTransition();
        // Trạng thái Revoked là terminal — không thể chuyển đổi
        if (currentStatus == TokenStatus.Revoked) revert InvalidTransition();

        tokenStatus[tokenId] = targetStatus;
        emit TokenStatusUpdated(tokenId, newStatus, reason);
    }

    /**
     * @notice Chuyển quyền Oracle sang địa chỉ mới.
     *
     * @dev Chỉ Owner mới được phép gọi. Hàm này:
     *      1. Thu hồi ORACLE_ROLE khỏi Oracle hiện tại.
     *      2. Cấp ORACLE_ROLE cho Oracle mới.
     *      3. Cập nhật biến track _currentOracle.
     *      4. Emit event OracleRoleTransferred.
     *
     * @param newOracle Địa chỉ Oracle mới.
     */
    function transferOracleRole(address newOracle) external onlyOwner {
        if (newOracle == address(0)) revert InvalidAddress();

        address previousOracle = _currentOracle;
        _revokeRole(ORACLE_ROLE, previousOracle);
        _grantRole(ORACLE_ROLE, newOracle);
        _currentOracle = newOracle;

        emit OracleRoleTransferred(previousOracle, newOracle);
    }

    /**
     * @notice Mint một SBT mới cho beneficiary.
     *
     * @dev Hàm này là cách DUY NHẤT để tạo SBT mới. Đặc điểm:
     *      - Chỉ tài khoản có ORACLE_ROLE mới được phép gọi.
     *      - Contract phải đang ở trạng thái hoạt động (không bị pause).
     *      - Dùng _safeMint thay vì _mint để revert nếu beneficiary là contract
     *        không implement onERC721Received (phòng trường hợp beneficiary sai).
     *      - Token ngay lập tức bị khóa (soulbound) sau mint.
     *      - imageCID và tokenURI_ bắt buộc phải khác rỗng.
     *
     * @param to Địa chỉ nhận SBT (beneficiary).
     * @param projectId ID của dự án mà SBT đại diện.
     * @param milestone Bước tiến của dự án tại thời điểm mint.
     * @param beneficiaryCount Số người thụ hưởng được ghi nhận.
     * @param gpsCoordinates Tọa độ GPS của địa điểm thực hiện dự án
     *                      (có thể rỗng trong trường hợp ảnh bị strip EXIF GPS).
     * @param imageCID IPFS CID của hình ảnh minh chứng (không được rỗng).
     * @param tokenURI_ URI IPFS đầy đủ chứa metadata JSON (ipfs://Qm..., không được rỗng).
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
    ) external onlyRole(ORACLE_ROLE) nonReentrant whenNotPaused returns (uint256 tokenId) {
        if (to == address(0)) revert InvalidAddress();
        if (bytes(imageCID).length == 0) revert EmptyImageCID();
        if (bytes(tokenURI_).length == 0) revert EmptyTokenURI();

        tokenId = _sbtIdCounter++;
        _safeMint(to, tokenId);

        tokenMetadata[tokenId] = TokenMetadata({
            projectId: projectId,
            milestone: milestone,
            beneficiaryCount: beneficiaryCount,
            gpsCoordinates: gpsCoordinates,
            imageCID: imageCID,
            mintedAt: block.timestamp
        });

        _tokenURIs[tokenId] = tokenURI_;
        _tokenExists[tokenId] = true;
        tokenStatus[tokenId] = TokenStatus.Active;

        emit SBTMinted(to, tokenId, tokenURI_);
    }

    /// @notice Tạm dừng toàn bộ contract (chỉ Owner). Dùng trong trường hợp khẩn cấp.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Tiếp tục hoạt động contract sau khi tạm dừng (chỉ Owner).
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Kiểm tra contract có hỗ trợ một interface cụ thể hay không.
     *
     * @dev Override supportsInterface để thêm ERC-5192 vào danh sách
     *      các interface được contract hỗ trợ. Kết hợp với
     *      ERC721.supportsInterface và AccessControl.supportsInterface
     *      thông qua super.supportsInterface().
     *
     * @param interfaceId Mã định danh của interface cần kiểm tra.
     * @return true nếu interface được hỗ trợ, false nếu không.
     */
    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId) || interfaceId == ERC5192_INTERFACE_ID;
    }

    /**
     * @notice Kiểm tra người gọi có phải Oracle HOẶC Owner không.
     *
     * @dev Hàm private chỉ được gọi nội bộ bởi updateTokenStatus.
     *      Cho phép cả Oracle và Owner đều có quyền cập nhật trạng thái SBT,
     *      nhưng không cho Oracle can thiệp vào pause/unpause.
     */
    function _checkOracleOrOwner() private view {
        if (!(hasRole(ORACLE_ROLE, msg.sender) || msg.sender == owner())) {
            revert AccessControlUnauthorizedAccount(msg.sender, ORACLE_ROLE);
        }
    }

    /**
     * @notice Override _update để enforce soulbound restriction.
     *
     * @dev Cơ chế khóa transfer:
     *      ERC-721 cho phép transfer bất kỳ lúc nào qua _update.
     *      Override hàm này để block mọi transfer SAU KHI mint thành công.
     *      Chi cho phép mint (from == address(0)) — đây là lần đầu token được tạo.
     *      Mọi trường hợp khác (transfer, safeTransferFrom, transferFrom) đều bị revert.
     *
     * @dev Token đã Frozen/Revoked/Burned vẫn không thể transfer vì check ở đây.
     *      Hàm locked() trả về false cho các trạng thái này nhưng transfer
     *      vẫn bị block ở cấp này — đảm bảo soulbound enforcement không phụ thuộc
     *      vào trạng thái tokenStatus.
     *
     * @param to Địa chỉ nhận token.
     * @param tokenId ID của token.
     * @param auth Tham số auth của ERC-721.
     * @return Địa chỉ owner cũ của token.
     */
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override returns (address) {
        address from = _ownerOf(tokenId);
        // Chỉ cho phép mint (from == address(0)), block mọi transfer khác
        if (from != address(0)) {
            revert TokenLocked();
        }
        return super._update(to, tokenId, auth);
    }
}
