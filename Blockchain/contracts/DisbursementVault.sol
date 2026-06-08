// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title DisbursementVault
 * @notice Kho tiền trung gian giữ token từ DcpDonationRanking trước khi burn.
 *         Chỉ MultisigDisbursement được phép điều khiển vault này.
 *         Mỗi requestId tạo một khe tiền riêng biệt để ngăn replay attack.
 */
contract DisbursementVault is AccessControl, Pausable {

    // ============ ROLES ============
    /// @notice Vai trò duy nhất được phép gọi burnFromVault và withdrawToVault.
    bytes32 public constant DISBURSEMENT_CONTROLLER_ROLE =
        keccak256("DISBURSEMENT_CONTROLLER_ROLE");

    // ============ ERRORS ============
    error InvalidAmount();
    error InvalidRequestId();
    error AlreadyProcessed();
    error InsufficientVaultBalance();

    // ============ STATE ============
    /// @notice Track request nào da duoc xu ly roi de chan replay.
    mapping(bytes32 => bool) public processedRequests;

    /// @notice So du token dang chua trong vault cho tung request.
    mapping(bytes32 => uint256) public pendingVaultBalance;

    // ============ EVENTS ============
    event TokensDepositedForRequest(
        bytes32 indexed requestHash,
        uint256 indexed requestId,
        uint256 amount,
        address depositedBy
    );
    event TokensBurnedForDisbursement(
        bytes32 indexed requestHash,
        uint256 indexed requestId,
        uint256 amount,
        address controller,
        uint256 burnedAt
    );

    /**
     * @notice Khoi tao vault, chi grant DISBURSEMENT_CONTROLLER_ROLE cho MultisigDisbursement.
     * @param disbursementController Dia chi MultisigDisbursement duoc phep dieu khien vault.
     */
    constructor(address disbursementController) {
        if (disbursementController == address(0)) revert InvalidAmount();
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(DISBURSEMENT_CONTROLLER_ROLE, disbursementController);
    }

    /**
     * @notice Nhan token tu MultisigDisbursement de giu tam trong vault.
     *         Su dung requestId lam dinh danh de tranh replay.
     * @param requestId Ma yeu cau giai ngan.
     * @param amount So token can giu.
     */
    function depositForRequest(uint256 requestId, uint256 amount)
        external
        onlyRole(DISBURSEMENT_CONTROLLER_ROLE)
        whenNotPaused
    {
        if (amount == 0) revert InvalidAmount();
        if (requestId == 0) revert InvalidRequestId();

        bytes32 requestHash = keccak256(abi.encode("DISBURSE-VAULT-DEPOSIT", requestId));
        if (processedRequests[requestHash]) revert AlreadyProcessed();

        pendingVaultBalance[requestHash] = amount;
        emit TokensDepositedForRequest(requestHash, requestId, amount, msg.sender);
    }

    /**
     * @notice Burn token tu vault sau khi giao dich PayOS thanh cong.
     *         Chi goi duoc mot lan cho moi requestId.
     * @param requestId Ma yeu cau giai ngan.
     * @param token Dia chi token (DcpCharityToken).
     * @return burnedAmount So token da burn.
     */
    function burnFromVault(uint256 requestId, address token)
        external
        onlyRole(DISBURSEMENT_CONTROLLER_ROLE)
        whenNotPaused
        returns (uint256 burnedAmount)
    {
        if (requestId == 0) revert InvalidRequestId();

        bytes32 requestHash = keccak256(abi.encode("DISBURSE-VAULT-BURN", requestId));
        if (processedRequests[requestHash]) revert AlreadyProcessed();

        uint256 amountToBurn = pendingVaultBalance[requestHash];
        if (amountToBurn == 0) revert InsufficientVaultBalance();

        // Danh dau da xu ly truoc khi burn (fail-safe default).
        processedRequests[requestHash] = true;
        pendingVaultBalance[requestHash] = 0;

        // Burn token tu chinh vault (vault chinh la tai khoan chua token).
        bool success = ERC20(token).transfer(address(0x000000000000000000000000000000000000dEaD), amountToBurn);
        if (!success) revert InsufficientVaultBalance();

        emit TokensBurnedForDisbursement(requestHash, requestId, amountToBurn, msg.sender, block.timestamp);
        return amountToBurn;
    }

    /**
     * @notice Lay so du kha dung cua mot request trong vault.
     * @param requestId Ma yeu cau giai ngan.
     * @return amount So duong con lai chua burn.
     */
    function getVaultBalanceForRequest(uint256 requestId) external view returns (uint256 amount) {
        if (requestId == 0) return 0;
        bytes32 requestHash = keccak256(abi.encode("DISBURSE-VAULT-DEPOSIT", requestId));
        return pendingVaultBalance[requestHash];
    }

    /**
     * @notice Kiem tra xem request da duoc xu ly chua.
     * @param requestId Ma yeu cau giai ngan.
     * @return processed True neu da xu ly roi.
     */
    function isRequestProcessed(uint256 requestId) external view returns (bool processed) {
        bytes32 requestHash = keccak256(abi.encode("DISBURSE-VAULT-BURN", requestId));
        return processedRequests[requestHash];
    }

    /** @notice Tam dung vault khi co su co bao mat. */
    function pauseVault() external onlyRole(DEFAULT_ADMIN_ROLE) { _pause(); }

    /** @notice Mo lai vault sau khi xu ly xong su co. */
    function unpauseVault() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    /** @notice Nhan ETH (khong can dung). */
    receive() external payable {
        revert("ETH not accepted");
    }
}
