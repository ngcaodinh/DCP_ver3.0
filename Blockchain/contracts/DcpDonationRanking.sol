// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {DcpCharityToken} from "./DcpCharityToken.sol";

/**
 * @title DcpDonationRanking
 * @notice Hợp đồng quản lý dự án và ghi nhận donation on-chain cho DCP.
 */
contract DcpDonationRanking is AccessControl, Pausable, ReentrancyGuard {
    bytes32 public constant projectManagerRole =
        keccak256("PROJECT_MANAGER_ROLE");

    enum ProjectStatus {
        Draft,
        Active,
        Completed,
        Closed
    }

    struct ProjectSnapshot {
        bool exists;
        ProjectStatus projectStatus;
        uint256 totalDonationAmount;
        uint256 donorCount;
        uint256 donationTransactionCount;
    }

    DcpCharityToken public immutable charityToken;
    mapping(uint256 => ProjectSnapshot) private projectById;
    mapping(uint256 => mapping(address => bool)) private donorByProject;

    error InvalidAddress();
    error InvalidProjectId();
    error InvalidAmount();
    error ProjectNotFound();
    error InvalidProjectState();
    error InvalidProjectStateTransition();
    error TransferFromFailed();

    event ProjectCreated(
        uint256 indexed projectId,
        ProjectStatus projectStatus
    );
    event ProjectStatusUpdated(
        uint256 indexed projectId,
        ProjectStatus previousStatus,
        ProjectStatus newStatus
    );
    event DonationReceived(
        address indexed donor,
        uint256 indexed projectId,
        uint256 amount,
        uint256 timestamp,
        bool isAnonymous
    );
    event RolePermissionUpdated(
        bytes32 indexed role,
        address indexed account,
        bool isGranted
    );

    /** @notice Khởi tạo hợp đồng và gán quyền admin ban đầu. */
    constructor(address tokenAddress, address adminAddress) {
        if (tokenAddress == address(0) || adminAddress == address(0))
            revert InvalidAddress();
        charityToken = DcpCharityToken(tokenAddress);
        _grantRole(DEFAULT_ADMIN_ROLE, adminAddress);
    }

    /** @notice Cấp quyền quản lý dự án cho tài khoản vận hành. */
    function grantProjectManagerRole(
        address account
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert InvalidAddress();
        _grantRole(projectManagerRole, account);
        emit RolePermissionUpdated(projectManagerRole, account, true);
    }

    /** @notice Thu hồi quyền quản lý dự án từ tài khoản vận hành. */
    function revokeProjectManagerRole(
        address account
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert InvalidAddress();
        _revokeRole(projectManagerRole, account);
        emit RolePermissionUpdated(projectManagerRole, account, false);
    }

    /** @notice Tạo mới dự án ở trạng thái Draft để bắt đầu vòng đời nghiệp vụ. */
    function createProject(
        uint256 projectId
    ) external onlyRole(projectManagerRole) whenNotPaused {
        if (projectId == 0) revert InvalidProjectId();
        if (projectById[projectId].exists) revert InvalidProjectState();

        projectById[projectId].exists = true;
        projectById[projectId].projectStatus = ProjectStatus.Draft;
        emit ProjectCreated(projectId, ProjectStatus.Draft);
    }

    /** @notice Cập nhật trạng thái dự án theo luồng cho phép để tránh nhảy trạng thái tùy ý. */
    function setProjectStatus(
        uint256 projectId,
        ProjectStatus newStatus
    ) external onlyRole(projectManagerRole) whenNotPaused {
        if (projectId == 0) revert InvalidProjectId();
        ProjectSnapshot storage projectSnapshot = projectById[projectId];
        if (!projectSnapshot.exists) revert ProjectNotFound();

        ProjectStatus previousStatus = projectSnapshot.projectStatus;
        if (!_isValidStateTransition(previousStatus, newStatus))
            revert InvalidProjectStateTransition();

        projectSnapshot.projectStatus = newStatus;
        emit ProjectStatusUpdated(projectId, previousStatus, newStatus);
    }

    /** @notice Quyên góp token vào dự án active và ghi nhận đầy đủ dữ liệu cho FE/Indexer. */
    function donate(
        uint256 projectId,
        uint256 amount,
        bool isAnonymous
    ) external nonReentrant whenNotPaused {
        if (projectId == 0) revert InvalidProjectId();
        if (amount == 0) revert InvalidAmount();

        ProjectSnapshot storage projectSnapshot = projectById[projectId];
        if (!projectSnapshot.exists) revert ProjectNotFound();
        if (projectSnapshot.projectStatus != ProjectStatus.Active)
            revert InvalidProjectState();

        // Gọi transferFrom trước khi cập nhật state để đảm bảo chỉ ghi nhận khi nhận token thành công.
        bool isTransferSuccess = charityToken.transferFrom(
            msg.sender,
            address(this),
            amount
        );
        if (!isTransferSuccess) revert TransferFromFailed();

        projectSnapshot.totalDonationAmount += amount;
        projectSnapshot.donationTransactionCount += 1;

        // Tăng donorCount duy nhất theo từng project để phục vụ thống kê QF off-chain chính xác.
        if (!donorByProject[projectId][msg.sender]) {
            donorByProject[projectId][msg.sender] = true;
            projectSnapshot.donorCount += 1;
        }

        emit DonationReceived(
            msg.sender,
            projectId,
            amount,
            block.timestamp,
            isAnonymous
        );
    }

    /** @notice Kiểm tra một donor đã từng donate vào project hay chưa. */
    function hasDonatedToProject(
        uint256 projectId,
        address donorAddress
    ) external view returns (bool) {
        if (projectId == 0) revert InvalidProjectId();
        if (donorAddress == address(0)) revert InvalidAddress();
        return donorByProject[projectId][donorAddress];
    }

    /** @notice Trả snapshot trạng thái/tổng donate/số donor/số giao dịch donation của dự án. */
    function getProjectSnapshot(
        uint256 projectId
    ) external view returns (ProjectSnapshot memory) {
        if (projectId == 0) revert InvalidProjectId();
        if (!projectById[projectId].exists) revert ProjectNotFound();
        return projectById[projectId];
    }

    /** @notice Tạm dừng hợp đồng khi phát hiện rủi ro bảo mật hoặc vận hành. */
    function pauseContract() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /** @notice Mở lại hợp đồng sau khi đã xử lý xong sự cố. */
    function unpauseContract() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /** @notice Kiểm tra chuyển trạng thái dự án có hợp lệ theo vòng đời nghiệp vụ hay không. */
    function _isValidStateTransition(
        ProjectStatus previousStatus,
        ProjectStatus newStatus
    ) internal pure returns (bool) {
        if (previousStatus == newStatus) {
            return true;
        }

        // Luồng chuẩn: Draft -> Active -> Completed, và Active/Completed có thể đóng dự án về Closed.
        if (
            previousStatus == ProjectStatus.Draft &&
            newStatus == ProjectStatus.Active
        ) {
            return true;
        }
        if (
            previousStatus == ProjectStatus.Active &&
            newStatus == ProjectStatus.Completed
        ) {
            return true;
        }
        if (
            (previousStatus == ProjectStatus.Active ||
                previousStatus == ProjectStatus.Completed) &&
            newStatus == ProjectStatus.Closed
        ) {
            return true;
        }

        return false;
    }
}
