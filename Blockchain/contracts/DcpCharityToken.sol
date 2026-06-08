// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title DcpCharityToken
 * @notice Token nội bộ của DCP cho nghiệp vụ nạp tiền, quyên góp và giải ngân.
 */
contract DcpCharityToken is ERC20, AccessControl, Pausable {
    bytes32 public constant minterRole = keccak256("MINTER_ROLE");
    bytes32 public constant disbursementRole = keccak256("DISBURSEMENT_ROLE");
    uint256 public constant minimumMintAmount = 10_000;

    mapping(bytes32 => bool) public isProcessedOrderCode;
    mapping(bytes32 => bool) public isProcessedDisbursementCode;

    error InvalidAddress();
    error InvalidAmount();
    error AmountBelowMinimumMint();
    error EmptyReferenceCode();
    error AlreadyProcessedReferenceCode();
    error SelfRevokeAdminForbidden();

    event MintedByBackend(address indexed receiver, uint256 amount, string orderCode);
    event BurnedForDisbursement(address indexed sourceAccount, uint256 amount, string requestCode);
    event RolePermissionUpdated(bytes32 indexed role, address indexed account, bool isGranted);

    /** @notice Khởi tạo token và thiết lập admin ban đầu. */
    constructor(address adminAddress) ERC20("DCP Charity Token", "DCT") {
        if (adminAddress == address(0)) revert InvalidAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, adminAddress);
    }

    /** @notice Trả về 0 decimals để giữ quy ước 1 token = 1 VND ở giai đoạn POC. */
    function decimals() public pure override returns (uint8) {
        return 0;
    }

    /** @notice Cấp quyền mint cho tài khoản backend đã xác thực. */
    function grantMinterRole(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert InvalidAddress();
        _grantRole(minterRole, account);
        emit RolePermissionUpdated(minterRole, account, true);
    }

    /** @notice Thu hồi quyền mint từ tài khoản backend. */
    function revokeMinterRole(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert InvalidAddress();
        _revokeRole(minterRole, account);
        emit RolePermissionUpdated(minterRole, account, false);
    }

    /** @notice Cấp quyền burn phục vụ luồng giải ngân. */
    function grantDisbursementRole(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert InvalidAddress();
        _grantRole(disbursementRole, account);
        emit RolePermissionUpdated(disbursementRole, account, true);
    }

    /** @notice Thu hồi quyền burn phục vụ luồng giải ngân. */
    function revokeDisbursementRole(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert InvalidAddress();
        _revokeRole(disbursementRole, account);
        emit RolePermissionUpdated(disbursementRole, account, false);
    }

    /** @notice Thu hồi admin role, chặn tự thu hồi để tránh lock quản trị hệ thống. */
    function revokeAdminRole(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert InvalidAddress();
        if (account == msg.sender) revert SelfRevokeAdminForbidden();
        _revokeRole(DEFAULT_ADMIN_ROLE, account);
        emit RolePermissionUpdated(DEFAULT_ADMIN_ROLE, account, false);
    }

    /** @notice Mint token sau khi backend xác thực webhook thanh toán hợp lệ và chưa xử lý trước đó. */
    function mintFromBackend(address receiver, uint256 amount, string calldata orderCode)
        external
        onlyRole(minterRole)
        whenNotPaused
    {
        if (receiver == address(0)) revert InvalidAddress();
        if (amount < minimumMintAmount) revert AmountBelowMinimumMint();
        if (bytes(orderCode).length == 0) revert EmptyReferenceCode();

        bytes32 orderCodeHash = keccak256(bytes(orderCode));
        if (isProcessedOrderCode[orderCodeHash]) revert AlreadyProcessedReferenceCode();

        // Đánh dấu idempotency trước khi mint để chặn retry ngoài ý muốn xử lý trùng order.
        isProcessedOrderCode[orderCodeHash] = true;
        _mint(receiver, amount);
        emit MintedByBackend(receiver, amount, orderCode);
    }

    /** @notice Burn token khi giải ngân thành công và chặn xử lý trùng request giải ngân. */
    function burnForDisbursement(address sourceAccount, uint256 amount, string calldata requestCode)
        external
        onlyRole(disbursementRole)
        whenNotPaused
    {
        if (sourceAccount == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (bytes(requestCode).length == 0) revert EmptyReferenceCode();

        bytes32 requestCodeHash = keccak256(bytes(requestCode));
        if (isProcessedDisbursementCode[requestCodeHash]) revert AlreadyProcessedReferenceCode();

        // Đánh dấu trước khi burn theo fail-safe default để khóa request trùng trong mọi nhánh retry.
        isProcessedDisbursementCode[requestCodeHash] = true;
        _burn(sourceAccount, amount);
        emit BurnedForDisbursement(sourceAccount, amount, requestCode);
    }

    /** @notice Tạm dừng token khi có sự cố bảo mật hoặc vận hành. */
    function pauseContract() external onlyRole(DEFAULT_ADMIN_ROLE) { _pause(); }

    /** @notice Mở lại token sau khi đã xử lý xong sự cố. */
    function unpauseContract() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }
}

