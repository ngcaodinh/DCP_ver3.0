// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title AuditorStaking
 * @author DCP Engineering Team
 * @notice Quản lý cọc, thời gian chờ rút, phạt và quỹ thưởng của Kiểm toán viên.
 * @dev Bất biến kế toán: số dư token của contract luôn lớn hơn hoặc bằng tổng cọc,
 *      tổng tiền đang chờ rút và rewardPool.
 */
contract AuditorStaking is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Hash vai trò được phép phạt cọc và chi thưởng cho Kiểm toán viên.
    bytes32 private constant _SLASHER_ROLE = keccak256("SLASHER_ROLE");

    /// @dev Khoảng thời gian bắt buộc phải chờ trước khi rút cọc.
    uint256 private constant _UNBONDING_PERIOD_SECONDS = 7 days;

    /// @dev Giới hạn mỗi đại lượng được pack trong uint128, lớn hơn rất nhiều quy mô DCT thực tế.
    uint256 private constant _MAX_PACKED_AMOUNT = type(uint128).max;

    /**
     * @notice Trạng thái cọc của một Kiểm toán viên.
     * @dev stakedAmount và pendingAmount dùng chung một slot; releaseAt nằm ở slot kế tiếp.
     */
    struct StakeAccount {
        uint128 stakedAmount;
        uint128 pendingAmount;
        uint64 releaseAt;
    }

    /**
     * @notice Trạng thái kế toán toàn cục của contract.
     * @dev Hai giá trị uint128 được ép nằm chung một slot, độc lập layout của base contracts.
     */
    struct GlobalAccounting {
        uint128 minimumStakeThreshold;
        uint128 rewardPool;
    }

    /// @notice Token DCT được dùng cho toàn bộ nghiệp vụ cọc và thưởng.
    IERC20 public immutable stakeToken;

    /// @dev Struct buộc ngưỡng cọc và quỹ thưởng dùng chung đúng một storage slot.
    GlobalAccounting private _globalAccounting;

    /// @dev Gom toàn bộ trạng thái theo ví vào một mapping để chỉ tính một storage base slot.
    mapping(address staker => StakeAccount account) private _stakeAccounts;

    /// @dev Mỗi reasonCode chỉ được phép tạo đúng một thay đổi giá trị on-chain.
    mapping(bytes32 reasonCodeHash => bool isProcessed)
        private _processedReasonCodes;

    /// @notice Địa chỉ đầu vào bằng địa chỉ zero hoặc không phải contract token.
    error InvalidAddress();

    /// @notice Số lượng đầu vào bằng zero.
    error InvalidAmount();

    /// @notice Số lượng vượt quá giới hạn uint128 của storage đã pack.
    error AmountExceedsStorageLimit();

    /// @notice Số dư cọc không đủ cho yêu cầu.
    error InsufficientStakedBalance();

    /// @notice Tài khoản không có khoản rút nào đang chờ.
    error NoPendingWithdrawal();

    /// @notice Khoản rút chưa hết thời gian unbonding.
    error UnbondingNotReady();

    /// @notice Quỹ thưởng không đủ để chi số tiền yêu cầu.
    error InsufficientRewardPool();

    /// @notice Mã lý do bắt buộc nhưng đang để trống.
    error EmptyReasonCode();

    /// @notice Mã lý do đã được xử lý trước đó.
    error AlreadyProcessedReasonCode();

    /// @notice Ghi nhận token cọc đã được nhận thành công.
    event Staked(address indexed staker, uint256 amount, uint256 newBalance);

    /// @notice Ghi nhận số cọc chuyển sang trạng thái chờ rút.
    event UnstakeRequested(address indexed staker, uint256 amount);

    /// @notice Ghi nhận token chờ rút đã được trả thành công.
    event Withdrawn(address indexed staker, uint256 amount);

    /// @notice Ghi nhận cọc bị phạt và mã nghiệp vụ đối soát.
    event Slashed(address indexed staker, uint256 amount, string reasonCode);

    /// @notice Ghi nhận token bảo chứng được nạp vào quỹ thưởng.
    event RewardPoolFunded(address indexed funder, uint256 amount);

    /// @notice Ghi nhận thưởng đã trả và mã nghiệp vụ đối soát.
    event Rewarded(address indexed auditor, uint256 amount, string reasonCode);

    /// @notice Ghi nhận thay đổi ngưỡng cọc tối thiểu.
    event MinimumStakeThresholdUpdated(
        uint256 previousThreshold,
        uint256 indexed newThreshold
    );

    /**
     * @notice Khởi tạo contract, cấu hình token cọc, admin, ngưỡng cọc và tài khoản có quyền phạt.
     * @dev Pin compiler 0.8.28 và từ chối địa chỉ token không có bytecode để ngăn cấu hình sai.
     */
    constructor(
        address stakeTokenAddress,
        address adminAddress,
        uint256 initialThreshold,
        address slasherAddress
    ) {
        if (stakeTokenAddress == address(0)) revert InvalidAddress();
        if (stakeTokenAddress.code.length == 0) revert InvalidAddress();
        if (adminAddress == address(0)) revert InvalidAddress();
        if (slasherAddress == address(0)) revert InvalidAddress();
        if (initialThreshold == 0) revert InvalidAmount();

        stakeToken = IERC20(stakeTokenAddress);
        _globalAccounting.minimumStakeThreshold = _toPackedAmount(
            initialThreshold
        );

        _grantRole(DEFAULT_ADMIN_ROLE, adminAddress);
        _grantRole(_SLASHER_ROLE, slasherAddress);
    }

    /**
     * @notice Đọc mã vai trò được phép phạt cọc và chi thưởng.
     * @dev Getter thủ công giữ nguyên ABI trong khi constant nội bộ không sinh getter tự động.
     */
    function slasherRole() external pure returns (bytes32) {
        return _SLASHER_ROLE;
    }

    /**
     * @notice Đọc khoảng thời gian unbonding bắt buộc.
     * @dev Getter thủ công giữ nguyên ABI trong khi constant nội bộ không sinh getter tự động.
     */
    function unbondingPeriodSeconds() external pure returns (uint256) {
        return _UNBONDING_PERIOD_SECONDS;
    }

    /**
     * @notice Đọc ngưỡng cọc tối thiểu hiện tại.
     * @dev Getter thủ công giữ nguyên ABI uint256 dù storage được pack bằng uint128.
     */
    function minimumStakeThreshold() external view returns (uint256) {
        return _globalAccounting.minimumStakeThreshold;
    }

    /**
     * @notice Đọc số token hiện có trong quỹ thưởng.
     * @dev Getter thủ công giữ nguyên ABI uint256 dù storage được pack bằng uint128.
     */
    function rewardPool() external view returns (uint256) {
        return _globalAccounting.rewardPool;
    }

    /**
     * @notice Đọc số dư cọc đang hoạt động của một ví.
     * @dev Trả uint256 để giữ nguyên ABI của public mapping trước khi tối ưu storage.
     */
    function stakedBalance(address staker) external view returns (uint256) {
        return _stakeAccounts[staker].stakedAmount;
    }

    /**
     * @notice Đọc số token đang chờ rút của một ví.
     * @dev Trả uint256 để giữ nguyên ABI của public mapping trước khi tối ưu storage.
     */
    function pendingWithdrawAmount(
        address staker
    ) external view returns (uint256) {
        return _stakeAccounts[staker].pendingAmount;
    }

    /**
     * @notice Đọc thời điểm một ví được phép rút token.
     * @dev releaseAt là deadline nghiệp vụ, không phải bản sao block.timestamp trong event.
     */
    function unbondingReleaseAt(
        address staker
    ) external view returns (uint256) {
        return _stakeAccounts[staker].releaseAt;
    }

    /**
     * @notice Nhận thêm token cọc từ người gọi và cộng dồn vào số dư cọc của họ.
     * @dev Cập nhật state trước external call theo CEI; mọi thay đổi tự rollback nếu transfer thất bại.
     */
    function stake(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert InvalidAmount();

        address staker = msg.sender;
        StakeAccount storage account = _stakeAccounts[staker];
        uint256 newBalance = uint256(account.stakedAmount) + amount;
        account.stakedAmount = _toPackedAmount(newBalance);
        stakeToken.safeTransferFrom(staker, address(this), amount);

        emit Staked(staker, amount, newBalance);
    }

    /**
     * @notice Chuyển một phần cọc sang trạng thái chờ rút trong bảy ngày.
     * @dev Hai amount được pack cùng slot; deadline bảy ngày chấp nhận sai số timestamp cấp block.
     */
    function requestUnstake(
        uint256 amount
    ) external nonReentrant whenNotPaused {
        if (amount == 0) revert InvalidAmount();

        address staker = msg.sender;
        StakeAccount storage account = _stakeAccounts[staker];
        uint256 currentBalance = account.stakedAmount;
        if (amount > currentBalance) revert InsufficientStakedBalance();

        uint128 newPendingAmount = _toPackedAmount(
            uint256(account.pendingAmount) + amount
        );
        uint64 releaseAt = uint64(block.timestamp + _UNBONDING_PERIOD_SECONDS);

        // Phép trừ an toàn vì amount đã được kiểm tra không vượt quá số dư hiện tại.
        unchecked {
            account.stakedAmount = uint128(currentBalance - amount);
        }
        account.pendingAmount = newPendingAmount;
        account.releaseAt = releaseAt;

        emit UnstakeRequested(staker, amount);
    }

    /**
     * @notice Trả toàn bộ token đang chờ rút sau khi thời gian unbonding kết thúc.
     * @dev Không dùng whenNotPaused để pause không thể giam token đã hết hạn chờ của người dùng.
     */
    function withdraw() external nonReentrant {
        address staker = msg.sender;
        StakeAccount storage account = _stakeAccounts[staker];
        uint256 amount = account.pendingAmount;
        if (amount == 0) revert NoPendingWithdrawal();
        if (block.timestamp < account.releaseAt) revert UnbondingNotReady();

        delete account.pendingAmount;
        delete account.releaseAt;
        stakeToken.safeTransfer(staker, amount);

        emit Withdrawn(staker, amount);
    }

    /**
     * @notice Phạt cọc của Kiểm toán viên và giữ số token bị phạt trong quỹ thưởng.
     * @dev nonReentrant đứng đầu; không dùng whenNotPaused để phạt vẫn chạy khi tạm dừng cọc mới.
     */
    function slash(
        address staker,
        uint256 amount,
        string calldata reasonCode
    ) external nonReentrant onlyRole(_SLASHER_ROLE) {
        if (staker == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();

        StakeAccount storage account = _stakeAccounts[staker];
        uint256 currentBalance = account.stakedAmount;
        if (amount > currentBalance) revert InsufficientStakedBalance();

        uint128 newRewardPool = _toPackedAmount(
            uint256(_globalAccounting.rewardPool) + amount
        );
        _consumeReasonCode(reasonCode);

        // Phép trừ an toàn vì amount đã được kiểm tra không vượt quá số dư hiện tại.
        unchecked {
            account.stakedAmount = uint128(currentBalance - amount);
        }
        _globalAccounting.rewardPool = newRewardPool;

        emit Slashed(staker, amount, reasonCode);
    }

    /**
     * @notice Nạp token đã được bảo chứng vào quỹ thưởng thực địa.
     * @dev Chỉ admin được nạp; state rollback nguyên tử nếu SafeERC20 transfer thất bại.
     */
    function fundRewardPool(
        uint256 amount
    ) external nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) {
        if (amount == 0) revert InvalidAmount();

        _globalAccounting.rewardPool = _toPackedAmount(
            uint256(_globalAccounting.rewardPool) + amount
        );
        stakeToken.safeTransferFrom(msg.sender, address(this), amount);

        emit RewardPoolFunded(msg.sender, amount);
    }

    /**
     * @notice Chi thưởng từ rewardPool cho Kiểm toán viên có kết luận đúng.
     * @dev Cache rewardPool để chỉ đọc storage một lần và khóa reasonCode trước external call.
     */
    function payReward(
        address auditor,
        uint256 amount,
        string calldata reasonCode
    ) external nonReentrant onlyRole(_SLASHER_ROLE) {
        if (auditor == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();

        uint256 currentRewardPool = _globalAccounting.rewardPool;
        if (amount > currentRewardPool) revert InsufficientRewardPool();
        _consumeReasonCode(reasonCode);

        // Phép trừ an toàn vì amount đã được kiểm tra không vượt quá quỹ thưởng.
        unchecked {
            _globalAccounting.rewardPool = uint128(currentRewardPool - amount);
        }
        stakeToken.safeTransfer(auditor, amount);

        emit Rewarded(auditor, amount, reasonCode);
    }

    /**
     * @notice Cập nhật ngưỡng cọc tối thiểu dùng để xét quyền Kiểm toán viên.
     * @dev Bỏ qua lần ghi lại cùng giá trị để tránh SSTORE và event không mang thay đổi trạng thái.
     */
    function setMinimumStakeThreshold(
        uint256 newThreshold
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newThreshold == 0) revert InvalidAmount();

        uint128 packedThreshold = _toPackedAmount(newThreshold);
        uint256 previousThreshold = _globalAccounting.minimumStakeThreshold;
        if (newThreshold == previousThreshold) return;

        _globalAccounting.minimumStakeThreshold = packedThreshold;

        emit MinimumStakeThresholdUpdated(previousThreshold, newThreshold);
    }

    /**
     * @notice Tạm dừng việc nạp cọc và tạo yêu cầu rút cọc mới khi có sự cố.
     * @dev OpenZeppelin Pausable tự phát event Paused; không phát event trùng lặp.
     */
    function pauseContract() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /**
     * @notice Mở lại việc nạp cọc và tạo yêu cầu rút cọc sau khi xử lý sự cố.
     * @dev OpenZeppelin Pausable tự phát event Unpaused; không phát event trùng lặp.
     */
    function unpauseContract() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /**
     * @notice Xác thực và đánh dấu reasonCode đã xử lý để chặn phạt hoặc trả thưởng trùng khi retry.
     * @dev Storage write zero-to-one là bắt buộc để bảo đảm idempotency on-chain.
     */
    function _consumeReasonCode(string calldata reasonCode) internal {
        if (bytes(reasonCode).length == 0) revert EmptyReasonCode();

        bytes32 reasonCodeHash = keccak256(bytes(reasonCode));
        if (_processedReasonCodes[reasonCodeHash])
            revert AlreadyProcessedReasonCode();

        _processedReasonCodes[reasonCodeHash] = true;
    }

    /**
     * @notice Kiểm tra một amount có thể lưu an toàn trong storage uint128 đã pack.
     * @dev Revert trước khi ép kiểu để không thể xảy ra silent truncation.
     */
    function _toPackedAmount(uint256 amount) internal pure returns (uint128) {
        if (amount > _MAX_PACKED_AMOUNT) revert AmountExceedsStorageLimit();

        return uint128(amount);
    }
}
